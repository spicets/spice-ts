import assert from 'node:assert/strict';
import { createToolExecutor } from '@spice-ts/mcp';
import { sha256CanonicalJson } from '@spice-ts/core/protocol';

/**
 * @typedef {{
 *   code: 'RESOURCE_LIMIT',
 *   message: string,
 *   retryable: false,
 *   phase: 'validation',
 *   details: { limit: 'maxAnalyses', maximum: number, actual: number }
 * }} AnalysisLimitError
 */

/**
 * @typedef {{
 *   stableTerminal: Record<string, unknown>,
 *   stableTerminalSha256: string,
 *   pointEvents: Record<string, unknown>[],
 *   firstChunkPointCount: number,
 *   sameCursorReplay: true,
 *   resumedFromNextCursor: true
 * }} CompletedRun
 */

const toolNames = [
  'spice_sparams',
  'spice_impedance',
  'spice_tf',
  'spice_sensitivity',
  'spice_capabilities',
  'spice_validate',
  'spice_convert',
  'spice_simulate',
  'spice_monte_carlo',
  'spice_optimize',
  'spice_sweep',
  'spice_corners',
  'spice_ac_metrics',
  'spice_power_metrics',
  'spice_tran_metrics',
  'spice_fourier',
  'spice_disto_metrics',
  'spice_pz_metrics',
  'spice_noise_metrics',
  'spice_measure',
  'spice_dc_metrics',
  'spice_op_report',
  'spice_compare',
  'spice_simulation_start',
  'spice_simulation_read',
  'spice_simulation_cancel',
];
const executeTool = createToolExecutor();
const calls = [];
let startedJobs = 0;
const execute = async (name, argumentsValue) => {
  calls.push(name);
  if (name === 'spice_simulation_start') startedJobs++;
  return executeTool(name, argumentsValue);
};

const capabilities = structured(await execute('spice_capabilities', {}));
assert.equal(calls[0], 'spice_capabilities', 'capabilities must be discovered first');
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
  tools: toolNames,
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

const limitedRequest = {
  apiVersion: '1',
  input: {
    format: 'spice',
    source: [
      'V1 in 0 DC 0 AC 1',
      'R1 in out 1k',
      'C1 out 0 1u',
      '.tran 1u 2u',
      '.ac lin 2 10 100',
    ].join('\n'),
  },
  options: {
    backend: 'spice-ts-js',
    determinism: 'strict',
    limits: {
      maxSourceBytes: 16384,
      maxAnalyses: 1,
      maxResultPoints: 128,
      maxSerializedResultBytes: 131072,
      maxWallTimeMs: 5000,
    },
  },
};

const rejectedResponse = await execute('spice_validate', { request: limitedRequest });
const failure = publicAnalysisLimit(rejectedResponse);
assert.equal(startedJobs, 0, 'validation failure must not start a simulation job');

const correctedRequest = structuredClone(limitedRequest);
correctedRequest.options.limits.maxAnalyses = failure.details.actual;
const repairPaths = changedPaths(limitedRequest, correctedRequest);
assert.deepEqual(repairPaths, ['/options/limits/maxAnalyses']);

const validation = structured(await execute('spice_validate', { request: correctedRequest }));
assert.deepEqual(validation, { status: 'valid', nodeCount: 2, branchCount: 1, analysisCount: 2 });
assert.equal(startedJobs, 0, 'corrected validation must finish before simulation starts');

const first = await complete(correctedRequest);
const second = await complete(correctedRequest);
assert.deepEqual(second.stableTerminal, first.stableTerminal, 'second-run terminal drifted');
assert.equal(second.stableTerminalSha256, first.stableTerminalSha256, 'second-run terminal hash drifted');

const terminal = first.stableTerminal;
assert.deepEqual(terminal.diagnostics, []);
assert.deepEqual(terminal.data.analyses.map(analysis => analysis.type), ['tran', 'ac']);
assert.deepEqual(terminal.data.analyses.map(analysis => analysis.analysisIndex), [0, 1]);
const inputSha256 = sha256CanonicalJson(correctedRequest.input);
const resultSha256 = sha256CanonicalJson(terminal.data);
assert.equal(terminal.metadata.inputSha256, inputSha256);
assert.equal(terminal.metadata.resultSha256, resultSha256);
assert.deepEqual({
  protocolVersion: terminal.metadata.protocolVersion,
  spiceTsVersion: terminal.metadata.spiceTsVersion,
  engineBuildId: terminal.metadata.engineBuildId,
  backend: terminal.metadata.backend,
  backendVersion: terminal.metadata.backendVersion,
  resolvedBackend: terminal.metadata.resolvedOptions.backend,
  determinism: terminal.metadata.determinism,
  runtimeFamily: terminal.metadata.runtime.family,
}, {
  protocolVersion: '1',
  spiceTsVersion: '0.3.0',
  engineBuildId: 'mcp-node-v1',
  backend: 'spice-ts-js',
  backendVersion: '0.3.0',
  resolvedBackend: 'spice-ts-js',
  determinism: 'strict',
  runtimeFamily: 'node',
});

