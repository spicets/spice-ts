import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import WebSocket from 'ws';

const temporaryDirectories: string[] = [];

function chromeCandidates(): string[] {
  return [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function findChrome(): Promise<string | null> {
  for (const candidate of chromeCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next well-known headless browser path.
    }
  }
  return null;
}

function contentType(pathname: string): string {
  if (extname(pathname) === '.js') return 'text/javascript';
  if (extname(pathname) === '.html') return 'text/html';
  return 'application/octet-stream';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function pageDebuggerUrl(
  profileDirectory: string,
  child: ChildProcess,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  let stderr = '';
  let lastError: unknown = 'No page target returned';
  let spawnError: Error | undefined;
  let pageUrl: string | undefined;
  let nextProbe = 0;
  const pending = new Set<Promise<void>>();
  const abort = new AbortController();
  const onError = (error: Error) => { spawnError = error; };
  const onStderr = (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4_096); };
  child.on('error', onError);
  child.stderr?.on('data', onStderr);
  try {
    while (performance.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited before DevTools became ready (code ${child.exitCode ?? child.signalCode})\n${stderr}`);
      }
      if (pageUrl) return pageUrl;
      if (performance.now() >= nextProbe) {
        try {
          // Chrome may announce the browser socket before writing its port file.
          const announcement = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1];
          const port = announcement
            ? new URL(announcement).port
            : (await readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
          // Hedge a stalled request without cancelling slow responses. All probes
          // share the overall startup deadline and are cancelled on completion.
          const probe = fetch(`http://127.0.0.1:${port}/json/list`, { signal: abort.signal })
            .then(response => response.json() as Promise<Array<{ type: string; webSocketDebuggerUrl: string }>>)
            .then(targets => { pageUrl ??= targets.find(target => target.type === 'page')?.webSocketDebuggerUrl; })
            .catch(error => { lastError = error; })
            .finally(() => { pending.delete(probe); });
          pending.add(probe);
          nextProbe = performance.now() + 1_500;
        } catch (error) {
          lastError = error;
        }
      }
      await Promise.race([...pending, delay(Math.max(0, Math.min(50, deadline - performance.now())))]);
      // A completed empty response can be retried immediately.
      if (pending.size === 0) nextProbe = 0;
    }
    throw new Error(`Chrome DevTools endpoint did not become ready within ${timeoutMs}ms: ${String(lastError)}\n${stderr}`);
  } finally {
    abort.abort();
    child.off('error', onError);
    child.stderr?.off('data', onStderr);
  }
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(2_000)]);
  }
}

