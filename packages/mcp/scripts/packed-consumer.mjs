import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspaceRoot = resolve(packageRoot, '../..');
const consumerRoot = mkdtempSync(join(tmpdir(), 'spice-ts-mcp-consumer-'));
const packsRoot = join(consumerRoot, 'packs');
const expectedWorkflow = fileURLToPath(new URL('../examples/agent-output.json', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} exited with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function tarballFor(packageName) {
  const normalized = packageName.replace('@', '').replace('/', '-');
  const name = readdirSync(packsRoot).find((entry) => entry.startsWith(`${normalized}-`) && entry.endsWith('.tgz'));
  if (!name) throw new Error(`Missing packed tarball for ${packageName}`);
  return join(packsRoot, name);
}

try {
  mkdirSync(packsRoot);
  for (const packageName of ['core', 'circuit-json', 'mcp']) {
    run('pnpm', ['pack', '--pack-destination', packsRoot], resolve(workspaceRoot, 'packages', packageName));
  }

  const coreTarball = tarballFor('@spice-ts/core');

  const circuitJsonTarball = tarballFor('@spice-ts/circuit-json');
  const mcpTarball = tarballFor('@spice-ts/mcp');
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    private: true,
    pnpm: {
      overrides: {
        '@spice-ts/core': `file:${coreTarball}`,

        '@spice-ts/circuit-json': `file:${circuitJsonTarball}`,
      },
    },
  }, null, 2)}\n`);
  writeFileSync(join(consumerRoot, 'consumer.cjs'), String.raw`
const { EventEmitter } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const requireFromMcp = require('node:module').createRequire(require.resolve('@spice-ts/mcp'));
const { sha256CanonicalJson } = requireFromMcp('@spice-ts/core/protocol');
const {
  createMcpServer, createToolExecutor, DEFAULT_MCP_STREAM_LIMITS, executeTool,
} = require('@spice-ts/mcp');

class ManualClock {
  constructor() {
    this.time = 0;
    this.nextTimerId = 1;
    this.timers = new Map();
  }

  now() { return this.time; }

