import assert from 'node:assert/strict';
import { createToolExecutor } from '@spice-ts/mcp';
import { sha256CanonicalJson } from '@spice-ts/core/protocol';

const callOrder = [];
const executor = createToolExecutor();
const execute = async (name, argumentsValue) => {
  callOrder.push(name);
  return executor(name, argumentsValue);
};

const capabilities = structured(await execute('spice_capabilities', {}));
assert.equal(callOrder[0], 'spice_capabilities', 'capabilities must be called first');
assert.deepEqual(capabilities, {
  protocolVersion: '1',
  analyses: ['op', 'dc', 'tran', 'ac'],
  inputFormats: ['spice', 'spice-ts', 'circuit-json'],
  sensitivity: { tool: 'spice_sensitivity', analyses: ['dc', 'ac'] },
  tf: { tool: 'spice_tf', analyses: ['tf'] },
  impedance: { tool: 'spice_impedance', analyses: ['ac'] },
  parameterOverrides: {
    tools: ['spice_simulate', 'spice_simulation_start'],
    input: 'params',
    valueType: 'Record<string, number> (finite numbers)',
    scope: 'top-level .param in spice source only',
    caseSensitive: false,
    unknownParameterCode: 'UNKNOWN_PARAMETER',
  },
  tools: ['spice_sparams', 'spice_impedance', 'spice_tf', 'spice_sensitivity', 'spice_capabilities', 'spice_validate', 'spice_convert', 'spice_simulate', 'spice_monte_carlo', 'spice_optimize', 'spice_sweep', 'spice_corners', 'spice_ac_metrics', 'spice_power_metrics', 'spice_tran_metrics', 'spice_fourier', 'spice_disto_metrics', 'spice_pz_metrics', 'spice_noise_metrics', 'spice_measure', 'spice_dc_metrics', 'spice_op_report', 'spice_compare', 'spice_simulation_start', 'spice_simulation_read', 'spice_simulation_cancel'],
  limits: {
    maxDocumentBytes: 262144,
    maxAnalyses: 8,
    maxResultPoints: 100000,
    maxSerializedResultBytes: 4194304,
    maxWallTimeMs: 10000,
  },
  streaming: {
    defaultChunkPoints: 256,
    maxChunkPoints: 1024,
    maxRetainedJobs: 16,
    maxConcurrentJobs: 2,
    runningJobTtlMs: 30000,
    terminalJobTtlMs: 300000,
    maxUnreadEvents: 256,
    maxUnreadBytes: 1048576,
  },
});

const rejectedRequest = {
  apiVersion: '1',
  input: {
    format: 'spice',
    source: 'V1 in 0 1\nR1 in 0 1k\n.op\n.op\n.op\n.tran 1u 0u',
  },
  options: {
    backend: 'spice-ts-js',
    determinism: 'strict',
    limits: {
      maxSourceBytes: 16384,
      maxAnalyses: 4,
      maxResultPoints: 3,
      maxSerializedResultBytes: 131072,
      maxWallTimeMs: 5000,
    },
  },
};

const rejected = await execute('spice_simulation_start', { request: rejectedRequest });
assert.equal(rejected.isError, true, 'the valid request must be rejected only by its point ceiling');
const rejection = structured(rejected);
assert.deepEqual(Object.keys(rejection), ['error']);
assert.deepEqual(Object.keys(rejection.error), ['code', 'message', 'retryable', 'phase', 'details']);
assert.deepEqual(Object.keys(rejection.error.details), ['limit', 'maximum', 'actual']);
assert.deepEqual(rejection.error, {
  code: 'RESOURCE_LIMIT',
  message: 'A configured resource limit was exceeded',
  retryable: false,
  phase: 'validation',
  details: { limit: 'maxResultPoints', maximum: 3, actual: 4 },
});

const correctedRequest = structuredClone(rejectedRequest);
correctedRequest.options.limits.maxResultPoints = rejection.error.details.actual;
assert.deepEqual(changedPaths(rejectedRequest, correctedRequest), ['/options/limits/maxResultPoints']);

const first = await complete(correctedRequest);
const second = await complete(correctedRequest);
assert.deepEqual(second.stableTerminal, first.stableTerminal, 'second run stable terminal drifted');
assert.equal(second.stableTerminalSha256, first.stableTerminalSha256, 'second run stable hash drifted');