async function waitForBrowserResult(debuggerUrl: string, pageUrl: string): Promise<string> {
  const socket = new WebSocket(debuggerUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });

  let nextId = 1;
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
  }>();
  socket.on('message', data => {
    const message = JSON.parse(data.toString()) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  const send = (method: string, params: object = {}) => {
    const id = nextId++;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: pageUrl });
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          status: document.querySelector('#result')?.dataset.status ?? 'pending',
          text: document.querySelector('#result')?.textContent ?? '',
        })`,
        returnByValue: true,
      }) as { result?: { value?: string } };
      const value = response.result?.value;
      if (value) {
        const result = JSON.parse(value) as { status: string; text: string };
        if (result.status === 'passed') return result.text;
        if (result.status === 'failed') throw new Error(result.text);
      }
      await delay(50);
    }
    throw new Error('worker promise never settled');
  } finally {
    socket.close();
  }
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.map(directory => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

describe('production browser step worker', () => {
  it('reports an exited browser instead of waiting for a missing DevTools file', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'spice-ts-exited-browser-'));
    temporaryDirectories.push(profileDirectory);
    const child = spawn(process.execPath, ['-e', 'process.exit(23)'], { stdio: 'ignore' });
    try {
      await expect(pageDebuggerUrl(profileDirectory, child, 500))
        .rejects.toThrow('Chrome exited before DevTools became ready (code 23)');
    } finally {
      await terminateProcess(child);
    }
  }, 5_000);

  it('discovers the stderr endpoint when Chrome has not written its port file', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'spice-ts-stderr-browser-'));
    temporaryDirectories.push(profileDirectory);
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://example.test/stderr-page' }]));
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');
    const child = spawn(process.execPath, ['-e', `setTimeout(() => console.error('DevTools listening on ws://127.0.0.1:${address.port}/devtools/browser/test'), 50); setInterval(() => {}, 1000)`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      await expect(pageDebuggerUrl(profileDirectory, child, 2_000))
        .resolves.toBe('ws://example.test/stderr-page');
    } finally {
      await terminateProcess(child);
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('recovers when an initial DevTools request hangs but a later request responds', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'spice-ts-stalled-browser-'));
    temporaryDirectories.push(profileDirectory);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      if (requests === 1) return;
      response.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://example.test/page' }]));
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test server address');
      await writeFile(join(profileDirectory, 'DevToolsActivePort'), `${address.port}\n`);
      await expect(pageDebuggerUrl(profileDirectory, child, 2_500)).resolves.toBe('ws://example.test/page');
      expect(requests).toBeGreaterThan(1);
    } finally {
      await terminateProcess(child);
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('reports browser exit even while a DevTools response is stalled', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'spice-ts-exiting-browser-'));
    temporaryDirectories.push(profileDirectory);
    const server = createServer(() => {});
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(23), 300)'], { stdio: 'ignore' });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test server address');
      await writeFile(join(profileDirectory, 'DevToolsActivePort'), `${address.port}\n`);
      await expect(pageDebuggerUrl(profileDirectory, child, 2_500))
        .rejects.toThrow('Chrome exited before DevTools became ready (code 23)');
    } finally {
      await terminateProcess(child);
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it.each(['delayed page', 'slow response', 'hung endpoint'] as const)('handles a %s during startup', async mode => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'spice-ts-starting-browser-'));
    temporaryDirectories.push(profileDirectory);
    let requests = 0;
    const server = createServer(async (_request, response) => {
      requests++;
      if (mode === 'hung endpoint' || (mode === 'slow response' && requests > 1)) return;
      if (mode === 'slow response') await delay(1_800);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(mode === 'delayed page' && requests === 1 ? [] : [
        { type: 'page', webSocketDebuggerUrl: 'ws://example.test/page' },
      ]));
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test server address');
      await writeFile(join(profileDirectory, 'DevToolsActivePort'), `${address.port}\n`);
      const result = pageDebuggerUrl(profileDirectory, child, mode === 'hung endpoint' ? 150 : 2_500);
      if (mode !== 'hung endpoint') {
        await expect(result).resolves.toBe('ws://example.test/page');
        expect(requests).toBeGreaterThanOrEqual(2);
      } else {
        await expect(result).rejects.toThrow('Chrome DevTools endpoint did not become ready within 150ms');
        expect(requests).toBeGreaterThan(0);
      }
    } finally {
      await terminateProcess(child);
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('executes a Vite production build in real headless Chrome', async () => {
    const chrome = await findChrome();
    expect(chrome, 'Chrome/Chromium is required for the production worker smoke').not.toBeNull();

    const root = await realpath(await mkdtemp(
      join(process.env.TMPDIR ?? tmpdir(), 'spice-ts-browser-worker-'),
    ));
    temporaryDirectories.push(root);
    const outDir = join(root, 'dist');
    const profileDirectory = join(root, 'chrome-profile');
    const packageRoot = resolve(import.meta.dirname, '../..');
    const coreEntry = relative(root, join(packageRoot, 'src/index.ts')).replaceAll('\\', '/');
    const importPath = coreEntry.startsWith('.') ? coreEntry : `./${coreEntry}`;

    await writeFile(join(root, 'index.html'), '<main id="result">pending</main><script type="module" src="/main.js"></script>');
    await writeFile(join(root, 'eecircuit-stub.js'), 'export class Simulation {}');
    await writeFile(join(root, 'main.js'), `
      import { simulate } from ${JSON.stringify(importPath)};
      const netlist = [
        'V1 1 0 DC 10',
        'R1 1 2 1k',
        'R2 2 0 1k',
        '.op',
        '.step param R2 list 1k 2k 3k 4k',
      ].join('\\n');
      const resultElement = document.querySelector('#result');
      try {
        const sequential = await simulate(netlist);
        const parallel = await simulate(netlist, { stepWorkers: { maxWorkers: 2 } });
        const expected = sequential.steps.map(step => step.dc.voltage('2'));
        const actual = parallel.steps.map(step => step.dc.voltage('2'));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error('parallel browser results differ from sequential results');
        }
        resultElement.dataset.status = 'passed';
        resultElement.textContent = 'browser-step-worker-passed';
      } catch (error) {
        resultElement.dataset.status = 'failed';
        resultElement.textContent = error instanceof Error ? error.message : String(error);
      }
    `);

    await build({
      root,
      logLevel: 'silent',
      resolve: {
        alias: { 'eecircuit-engine': join(root, 'eecircuit-stub.js') },
      },
      build: { outDir, emptyOutDir: true },
    });

    const server = createServer(async (request, response) => {
      const pathname = request.url === '/' ? 'index.html' : (request.url ?? '').replace(/^\//, '');
      const filePath = join(outDir, pathname);
      try {
        const contents = await readFile(filePath);
        response.writeHead(200, { 'content-type': contentType(filePath) });
        response.end(contents);
      } catch {
        response.writeHead(404);
        response.end('not found');
      }
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });

    const chromeProcess = spawn(chrome!, [
      '--headless',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-gpu',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-sandbox',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Smoke server has no TCP address');
      const debuggerUrl = await pageDebuggerUrl(profileDirectory, chromeProcess);
      const result = await waitForBrowserResult(
        debuggerUrl,
        `http://127.0.0.1:${address.port}/`,
      );
      expect(result).toBe('browser-step-worker-passed');
    } finally {
      await terminateProcess(chromeProcess);
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }, 45_000);
});