const pointEvents = first.pointEvents;
const pointIndexesByAnalysis = terminal.data.analyses.map((analysis, analysisIndex) => {
  const indexes = pointEvents
    .filter(event => event.analysisIndex === analysisIndex)
    .map(event => event.pointIndex);
  const pointCount = analysis.type === 'tran' ? analysis.timeS.length : analysis.frequencyHz.length;
  assert.deepEqual(indexes, Array.from({ length: pointCount }, (_value, index) => index));
  return indexes;
});
const pointCountsByAnalysis = pointIndexesByAnalysis.map(indexes => indexes.length);

const report = {
  workflow: 'issue-348-multi-analysis-recovery',
  callOrder: [
    'spice_capabilities',
    'spice_validate:limited',
    'spice_validate:corrected',
    'spice_simulation_start/read:first',
    'spice_simulation_start/read:second',
  ],
  tools: toolNames,
  capabilities,
  failure,
  repair: {
    changedPaths: repairPaths,
    previousMaxAnalyses: limitedRequest.options.limits.maxAnalyses,
    correctedMaxAnalyses: correctedRequest.options.limits.maxAnalyses,
  },
  validation,
  resume: {
    firstChunkPointCount: first.firstChunkPointCount,
    sameCursorReplay: first.sameCursorReplay,
    resumedFromNextCursor: first.resumedFromNextCursor,
    analysisOrder: ['tran', 'ac'],
    pointCountsByAnalysis,
    pointEventSha256: sha256CanonicalJson(pointEvents),
  },
  terminal: {
    inputSha256,
    resultSha256,
    stableTerminalSha256: first.stableTerminalSha256,
    deterministicSecondRun: true,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

/** @returns {AnalysisLimitError} */
function publicAnalysisLimit(response) {
  assert.equal(response.isError, true, 'limited request must fail validation');
  const value = structured(response);
  assert.deepEqual(Object.keys(value), ['error']);
  assert.deepEqual(Object.keys(value.error), ['code', 'message', 'retryable', 'phase', 'details']);
  assert.deepEqual(Object.keys(value.error.details), ['limit', 'maximum', 'actual']);
  assert.deepEqual(value.error, {
    code: 'RESOURCE_LIMIT',
    message: 'A configured resource limit was exceeded',
    retryable: false,
    phase: 'validation',
    details: { limit: 'maxAnalyses', maximum: 1, actual: 2 },
  });
  return value.error;
}

/** @returns {Promise<CompletedRun>} */
async function complete(request) {
  const started = structured(await execute('spice_simulation_start', { request }));
  assert.deepEqual(Object.keys(started), ['jobId', 'status', 'cursor']);
  assert.equal(started.status, 'running');

  const pointEvents = [];
  let cursor = started.cursor;
  let firstChunkPointCount;
  let resumedFromNextCursor = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const response = await readWhenReady(started.jobId, cursor);
    const replay = structured(await execute('spice_simulation_read', {
      jobId: started.jobId, cursor, maxPoints: 1,
    }));
    assert.deepEqual(replay, response, 'the same cursor must replay the exact chunk');
    const chunkPoints = response.events.filter(event => event.type === 'point');
    pointEvents.push(...chunkPoints);

    if (firstChunkPointCount === undefined) {
      firstChunkPointCount = chunkPoints.length;
      assert.equal(response.status, 'running', 'first checkpoint must precede the terminal');
      assert.equal(typeof response.nextCursor, 'string');
    }

    if (response.status === 'complete') {
      assert.equal(response.nextCursor, null);
      assert.equal(response.terminal.ok, true);
      assert.equal(response.terminal.requestId, started.jobId);
      assert.equal(resumedFromNextCursor, true);
      const stableTerminal = stableTerminalSnapshot(response.terminal);
      return {
        stableTerminal,
        stableTerminalSha256: sha256CanonicalJson(stableTerminal),
        pointEvents,
        firstChunkPointCount,
        sameCursorReplay: true,
        resumedFromNextCursor: true,
      };
    }

    assert.equal(response.status, 'running', JSON.stringify(response));
    assert.equal(typeof response.nextCursor, 'string');
    assert.notEqual(response.nextCursor, cursor);
    cursor = response.nextCursor;
    resumedFromNextCursor = true;
  }
  throw new Error('Simulation did not complete');
}

async function readWhenReady(jobId, cursor) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const response = structured(await execute('spice_simulation_read', {
      jobId, cursor, maxPoints: 1,
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

function changedPaths(before, after, path = '') {
  if (Object.is(before, after)) return [];
  if (!isRecord(before) || !isRecord(after)) return [path || '/'];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap(key => changedPaths(before[key], after[key], `${path}/${escapePointer(key)}`));
}

function escapePointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function structured(response) {
  const value = response.structuredContent;
  assert.ok(isRecord(value), 'tool response must include structured object content');
  assert.deepEqual(response.content, [{ type: 'text', text: JSON.stringify(value) }]);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