  setTimeout(callback, delayMs) {
    const id = this.nextTimerId++;
    this.timers.set(id, { deadline: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(id) { this.timers.delete(id); }

  advanceBy(milliseconds) {
    this.time += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.deadline <= this.time) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function containsExactString(value, target) {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((entry) => containsExactString(entry, target));
  if (value && typeof value === 'object') {
    return Object.values(value).some((entry) => containsExactString(entry, target));
  }
  return false;
}

// A real job runs in a freshly spawned worker thread that must load the packed
// core bundle before it emits anything, so readiness depends on host load. The
// server itself guarantees a running job leaves 'running' within
// runningJobTtlMs (it then fails with RESOURCE_LIMIT), so poll on wall-clock
// time up to that contract plus a grace period instead of a fixed attempt
// count, and report what was observed if the contract is ever broken.
const READY_DEADLINE_MS = DEFAULT_MCP_STREAM_LIMITS.runningJobTtlMs + 5000;

async function readWhenReady(jobId, cursor, maxPoints) {
  const startedAt = Date.now();
  let attempts = 0;
  let last;
  for (let delayMs = 1; ; delayMs = Math.min(delayMs * 2, 50)) {
    attempts++;
    last = await executeTool('spice_simulation_read', { jobId, cursor, maxPoints });
    if (last.structuredContent.status !== 'running'
      || last.structuredContent.events.length > 0) return last;
    if (Date.now() - startedAt >= READY_DEADLINE_MS) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('Packed simulation job did not produce events: ' + JSON.stringify({
    jobId, attempts, elapsedMs: Date.now() - startedAt, deadlineMs: READY_DEADLINE_MS,
    lastStatus: last.structuredContent.status, isError: last.isError === true,
  }));
}

(async () => {
  const result = await executeTool('spice_simulate', {
    request: {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.op' },
    },
  });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  if (result.structuredContent.analyses[0].voltagesV.in !== 1) {
    throw new Error('Unexpected operating-point result: ' + JSON.stringify(result.structuredContent));
  }

  const retentionClock = new ManualClock();
  const retentionExecute = createToolExecutor({
    clock: retentionClock,
    streamLimits: { runningJobTtlMs: 100, terminalJobTtlMs: 10 },
    simulate: async () => ({
      status: 'complete',
      analyses: [{
        type: 'op', analysisIndex: 0,
        voltagesV: { in: 1 }, currentsA: { V1: -0.001 },
      }],
    }),
  });
  const retentionStart = await retentionExecute('spice_simulation_start', {
    request: {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.op' },
    },
  });
  await flushMicrotasks();
  const retentionJob = retentionStart.structuredContent;
  const retained = await retentionExecute('spice_simulation_read', retentionJob);
  retentionClock.advanceBy(9);
  const retainedReplay = await retentionExecute('spice_simulation_read', {
    ...retentionJob, maxPoints: 1,
  });
  const malformedCursor = await retentionExecute('spice_simulation_read', {
    jobId: retentionJob.jobId, cursor: 'not-a-cursor',
  });
  if (JSON.stringify(retained) !== JSON.stringify(retainedReplay)
    || malformedCursor.structuredContent.error.code !== 'INVALID_REQUEST') {
    throw new Error('Packed cursor replay or validation changed');
  }
  retentionClock.advanceBy(1);
  const expired = await retentionExecute('spice_simulation_cancel', { jobId: retentionJob.jobId });
  if (expired.structuredContent.error.code !== 'INVALID_REQUEST') {
    throw new Error('Packed terminal retention did not expire');
  }

  class StreamingWorker extends EventEmitter {
    constructor() {
      super();
      this.terminateCount = 0;
      this.acknowledgements = 0;
    }

    postMessage(message) {
      if (!message || message.operation !== 'stream') {
        this.acknowledgements++;
        return;
      }
      queueMicrotask(() => this.emit('message', {
        type: 'events',
        events: [
          { type: 'analysis-start', analysis: 'tran', analysisIndex: 0 },
          {
            type: 'point', analysisIndex: 0, pointIndex: 0,
            point: { type: 'tran', timeS: 0, voltagesV: { out: 0 }, currentsA: {} },
          },
        ],
      }));
    }

    terminate() { this.terminateCount++; return 0; }
  }

  const unreadWorker = new StreamingWorker();
  const unreadExecute = createToolExecutor({
    streamLimits: { maxUnreadEvents: 1, maxUnreadBytes: 1024 },
    workerFactory: () => unreadWorker,
  });
  const unreadStart = await unreadExecute('spice_simulation_start', {
    request: {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 3u' },
    },
  });
  await flushMicrotasks();
  const unreadFailure = await unreadExecute('spice_simulation_read', unreadStart.structuredContent);
  if (unreadFailure.structuredContent.status !== 'failed'
    || unreadFailure.structuredContent.terminal.error.details.limit !== 'maxUnreadEvents'
    || unreadFailure.structuredContent.events.length !== 0) {
    throw new Error('Packed unread-event ceiling was not atomic');
  }

  const blockedWorker = new StreamingWorker();
  const blockedExecute = createToolExecutor({
    streamLimits: { maxUnreadEvents: 2, maxUnreadBytes: 1024 },
    workerFactory: () => blockedWorker,
  });
  const blockedStart = await blockedExecute('spice_simulation_start', {
    request: {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 3u' },
    },
  });
  await flushMicrotasks();
  const blockedCancellation = await blockedExecute('spice_simulation_cancel', {
    jobId: blockedStart.structuredContent.jobId,
  });
  await flushMicrotasks();
  if (blockedCancellation.structuredContent.status !== 'cancelled'
    || blockedCancellation.structuredContent.terminal.partial.analyses.length !== 0
    || blockedWorker.acknowledgements !== 0
    || blockedWorker.terminateCount !== 1) {
    throw new Error('Packed cancellation under backpressure changed');
  }

  class DeadWorker extends EventEmitter {
    postMessage() { queueMicrotask(() => this.emit('exit', 1)); }
    terminate() { return 1; }
  }
  const deathClock = new ManualClock();
  const deathExecute = createToolExecutor({
    clock: deathClock,
    streamLimits: { runningJobTtlMs: 100, terminalJobTtlMs: 10 },
    workerFactory: () => new DeadWorker(),
  });
  const deathStart = await deathExecute('spice_simulation_start', {
    request: {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.op' },
    },
  });
  await flushMicrotasks();
  const deathFailure = await deathExecute('spice_simulation_read', deathStart.structuredContent);
  deathClock.advanceBy(10);
  const deathCleanup = await deathExecute('spice_simulation_cancel', {
    jobId: deathStart.structuredContent.jobId,
  });
  if (deathFailure.structuredContent.terminal.error.code !== 'INTERNAL_ERROR'
    || deathCleanup.structuredContent.error.code !== 'INVALID_REQUEST') {
    throw new Error('Packed worker-death cleanup changed');
  }

  class FinalBatchWorker extends EventEmitter {
    constructor() {
      super();
      this.terminateCount = 0;
    }

    postMessage(message) {
      if (!message || message.operation !== 'stream') return;
      this.emit('message', {
        type: 'events',
        events: [
          { type: 'analysis-start', analysis: 'tran', analysisIndex: 0 },
          {
            type: 'point', analysisIndex: 0, pointIndex: 0,
            point: { type: 'tran', timeS: 0, voltagesV: { out: 0 }, currentsA: {} },
          },
          {
            type: 'point', analysisIndex: 0, pointIndex: 1,
            point: { type: 'tran', timeS: 1e-6, voltagesV: { out: 0.5 }, currentsA: {} },
          },
        ],
      });
      this.emit('exit', 7);
      this.emit('exit', 7);
    }

    terminate() { this.terminateCount++; return 1; }
  }

  const officialWorker = new FinalBatchWorker();
  const officialServer = createMcpServer({ workerFactory: () => officialWorker });
  const officialClient = new Client({ name: 'packed-worker-death-consumer', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await officialServer.connect(serverTransport);
  await officialClient.connect(clientTransport);
  const officialStart = await officialClient.callTool({
    name: 'spice_simulation_start',
    arguments: {
      request: {
        apiVersion: '1',
        input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1u' },
      },
    },
  });
  await flushMicrotasks();
  const officialJob = officialStart.structuredContent;
  const officialFirst = await officialClient.callTool({
    name: 'spice_simulation_read',
    arguments: { ...officialJob, maxPoints: 1 },
  });
  const officialTerminal = await officialClient.callTool({
    name: 'spice_simulation_read',
    arguments: { jobId: officialJob.jobId, cursor: officialFirst.structuredContent.nextCursor, maxPoints: 1 },
  });
  const officialReplay = await officialClient.callTool({
    name: 'spice_simulation_read',
    arguments: { jobId: officialJob.jobId, cursor: officialFirst.structuredContent.nextCursor, maxPoints: 99 },
  });
  const officialPoints = [
    ...officialFirst.structuredContent.events,
    ...officialTerminal.structuredContent.events,
  ].filter((event) => event.type === 'point');
  if (officialFirst.structuredContent.status !== 'running'
    || officialTerminal.structuredContent.status !== 'failed'
    || officialTerminal.structuredContent.terminal.error.code !== 'INTERNAL_ERROR'
    || officialTerminal.structuredContent.terminal.partial.analyses[0].emittedPointCount !== 2
    || officialTerminal.structuredContent.terminal.partial.partialEventSha256
      !== sha256CanonicalJson(officialPoints)
    || JSON.stringify(officialTerminal) !== JSON.stringify(officialReplay)
    || officialWorker.terminateCount !== 0
    || containsExactString(officialTerminal, 'spice-ts')) {
    throw new Error('Official packed client worker-death recovery changed');
  }
  await officialClient.close();
  await officialServer.close();

  const completedStart = await executeTool('spice_simulation_start', {
    request: {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.op' },
    },
  });
  const completed = await readWhenReady(
    completedStart.structuredContent.jobId,
    completedStart.structuredContent.cursor,
    1,
  );
  if (completed.structuredContent.status !== 'complete'
    || completed.structuredContent.events[0].type !== 'analysis-start'
    || completed.structuredContent.events[1].type !== 'analysis-end') {
    throw new Error('Unexpected completed stream: ' + JSON.stringify(completed.structuredContent));
  }

  const transientRequest = {
    apiVersion: '1',
    input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 3u' },
  };

  const liveStart = await executeTool('spice_simulation_start', {
    request: {
      apiVersion: '1',
      input: {
        format: 'spice',
        source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 20m',
      },
    },
  });
  const liveCancelled = await executeTool('spice_simulation_cancel', {
    jobId: liveStart.structuredContent.jobId,
  });
  if (liveCancelled.structuredContent.status !== 'cancelled'
    || liveCancelled.structuredContent.terminal.partial.analyses.length !== 0) {
    throw new Error('Live packed worker was not cancelled: ' + JSON.stringify(liveCancelled.structuredContent));
  }

  const cancelledStart = await executeTool('spice_simulation_start', { request: transientRequest });
  const first = await readWhenReady(
    cancelledStart.structuredContent.jobId,
    cancelledStart.structuredContent.cursor,
    2,
  );
  const replay = await executeTool('spice_simulation_read', {
    jobId: cancelledStart.structuredContent.jobId,
    cursor: cancelledStart.structuredContent.cursor,
    maxPoints: 8,
  });
  if (JSON.stringify(first) !== JSON.stringify(replay)) throw new Error('Cursor replay changed its chunk');
  const cancelled = await executeTool('spice_simulation_cancel', {
    jobId: cancelledStart.structuredContent.jobId,
  });
  if (cancelled.structuredContent.status !== 'cancelled'
    || cancelled.structuredContent.terminal.partial.analyses[0].emittedPointCount !== 2
    || 'resultSha256' in (cancelled.structuredContent.terminal.metadata || {})) {
    throw new Error('Unexpected cancellation terminal: ' + JSON.stringify(cancelled.structuredContent));
  }

  const bounded = await executeTool('spice_simulation_read', {
    jobId: cancelledStart.structuredContent.jobId,
    cursor: first.structuredContent.nextCursor,
    maxPoints: 1025,
  });
  const malformed = await executeTool('spice_simulation_read', { jobId: 'missing' });
  if (bounded.structuredContent.error.code !== 'RESOURCE_LIMIT'
    || bounded.structuredContent.error.details.limit !== 'maxStreamChunkPoints'
    || malformed.structuredContent.error.code !== 'INVALID_REQUEST') {
    throw new Error('Stream bounds or malformed request were not structured');
  }
  if (containsExactString([completed, liveCancelled, first, cancelled, bounded, malformed], 'spice-ts')) {
    throw new Error('Internal backend name leaked from the packed stream tools');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`);

  run('pnpm', [
    'add', '--ignore-workspace', '--prefer-offline', '--save-exact',
    mcpTarball, '@modelcontextprotocol/sdk@1.32.1',
  ], consumerRoot);
  if (existsSync(join(consumerRoot, 'node_modules', '@spice-ts', 'core'))) {
    throw new Error('Packed consumer unexpectedly hoisted @spice-ts/core to its root node_modules');
  }
  run('node', ['consumer.cjs'], consumerRoot);

  const packagedExample = join(consumerRoot, 'node_modules', '@spice-ts', 'mcp', 'examples', 'agent.mjs');
  if (!existsSync(packagedExample)) throw new Error('Packed MCP workflow example is missing');
  const actual = run('node', [packagedExample], consumerRoot);
  const expected = readFileSync(expectedWorkflow, 'utf8');
  if (actual !== expected) {
    throw new Error(`Packed stdio workflow output drifted.\nExpected:\n${expected}\nActual:\n${actual}`);
  }
  console.log('Packed MCP consumer and bounded stdio workflow passed.');
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}
