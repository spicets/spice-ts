import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import WebSocket from 'ws';
import negative from '../../core/protocol/fixtures/negative-v1.json';
import positive from '../../core/protocol/fixtures/positive-v1.json';
import { spawnProcessTree, terminateProcessTree } from './test-support/browser-process.js';

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
    try { await access(candidate); return candidate; } catch { /* Try the next candidate. */ }
  }
  return null;
}

function contentType(pathname: string): string {
  if (extname(pathname) === '.js') return 'text/javascript';
  if (extname(pathname) === '.json') return 'application/json';
  if (extname(pathname) === '.html') return 'text/html';
  return 'application/octet-stream';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function pageDebuggerUrl(profileDirectory: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const [port] = (await readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8')).split('\n');
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = targets.find(target => target.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { await delay(50); }
  }
  throw new Error('Chrome DevTools endpoint did not become ready');
}

async function waitForResult(debuggerUrl: string, pageUrl: string): Promise<string> {
  const socket = new WebSocket(debuggerUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });
  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
  socket.on('message', data => {
    const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method: string, params: object = {}): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
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
        expression: `JSON.stringify({ status: document.querySelector('#result')?.dataset.status ?? 'pending', text: document.querySelector('#result')?.textContent ?? '' })`,
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
    throw new Error('browser facade promise never settled');
  } finally { socket.close(); }
}

afterAll(async () => {
  // Chrome's whole process tree is gone by now (terminateProcessTree); the
  // retries only absorb filesystem lag, not live writers.
  await Promise.all(temporaryDirectories.map(directory => rm(directory, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  })));
});

