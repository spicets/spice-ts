// Issue #63, workflow B evidence: a circuit-json transient job is cancelled on
// a voltage threshold, and the resulting partial terminal is checked against
// the published protocol-v1 JSON Schemas. Negative fixtures prove that a
// complete-result hash (`resultSha256`) is schema-invalid both in partial
// metadata and in partial data. Only public package entry points are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Ajv2020 from 'ajv/dist/2020.js';

// Load each package through its published `exports["."].import` entry (the
// built dist), exactly what a consumer gets. The examples package does not
// declare these as workspace dependencies: doing so reorders `pnpm -r build`
// so that @spice-ts/mcp's prebuild rebuilds core while @spice-ts/wasm bundles it.
const packagesDir = new URL('../../../packages/', import.meta.url);
async function publicPackage(name, subpath = '.') {
  const packageJson = new URL(`${name}/package.json`, packagesDir);
  const manifest = JSON.parse(await readFile(packageJson, 'utf8'));
  return import(new URL(manifest.exports[subpath].import, packageJson).href);
}
const { fromCircuitJSON } = await publicPackage('circuit-json');
const { createToolExecutor } = await publicPackage('mcp');
const { protocolSchemasV1, sha256CanonicalJson } = await publicPackage('core', './protocol');
const require = createRequire(new URL('core/package.json', packagesDir));
const schemaId = name => `https://spice-ts.dev/schemas/v1/${name}.schema.json`;
const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);

// The circuit-json fixture is shared read-only with the threshold-cancellation example.
const fixture = JSON.parse(await readFile(
  new URL('../../circuit-json-threshold-cancellation/circuit.json', import.meta.url),
  'utf8',
));
const executeTool = createToolExecutor();

const converted = fromCircuitJSON(fixture.supported);
assert.ok(converted.value, 'layout-only diagnostics must remain nonfatal');
assert.ok(converted.diagnostics.every(diagnostic => diagnostic.severity === 'info'));

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
      analyses: [{ type: 'tran', timestep: 1e-7, stopTime: 5e-6, maxTimestep: 1e-7 }],
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
assert.equal(ajv.validate(schemaId('simulation-request'), request), true, ajvText());

const started = structured(await executeTool('spice_simulation_start', { request }));
assert.equal(started.status, 'running');

const pointEvents = [];
let cursor = started.cursor;
let thresholdEvent;
while (!thresholdEvent) {
  const chunk = await readWhenReady(started.jobId, cursor);
  assert.equal(ajv.validate(schemaId('simulation-read-data'), chunk), true, ajvText());
  assert.equal(chunk.status, 'running', 'threshold must be crossed before the complete terminal');
  for (const event of chunk.events) {
    if (event.type !== 'point') continue;
    assert.equal(event.analysisIndex, 0);
    assert.equal(event.pointIndex, pointEvents.length, 'point indexes must be consecutive');
    pointEvents.push(event);
    if (event.point.voltagesV.out >= fixture.thresholdV) thresholdEvent = event;
  }
  cursor = chunk.nextCursor;
}

const cancelled = structured(await executeTool('spice_simulation_cancel', { jobId: started.jobId }));
assert.equal(cancelled.status, 'cancelled');
const terminal = cancelled.terminal;
assert.equal(terminal.partial.partialEventSha256, sha256CanonicalJson(pointEvents));
assert.equal(terminal.partial.analyses[0].emittedPointCount, pointEvents.length);
assert.equal(hasKey(cancelled, 'resultSha256'), false, 'partial terminals must not carry resultSha256');

// Positive controls: the observed cancellation, and the same terminal with a
// partial metadata block that carries only an input hash.
const inputSha256 = sha256CanonicalJson(request.input);
const withInputHashOnly = { ...terminal, metadata: { inputSha256 } };
// Negative fixtures: identical terminals that add a complete-result hash.
const leakedResultSha256 = sha256CanonicalJson(pointEvents);
const resultHashInPartialMetadata = { ...terminal, metadata: { inputSha256, resultSha256: leakedResultSha256 } };
const resultHashInPartialData = { ...terminal, partial: { ...terminal.partial, resultSha256: leakedResultSha256 } };
const packagedNegative = JSON.parse(await readFile(
  require.resolve('@spice-ts/core/protocol/fixtures/negative-v1.json'),
  'utf8',
)).partialWithResultHash;

const checks = [
  check('observed cancelled read data', 'simulation-read-data', cancelled),
  check('observed cancelled terminal', 'stream-terminal', terminal),
  check('partial metadata with inputSha256 only', 'partial-run-metadata', withInputHashOnly.metadata),
  check('terminal with inputSha256-only partial metadata', 'stream-terminal', withInputHashOnly),
  check('partial metadata with resultSha256', 'partial-run-metadata', resultHashInPartialMetadata.metadata),
  check('terminal with resultSha256 in partial metadata', 'stream-terminal', resultHashInPartialMetadata),
  check('partial data with resultSha256', 'partial-simulation-result', resultHashInPartialData.partial),
  check('terminal with resultSha256 in partial data', 'stream-terminal', resultHashInPartialData),
  check('@spice-ts/core/protocol fixtures/negative-v1.json#/partialWithResultHash', 'stream-terminal', packagedNegative),
];
assert.deepEqual(checks.map(({ valid }) => valid), [true, true, true, true, false, false, false, false, false]);

const report = {
  workflow: 'circuit-json-transient-threshold-cancellation',
  conversion: {
    lossy: converted.lossy,
    diagnostics: converted.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
  },
  requestInputSha256: inputSha256,
  threshold: {
    node: 'out',
    thresholdV: fixture.thresholdV,
    pointIndex: thresholdEvent.pointIndex,
    timeS: thresholdEvent.point.timeS,
    voltageV: thresholdEvent.point.voltagesV.out,
  },
  cancelled,
  schemaChecks: checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function check(name, schema, value) {
  const valid = ajv.validate(schemaId(schema), value);
  const result = { name, schema: `${schema}.schema.json`, valid };
  if (!valid && schema !== 'stream-terminal') {
    // oneOf unions report noisy branch errors; direct schemas report the exact rejection.
    result.errors = ajv.errors.map(({ instancePath, keyword, params }) => ({ instancePath, keyword, params }));
  }
  return result;
}

function ajvText() {
  return ajv.errorsText(ajv.errors, { separator: '\n' });
}

async function readWhenReady(jobId, readCursor) {
  for (;;) {
    const data = structured(await executeTool('spice_simulation_read', { jobId, cursor: readCursor, maxPoints: 1 }));
    if (data.status !== 'running' || data.events.length > 0) return data;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
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