const terminal = first.terminal;
assert.deepEqual(Object.keys(terminal), ['apiVersion', 'ok', 'requestId', 'data', 'diagnostics', 'metadata']);
assert.deepEqual(terminal.diagnostics, [], 'successful diagnostics must retain exact order');
assert.deepEqual(
  {
    protocolVersion: terminal.metadata.protocolVersion,
    spiceTsVersion: terminal.metadata.spiceTsVersion,
    engineBuildId: terminal.metadata.engineBuildId,
    backend: terminal.metadata.backend,
    backendVersion: terminal.metadata.backendVersion,
    resolvedBackend: terminal.metadata.resolvedOptions.backend,
    determinism: terminal.metadata.determinism,
    runtimeFamily: terminal.metadata.runtime.family,
  },
  {
    protocolVersion: '1',
    spiceTsVersion: '0.3.0',
    engineBuildId: 'mcp-node-v1',
    backend: 'spice-ts-js',
    backendVersion: '0.3.0',
    resolvedBackend: 'spice-ts-js',
    determinism: 'strict',
    runtimeFamily: 'node',
  },
);
const inputSha256 = sha256CanonicalJson(correctedRequest.input);
const resultSha256 = sha256CanonicalJson(terminal.data);
assert.equal(resultPointCount(terminal.data), 4);
assert.equal(terminal.metadata.inputSha256, inputSha256);
assert.equal(terminal.metadata.resultSha256, resultSha256);

const report = {
  workflow: 'point-ceiling-recovery',
  callOrder: [
    'spice_capabilities',
    'spice_simulation_start:rejected',
    'spice_simulation_start/read:first',
    'spice_simulation_start/read:second',
  ],
  capabilities,
  rejection: rejection.error,
  correction: {
    changedPaths: changedPaths(rejectedRequest, correctedRequest),
    maxResultPoints: correctedRequest.options.limits.maxResultPoints,
  },
  success: {
    diagnostics: terminal.diagnostics,
    metadata: {
      protocolVersion: terminal.metadata.protocolVersion,
      spiceTsVersion: terminal.metadata.spiceTsVersion,
      engineBuildId: terminal.metadata.engineBuildId,
      backend: terminal.metadata.backend,
      backendVersion: terminal.metadata.backendVersion,
      resolvedBackend: terminal.metadata.resolvedOptions.backend,
      determinism: terminal.metadata.determinism,
      runtimeFamily: terminal.metadata.runtime.family,
    },
    inputSha256,
    resultSha256,
    stableTerminalSha256: first.stableTerminalSha256,
    resultPointCount: resultPointCount(terminal.data),
    sameCursorReplay: first.replayCount > 0,
    deterministicSecondRun: true,
  },
  stableTerminal: first.stableTerminal,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function complete(request) {
  const started = structured(await execute('spice_simulation_start', { request }));
  assert.deepEqual(Object.keys(started), ['jobId', 'status', 'cursor']);
  assert.equal(started.status, 'running');

  let cursor = started.cursor;
  let replayCount = 0;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const response = await readWhenReady(started.jobId, cursor);
    const replay = structured(await execute('spice_simulation_read', {
      jobId: started.jobId, cursor, maxPoints: 4,
    }));
    assert.deepEqual(replay, response, 'the same cursor must replay the exact chunk');
    replayCount++;
    if (response.status === 'complete') {
      assert.equal(response.nextCursor, null);
      assert.equal(response.terminal.ok, true);
      const stableTerminal = stableTerminalSnapshot(response.terminal);
      return {
        terminal: response.terminal,
        replayCount,
        stableTerminal,
        stableTerminalSha256: sha256CanonicalJson(stableTerminal),
      };
    }
    assert.equal(response.status, 'running', JSON.stringify(response));
    assert.equal(typeof response.nextCursor, 'string');
    cursor = response.nextCursor;
  }
  throw new Error('Simulation did not complete');
}

async function readWhenReady(jobId, cursor) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const response = structured(await execute('spice_simulation_read', {
      jobId, cursor, maxPoints: 4,
    }));
    if (response.status !== 'running' || response.events.length > 0) return response;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Simulation did not produce a stream chunk');
}

function stableTerminalSnapshot(value) {
  const snapshot = structuredClone(value);
  delete snapshot.requestId;
  delete snapshot.metadata.architecture;
  delete snapshot.metadata.runtime.version;
  for (const key of ['timing', 'timings', 'timestamp', 'timestamps', 'path', 'paths']) {
    delete snapshot.metadata[key];
  }
  return snapshot;
}

function resultPointCount(result) {
  return result.analyses.reduce((total, analysis) => {
    if (analysis.type === 'op') return total + 1;
    if (analysis.type === 'dc') return total + analysis.axis.values.length;
    if (analysis.type === 'tran') return total + analysis.timeS.length;
    return total + analysis.frequencyHz.length;
  }, 0);
}

function changedPaths(before, after, path = '') {
  if (Object.is(before, after)) return [];
  if (!isRecord(before) || !isRecord(after)) return [path || '/'];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap(key => changedPaths(before[key], after[key], `${path}/${escapePointer(key)}`));
}

function escapePointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function structured(response) {
  const value = response.structuredContent;
  assert.ok(isRecord(value), 'tool response must include structured object content');
  assert.deepEqual(response.content, [{ type: 'text', text: JSON.stringify(value) }]);
  return value;
}
