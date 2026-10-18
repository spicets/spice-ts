import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fromCircuitJSON } from '@spice-ts/circuit-json';
import { createToolExecutor } from '@spice-ts/mcp';
import { sha256CanonicalJson } from '@spice-ts/core/protocol';

const fixture = JSON.parse(await readFile(new URL('./circuit.json', import.meta.url), 'utf8'));
const executeTool = createToolExecutor();
let startedJobs = 0;

const execute = async (name, argumentsValue) => {
  if (name === 'spice_simulation_start') startedJobs++;
  return executeTool(name, argumentsValue);
};

const unsupported = fromCircuitJSON(fixture.unsupported);
assert.deepEqual(unsupported, {
  diagnostics: [
    {
      severity: 'info',
      code: 'LAYOUT_ONLY',
      message: 'Ignored layout-only circuit-json element schematic_text',
      path: '/0',
      elementId: 'unsupported-layout-note',
      simulationRelevant: false,
    },
    {
      severity: 'error',
      code: 'UNSUPPORTED_ELEMENT',
      message: 'Unsupported simulation-relevant circuit-json element source_component/simple_inductor',
      path: '/1',
      elementId: 'L1',
      simulationRelevant: true,
    },
  ],
  lossy: true,
});
assert.equal(unsupported.value, undefined, 'unsupported simulation elements must block conversion');
assert.equal(startedJobs, 0, 'a blocked conversion must not start a simulation');

const converted = fromCircuitJSON(fixture.supported);
assert.equal(converted.lossy, true, 'layout-only diagnostics make conversion explicitly lossy');
assert.ok(converted.value, 'layout-only diagnostics must remain nonfatal');
assert.deepEqual(converted.diagnostics, [
  {
    severity: 'info',
    code: 'LAYOUT_ONLY',
    message: 'Ignored layout-only circuit-json element schematic_text',
    path: '/0',
    elementId: 'layout-note',
    simulationRelevant: false,
  },
  {
    severity: 'info',
    code: 'LAYOUT_ONLY',
    message: 'Ignored layout-only circuit-json element pcb_component',
    path: '/13',
    elementId: 'layout-r1',
    simulationRelevant: false,
  },
]);

const analysis = { type: 'tran', timestep: 1e-7, stopTime: 5e-6, maxTimestep: 1e-7 };
const request = {
  apiVersion: '1',
  input: {
    format: 'spice-ts',
    document: {
      format: 'spice-ts',
      schemaVersion: '1.0',
      circuit: {
        components: [
          ...converted.value.components,
          {
            type: 'V',
            id: 'V1',
            name: 'V1',
            ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }],
            params: {
              waveform: 'pulse', v1: 0, v2: 1, delay: 0,
              rise: 1e-9, fall: 1e-9, width: 10e-6, period: 20e-6,
            },
          },
        ],
        nets: converted.value.nets,
      },
      analyses: [analysis],
      models: [],
      subcircuits: [],
    },
  },
  options: {
    backend: 'spice-ts-js',
    determinism: 'strict',
    maxTimestep: 1e-7,
    limits: {
      maxSourceBytes: 16384,
      maxComponents: 3,
      maxAnalyses: 1,
      maxResultPoints: 128,
      maxSerializedResultBytes: 131072,
      maxWallTimeMs: 5000,
    },
  },
};

const rejectedBackend = structured(await execute('spice_validate', {
  request: { ...request, options: { ...request.options, backend: 'spice-ts' } },
}));
assert.deepEqual(rejectedBackend, {
  error: {
    code: 'BACKEND_UNAVAILABLE',
    message: 'The requested simulation backend is unavailable',
    retryable: false,
    phase: 'validation',
    details: {},
  },
});

const validation = structured(await execute('spice_validate', { request }));
assert.deepEqual(validation, { status: 'valid', nodeCount: 2, branchCount: 1, analysisCount: 1 });

const started = structured(await execute('spice_simulation_start', { request }));
assert.deepEqual(started, { jobId: 'job-1', status: 'running', cursor: 'am9iLTE6MA' });

const emitted = [];
let cursor = started.cursor;
let thresholdPoint;
while (!thresholdPoint) {
  const chunk = await readWhenReady(started.jobId, cursor, 1);
  const replay = structured(await execute('spice_simulation_read', {
    jobId: started.jobId, cursor, maxPoints: 1,
  }));
  assert.deepEqual(replay, chunk, 'the same cursor must replay the same deterministic chunk');
  assert.equal(chunk.status, 'running', 'threshold must be crossed before the complete terminal');
  assert.equal(typeof chunk.nextCursor, 'string');
  assert.notEqual(chunk.nextCursor, cursor);

  for (const event of chunk.events) {
    emitted.push(event);
    if (event.type !== 'point') continue;
    assert.equal(event.analysisIndex, 0);
    assert.equal(event.pointIndex, emitted.filter(entry => entry.type === 'point').length - 1);
    assert.deepEqual(Object.keys(event), ['type', 'analysisIndex', 'pointIndex', 'point']);
    assert.deepEqual(Object.keys(event.point), ['type', 'timeS', 'voltagesV', 'currentsA']);
    assert.equal(event.point.type, 'tran');
    assert.equal(typeof event.point.timeS, 'number', 'timeS is expressed in seconds');
    assert.deepEqual(Object.keys(event.point.voltagesV), ['in', 'out']);
    assert.deepEqual(Object.keys(event.point.currentsA), ['V1']);
    assert.equal(typeof event.point.voltagesV.out, 'number', 'voltagesV values are expressed in volts');
    assert.equal(typeof event.point.currentsA.V1, 'number', 'currentsA values are expressed in amperes');
    if (event.point.voltagesV.out >= fixture.thresholdV) thresholdPoint = event;
  }
  cursor = chunk.nextCursor;
}
assert.ok(thresholdPoint.point.voltagesV.out >= fixture.thresholdV);