describe('browser protocol-v1 worker facade', () => {
  it('runs the same conformance request in a real headless browser module worker', async () => {
    const chrome = await findChrome();
    expect(chrome, 'Chrome/Chromium is required for the production worker smoke').not.toBeNull();

    const root = await realpath(await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'spice-ts-facade-')));
    temporaryDirectories.push(root);
    const outDir = join(root, 'dist');
    const profileDirectory = join(root, 'chrome-profile');
    const packageRoot = resolve(import.meta.dirname, '..');
    const entry = relative(root, join(packageRoot, 'src/index.ts')).replaceAll('\\', '/');
    const importPath = entry.startsWith('.') ? entry : `./${entry}`;
    const protocolEntry = relative(root, join(packageRoot, '../core/src/protocol/wire/index.ts')).replaceAll('\\', '/');
    const protocolImportPath = protocolEntry.startsWith('.') ? protocolEntry : `./${protocolEntry}`;

    await writeFile(join(root, 'index.html'), '<main id="result">pending</main><script type="module" src="/main.js"></script>');
    await writeFile(join(root, 'main.js'), `
      import { createSpiceEngine } from ${JSON.stringify(importPath)};
      import { checkConformanceV1 } from ${JSON.stringify(protocolImportPath)};
      const output = document.querySelector('#result');
      try {
        const engine = await createSpiceEngine({ backend: 'spice-ts-js', manifestUrl: new URL('/manifest.json', location.href) });
        const requests = ${JSON.stringify(positive.requests)};
        for (const [name, request] of Object.entries(requests)) {
          const validation = await engine.validate(request, { requestId: 'browser-validate-' + name });
          const simulation = await engine.simulate(request, { requestId: 'browser-simulate-' + name });
          if (name === 'circuitJson') {
            if (validation.ok || validation.error.code !== 'INVALID_CIRCUIT') throw new Error(JSON.stringify(validation));
            if (simulation.ok || simulation.error.code !== 'INVALID_CIRCUIT') throw new Error(JSON.stringify(simulation));
            continue;
          }
          if (!validation.ok || !simulation.ok) throw new Error(JSON.stringify({ validation, simulation }));
          const conformance = checkConformanceV1('simulation-result', simulation.data);
          if (conformance.length !== 0) throw new Error(JSON.stringify(conformance));
          if (simulation.metadata.backend !== 'spice-ts-js') throw new Error('wrong backend metadata');
          const analysis = simulation.data.analyses[0];
          if (analysis?.type !== 'op') throw new Error('missing OP result');
          if (analysis.voltagesV.in !== 5 || analysis.currentsA.V1 !== -0.005) throw new Error('wrong OP values');
        }
        const negativeRequests = ${JSON.stringify({
          unsupportedVersion: negative.unsupportedVersion,
          invalidUnion: negative.invalidUnion,
          internalBackend: negative.internalBackend,
        })};
        for (const [name, request] of Object.entries(negativeRequests)) {
          const response = await engine.simulate(request, { requestId: 'browser-negative-' + name });
          if (response.ok || response.error.code !== 'INVALID_REQUEST') throw new Error(JSON.stringify(response));
        }
        if (engine.capabilities.backends.join(',') !== 'spice-ts-js') throw new Error('wrong capabilities');
        await engine.close();

        const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm', manifestUrl: new URL('/manifest.json', location.href) });
        if (wasm.capabilities.backends.join(',') !== 'spice-ts-wasm') throw new Error('wrong WASM capabilities');
        if (wasm.capabilities.numericWasm?.kernel !== 'dense-gaussian-complex-f64-v2') throw new Error('missing WASM kernel metadata');
        const wasmRequest = {
          apiVersion: '1',
          input: { format: 'spice', source: 'V1 in 0 AC 1\\nR1 in out 1k\\nC1 out 0 1u\\n.ac lin 1 100 100' },
        };
        const wasmResult = await wasm.simulate(wasmRequest, { requestId: 'browser-wasm-ac' });
        if (!wasmResult.ok) throw new Error(JSON.stringify(wasmResult));
        if (wasmResult.metadata.backend !== 'spice-ts-wasm') throw new Error('wrong WASM metadata');
        const wasmAc = wasmResult.data.analyses[0];
        const outputPhasor = wasmAc?.type === 'ac' ? wasmAc.voltagePhasors.out?.[0] : undefined;
        if (wasmAc?.type !== 'ac' || !outputPhasor || Math.abs(outputPhasor.magnitude - 0.8467330159648304) > 1e-12
          || Math.abs(outputPhasor.phaseDegrees - -32.141907635342065) > 1e-10) throw new Error('wrong WASM AC result');
        const vccsResult = await wasm.simulate({
          apiVersion: '1',
          input: { format: 'spice', source: 'VCTRL control 0 2\\nG1 out 0 control 0 2m\\nR1 out 0 1k\\n.op' },
        }, { requestId: 'browser-wasm-vccs-op' });
        const vccsOp = vccsResult.ok ? vccsResult.data.analyses[0] : undefined;
        if (!vccsResult.ok || vccsOp?.type !== 'op' || vccsOp.voltagesV.out !== -4) {
          throw new Error('wrong WASM VCCS OP result');
        }
        const cccsResult = await wasm.simulate({
          apiVersion: '1',
          input: { format: 'spice', source: 'VCTRL control 0 2\\nRCTRL control 0 1k\\nF1 out 0 VCTRL 3\\nRLOAD out 0 1k\\n.op' },
        }, { requestId: 'browser-wasm-cccs-op' });
        const cccsOp = cccsResult.ok ? cccsResult.data.analyses[0] : undefined;
        if (!cccsResult.ok || cccsOp?.type !== 'op' || cccsOp.voltagesV.out !== 6) {
          throw new Error('wrong WASM CCCS OP result');
        }
        const vcvsResult = await wasm.simulate({
          apiVersion: '1',
          input: { format: 'spice', source: 'VBIAS bias 0 1\\nVCTRL control 0 3\\nVREF ref 0 -1\\nE1 out ref control bias 2\\nRLOAD out 0 1k\\n.op' },
        }, { requestId: 'browser-wasm-vcvs-op' });
        const vcvsOp = vcvsResult.ok ? vcvsResult.data.analyses[0] : undefined;
        if (!vcvsResult.ok || vcvsResult.metadata.backend !== 'spice-ts-wasm'
          || vcvsOp?.type !== 'op' || vcvsOp.voltagesV.out !== 3
          || Math.abs(vcvsOp.currentsA.E1 - -0.003) > 1e-15) {
          throw new Error('wrong WASM VCVS OP result');
        }
        const ccvsResult = await wasm.simulate({
          apiVersion: '1',
          input: { format: 'spice', source: 'VCTRL control 0 1\\nRCTRL control 0 1k\\nH1 out 0 VCTRL 2k\\nRLOAD out 0 1k\\n.op' },
        }, { requestId: 'browser-wasm-ccvs-op' });
        const ccvsOp = ccvsResult.ok ? ccvsResult.data.analyses[0] : undefined;
        if (!ccvsResult.ok || ccvsResult.metadata.backend !== 'spice-ts-wasm'
          || ccvsOp?.type !== 'op' || ccvsOp.voltagesV.out !== -2
          || Math.abs(ccvsOp.currentsA.H1 - 0.002) > 1e-15) {
          throw new Error('wrong WASM CCVS OP result');
        }
        const wasmDcResult = await wasm.simulate({
          apiVersion: '1',
          input: { format: 'spice', source: 'V1 in 0 0\\nR1 in out 1k\\nR2 out 0 1k\\n.dc V1 0 1 0.5' },
        }, { requestId: 'browser-wasm-dc' });
        const wasmDc = wasmDcResult.ok ? wasmDcResult.data.analyses[0] : undefined;
        if (!wasmDcResult.ok || wasmDc?.type !== 'dc'
          || wasmDc.axis.values.join(',') !== '0,0.5,1'
          || wasmDc.voltagesV.out.join(',') !== '0,0.25,0.5') throw new Error('wrong WASM DC result');
        const unsupported = await wasm.simulate({
          apiVersion: '1',
          input: { format: 'spice', source: 'V1 in 0 1\\nL1 in 0 1u\\n.op' },
        }, { requestId: 'browser-wasm-unsupported' });
        if (unsupported.ok || unsupported.error.code !== 'UNSUPPORTED_FEATURE') throw new Error('WASM fallback was not rejected');
        await wasm.close();
        output.dataset.status = 'passed';
        output.textContent = 'browser-worker-facade-and-wasm-passed';
      } catch (error) {
        output.dataset.status = 'failed';
        output.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
      }
    `);

    await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const assetRoot = join(packageRoot, 'dist');
    const server = createServer(async (request, response) => {
      const pathname = request.url === '/' ? 'index.html' : (request.url ?? '').replace(/^\//, '');
      const primary = join(outDir, pathname);
      const fallback = join(assetRoot, pathname);
      try {
        let contents: Buffer;
        try { contents = await readFile(primary); } catch { contents = await readFile(fallback); }
        response.writeHead(200, { 'content-type': contentType(pathname) });
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

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Smoke server has no TCP address');
      const browser = spawnProcessTree(chrome!, [
        '--headless', '--disable-background-networking', '--disable-gpu', '--no-first-run', '--no-sandbox',
        '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`, 'about:blank',
      ]);
      try {
        const debuggerUrl = await pageDebuggerUrl(profileDirectory);
        const result = await waitForResult(debuggerUrl, `http://127.0.0.1:${address.port}/`);
        expect(result).toBe('browser-worker-facade-and-wasm-passed');
      } finally { await terminateProcessTree(browser); }
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }, 45_000);
});