const pointEvents = emitted.filter(event => event.type === 'point');
const cancelled = structured(await execute('spice_simulation_cancel', { jobId: started.jobId }));
const expectedCancelled = {
  status: 'cancelled',
  events: [],
  nextCursor: null,
  terminal: {
    apiVersion: '1',
    ok: false,
    requestId: started.jobId,
    error: {
      code: 'CANCELLED',
      message: 'The simulation job was cancelled',
      retryable: true,
      phase: 'solve',
      details: {},
    },
    diagnostics: [],
    partial: {
      status: 'partial',
      analyses: [{
        analysis: 'tran',
        analysisIndex: 0,
        emittedPointCount: pointEvents.length,
        complete: false,
      }],
      partialEventSha256: sha256CanonicalJson(pointEvents),
    },
  },
};
assert.deepEqual(cancelled, expectedCancelled);
assert.deepEqual(
  structured(await execute('spice_simulation_cancel', { jobId: started.jobId })),
  expectedCancelled,
  'terminal cancellation must replay exactly',
);
assert.equal(hasKey(cancelled, 'resultSha256'), false, 'partial terminals must not contain a complete-result hash');

const completed = await runToCompletion(request);
assert.equal(completed.status, 'complete');
assert.equal(completed.terminal.ok, true);
assert.deepEqual(
  {
    protocolVersion: completed.terminal.metadata.protocolVersion,
    nativeSchemaVersion: completed.terminal.metadata.nativeSchemaVersion,
    spiceTsVersion: completed.terminal.metadata.spiceTsVersion,
    engineBuildId: completed.terminal.metadata.engineBuildId,
    backend: completed.terminal.metadata.backend,
    backendVersion: completed.terminal.metadata.backendVersion,
    resolvedBackend: completed.terminal.metadata.resolvedOptions.backend,
    determinism: completed.terminal.metadata.determinism,
  },
  {
    protocolVersion: '1',
    nativeSchemaVersion: '1.0',
    spiceTsVersion: '0.3.0',
    engineBuildId: 'mcp-node-v1',
    backend: 'spice-ts-js',
    backendVersion: '0.3.0',
    resolvedBackend: 'spice-ts-js',
    determinism: 'strict',
  },
);
assert.deepEqual(completed.terminal.metadata.runtime.family, 'node');
assert.equal(typeof completed.terminal.metadata.runtime.version, 'string');
assert.equal(typeof completed.terminal.metadata.architecture, 'string');
assert.equal(completed.terminal.metadata.inputSha256, sha256CanonicalJson(request.input));
assert.equal(completed.terminal.metadata.resultSha256, sha256CanonicalJson(completed.terminal.data));

for (const publicValue of [rejectedBackend, validation, started, ...emitted, cancelled, completed]) {
  assert.equal(containsExactString(publicValue, 'spice-ts'), false, 'public output leaked the internal backend name');
}

async function readWhenReady(jobId, readCursor, maxPoints) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const data = structured(await execute('spice_simulation_read', {
      jobId, cursor: readCursor, maxPoints,
    }));
    if (data.status !== 'running' || data.events.length > 0) return data;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Simulation job did not produce a stream chunk');
}

async function runToCompletion(simulationRequest) {
  const second = structured(await execute('spice_simulation_start', { request: simulationRequest }));
  let readCursor = second.cursor;
  const events = [];
  for (let attempt = 0; attempt < 1000; attempt++) {
    const data = await readWhenReady(second.jobId, readCursor, 128);
    events.push(...data.events);
    if (data.status === 'complete') {
      assert.deepEqual(
        events.filter(event => event.type === 'point').map(event => event.pointIndex),
        events.filter(event => event.type === 'point').map((_event, index) => index),
      );
      return data;
    }
    if (data.status !== 'running') throw new Error(`Control simulation ended with ${data.status}`);
    readCursor = data.nextCursor;
  }
  throw new Error('Control simulation did not complete');
}

function structured(response) {
  const value = response.structuredContent;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(response.content, [{ type: 'text', text: JSON.stringify(value) }]);
  return value;
}

function hasKey(value, key) {
  if (Array.isArray(value)) return value.some(entry => hasKey(entry, key));
  if (value && typeof value === 'object') {
    return Object.prototype.hasOwnProperty.call(value, key)
      || Object.values(value).some(entry => hasKey(entry, key));
  }
  return false;
}

function containsExactString(value, target) {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some(entry => containsExactString(entry, target));
  if (value && typeof value === 'object') {
    return Object.values(value).some(entry => containsExactString(entry, target));
  }
  return false;
}
