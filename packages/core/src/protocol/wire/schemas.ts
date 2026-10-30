type Schema = Record<string, unknown>;

const object = (required: string[], properties: Record<string, Schema>, additionalProperties: boolean | Schema = false): Schema => ({
  type: 'object', required, properties, additionalProperties,
});
const array = (items: Schema): Schema => ({ type: 'array', items });
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const integer = (minimum = 0): Schema => ({ type: 'integer', minimum });
const number: Schema = { type: 'number' };
const string: Schema = { type: 'string' };
const hash: Schema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const backend: Schema = { enum: ['spice-ts-js', 'spice-ts-wasm', 'ngspice-wasm'] };
const determinism: Schema = { enum: ['strict', 'relaxed'] };
const stepProperties = { index: integer(), parameter: string, value: number };
const analysisIndex = integer();
const step = ref('step');
const numberRecord: Schema = { type: 'object', additionalProperties: number };
const numberSeriesRecord: Schema = { type: 'object', additionalProperties: array(number) };
const dcSweepProperties = { source: { type: 'string', pattern: '^\\S+$' }, start: number, stop: number, step: { type: 'number', not: { const: 0 } } };
const dcAxis = object(['name', 'unit', 'values'], { name: string, unit: { enum: ['V', 'A'] }, values: array(number) });

const measurementVector = { type: 'string', pattern: '^(?:[vV]\\([^\\s(),]+(?:,[^\\s(),]+)?\\)|[iI]\\([^\\s(),]+\\))$' };
const crossing = object(['vector', 'value'], { vector: measurementVector, value: number, rise: { oneOf: [integer(1), { const: 'last' }] }, fall: { oneOf: [integer(1), { const: 'last' }] }, cross: { oneOf: [integer(1), { const: 'last' }] }, td: number });
const measurementName = { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_]*$' };
const measurement: Schema = { oneOf: [
  object(['name', 'kind', 'trig', 'targ'], { name: measurementName, kind: { const: 'trig' }, trig: crossing, targ: crossing }),
  object(['name', 'kind', 'vector', 'at'], { name: measurementName, kind: { const: 'find' }, vector: measurementVector, at: number }),
  object(['name', 'kind', 'vector', 'when'], { name: measurementName, kind: { const: 'find' }, vector: measurementVector, when: crossing }),
  object(['name', 'kind', 'vector'], { name: measurementName, kind: { enum: ['avg', 'min', 'max', 'pp', 'rms', 'integ'] }, vector: measurementVector, from: number, to: number }),
] };
const dcMeasurement: Schema = { oneOf: (measurement.oneOf as Schema[]).slice(1) };
const acVector = { type: 'string', pattern: '^[vV](?:[mM]|[dD][bB]|[pP])\\([^\\s(),]+\\)$' };
const frequency = { type: 'number', minimum: 0 };
const acMeasurement: Schema = { oneOf: [
  object(['name', 'kind', 'vector', 'at'], { name: measurementName, kind: { const: 'find' }, vector: acVector, at: frequency }),
  object(['name', 'kind', 'vector'], { name: measurementName, kind: { enum: ['avg', 'min', 'max', 'pp', 'rms', 'integ'] }, vector: acVector, from: frequency, to: frequency }),
] };
const measurementResult: Schema = { oneOf: [
  object(['name', 'value'], { name: string, value: number, unit: string }),
  object(['name', 'diagnostic'], { name: string, diagnostic: object(['code', 'message'], { code: { const: 'MEASUREMENT_FAILED' }, message: string }) }),
] };

const analysis: Schema = { oneOf: [
  object(['type'], { type: { const: 'op' } }),
  { ...object(['type', 'source', 'start', 'stop', 'step'], { type: { const: 'dc' }, ...dcSweepProperties, secondary: object(['source', 'start', 'stop', 'step'], dcSweepProperties), measurements: { type: 'array', maxItems: 100, items: dcMeasurement } }), not: { type: 'object', properties: { secondary: {}, measurements: {} }, required: ['secondary', 'measurements'] } },
  object(['type', 'timestep', 'stopTime'], { type: { const: 'tran' }, timestep: { type: 'number', exclusiveMinimum: 0 }, stopTime: { type: 'number', minimum: 0 }, startTime: { type: 'number', minimum: 0 }, maxTimestep: { type: 'number', exclusiveMinimum: 0 }, uic: { const: true }, measurements: { type: 'array', maxItems: 100, items: measurement }, fourier: object(['fundamentalHz', 'outputs'], {
    fundamentalHz: { type: 'number', exclusiveMinimum: 0 }, harmonics: { type: 'integer', minimum: 1, maximum: 199 },
    outputs: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', pattern: '^(?:[vV]\\(\\s*[^\\s(),]+\\s*(?:,\\s*[^\\s(),]+\\s*)?\\)|[iI]\\(\\s*[^\\s(),]+\\s*\\))$' } },
  }) }),
  object(['type', 'variation', 'points', 'startFreq', 'stopFreq'], { type: { const: 'ac' }, variation: { enum: ['dec', 'oct', 'lin'] }, points: integer(1), startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 }, measurements: { type: 'array', maxItems: 100, items: acMeasurement } }),
] };

const nativeAnalysis: Schema = { oneOf: [
  ref('analysis'),
  ref('tfAnalysis'),
  ref('distoAnalysis'),
  ref('sensitivityAnalysis'),
  object(['type', 'variation', 'points', 'startFreq', 'stopFreq'], { type: { const: 'sp' }, variation: { enum: ['dec', 'oct', 'lin'] }, points: integer(1), startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 } }),
] };

const sensitivityAnalysis = { oneOf: ['dc', 'ac'].map(mode => ({
  ...object(['type', 'mode', 'outputNode', ...(mode === 'ac' ? ['variation', 'points', 'startFreq', 'stopFreq'] : [])], {
    type: { const: 'sens' }, mode: { const: mode }, outputNode: { type: 'string', pattern: '\\S' },
    outputReferenceNode: { type: 'string', pattern: '\\S' }, outputType: { enum: ['voltage', 'current'] },
    ...(mode === 'ac' ? {
      variation: { enum: ['dec', 'oct', 'lin'] }, points: integer(1),
      startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 },
    } : {}),
  }),
  allOf: [{
    if: { properties: { outputType: { const: 'current' } }, required: ['outputType'] },
    then: { properties: { outputReferenceNode: false } },
  }],
})) };

const tfAnalysis = object(['type', 'output', 'source'], {
  type: { const: 'tf' }, output: { type: 'string', pattern: '^(?:[vV]\\(\\s*[^\\s(),]+\\s*(?:,\\s*[^\\s(),]+\\s*)?\\)|[iI]\\(\\s*[vV][^\\s(),]*\\s*\\))$' },
  source: { type: 'string', pattern: '^[^\\s]+$' },
});

const distoAnalysis = object(['type', 'variation', 'points', 'startFreq', 'stopFreq'], {
  type: { const: 'disto' }, variation: { const: 'dec' }, points: integer(1),
  startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 },
  f2OverF1: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
});

const noiseAnalysis = object(['type', 'outputNode', 'inputSource', 'variation', 'points', 'startFreq', 'stopFreq'], {
  type: { const: 'noise' }, outputNode: { type: 'string', pattern: '\\S' },
  outputReferenceNode: { type: 'string', pattern: '\\S' }, inputSource: { type: 'string', pattern: '\\S' },
  variation: { enum: ['dec', 'oct', 'lin'] }, points: integer(1),
  startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 },
});

const poleZeroAnalysis = object(['type', 'inputPositive', 'inputNegative', 'outputPositive', 'outputNegative', 'inputType', 'mode'], {
  type: { const: 'pz' }, inputPositive: string, inputNegative: string,
  outputPositive: string, outputNegative: string,
  inputType: { enum: ['cur', 'vol'] }, mode: { enum: ['pol', 'zer', 'pz'] },
});

const jsonValue: Schema = { oneOf: [
  { type: 'null' }, { type: 'boolean' }, string, number,
  { type: 'array', items: ref('jsonValue') },
  { type: 'object', additionalProperties: ref('jsonValue') },
] };
const component: Schema = { ...object(['type', 'id', 'name', 'ports', 'params'], {
  type: string, id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 },
  ports: array(ref('port')), params: { type: 'object', additionalProperties: ref('jsonValue') }, model: string, subcircuit: string,
}), allOf: [{
  if: { properties: { type: { enum: ['V', 'v'] } }, required: ['type'] },
  then: { properties: { params: { type: 'object', properties: { portnum: integer(1), z0: { type: 'number', exclusiveMinimum: 0 } } } } },
}, {
  if: { properties: { type: { enum: ['V', 'v', 'I', 'i'] } }, required: ['type'] },
  then: { properties: { params: { type: 'object', properties: {
    distortionF1: object(['magnitude'], { magnitude: number, phase: number }),
    distortionF2: object(['magnitude'], { magnitude: number, phase: number }),
  } } } },
}] };
const model = object(['name', 'type', 'params'], {
  name: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 }, params: { type: 'object', additionalProperties: ref('jsonValue') },
});
const nativeDocument = object(['format', 'schemaVersion', 'circuit', 'analyses', 'models', 'subcircuits'], {
  format: { const: 'spice-ts' }, schemaVersion: { const: '1.0' },
  globalNodes: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9_.:+-]+(?![\\s\\S])' } },
  circuit: object(['components', 'nets'], { components: array(ref('component')), nets: { type: 'array', items: { type: 'string', not: { const: '0' } }, uniqueItems: true } }),
  analyses: array(ref('nativeAnalysis')), models: array(ref('model')), subcircuits: array(ref('subcircuit')),
  poleZeroAnalyses: array(ref('poleZeroAnalysis')),
  noiseAnalyses: array(ref('noiseAnalysis')),
  initialConditions: numberRecord, nodesets: numberRecord,
});
const simulationInput: Schema = { oneOf: [
  object(['format', 'source'], { format: { const: 'spice' }, source: string, virtualFiles: { type: 'object', propertyNames: { type: 'string', pattern: '^(?!(?:.*//)|/)(?:(?!\\.{1,2}(?:/|$))[^/\\\\]+)(?:/(?!\\.{1,2}(?:/|$))[^/\\\\]+)*$' }, additionalProperties: string } }),
  object(['format', 'document'], { format: { const: 'spice-ts' }, document: ref('nativeDocument') }),
  object(['format', 'circuit', 'analyses'], { format: { const: 'circuit-json' }, circuit: array(ref('jsonValue')), analyses: array(ref('analysis')), poleZeroAnalyses: array(ref('poleZeroAnalysis')), noiseAnalyses: array(ref('noiseAnalysis')) }),
] };
const limits = object([], Object.fromEntries(['maxSourceBytes', 'maxVirtualFiles', 'maxIncludeDepth', 'maxComponents', 'maxSubcircuitDepth', 'maxAnalyses', 'maxResultPoints', 'maxSerializedResultBytes', 'maxWallTimeMs'].map((key) => [key, integer()])));
const options = object([], {
  temperature: { type: 'number', exclusiveMinimum: -273.15 }, nominalTemperature: { type: 'number', exclusiveMinimum: -273.15 },
  backend, determinism, limits: ref('limits'), abstol: { type: 'number', minimum: 0 }, vntol: { type: 'number', minimum: 0 }, reltol: { type: 'number', minimum: 0 },
  maxIterations: integer(1), maxTransientIterations: integer(1), maxTimestep: { type: 'number', exclusiveMinimum: 0 }, integrationMethod: { enum: ['euler', 'trapezoidal', 'gear2'] }, trtol: { type: 'number', exclusiveMinimum: 0 }, gmin: { type: 'number', minimum: 0 },
});
const complex = object(['magnitude', 'phaseDegrees'], { magnitude: { type: 'number', minimum: 0 }, phaseDegrees: number });
const complexRecord: Schema = { type: 'object', additionalProperties: ref('complex') };
const complexSeriesRecord: Schema = { type: 'object', additionalProperties: array(ref('complex')) };
const commonResult = { analysisIndex, step };
const opResult = object(['type', 'analysisIndex', 'voltagesV', 'currentsA'], { type: { const: 'op' }, ...commonResult, voltagesV: numberRecord, currentsA: numberRecord });
const dcResult = object(['type', 'analysisIndex', 'axis', 'voltagesV', 'currentsA'], { type: { const: 'dc' }, ...commonResult, axis: dcAxis, secondaryAxis: dcAxis, voltagesV: numberSeriesRecord, currentsA: numberSeriesRecord, measurements: array(measurementResult) });
const nullableNumber: Schema = { type: ['number', 'null'] };
const fourierResult = object(['vector', 'fundamental', 'gridSize', 'degree', 'periods', 'thd', 'harmonics'], {
  vector: string, fundamental: nullableNumber, gridSize: integer(1), degree: integer(), periods: integer(1), thd: nullableNumber,
  harmonics: array(object(['harmonic', 'frequency', 'magnitude', 'phase', 'normalizedMagnitude', 'normalizedPhase'], {
    harmonic: integer(), frequency: nullableNumber, magnitude: nullableNumber, phase: nullableNumber, normalizedMagnitude: nullableNumber, normalizedPhase: nullableNumber,
  })),
});
const tranResult = object(['type', 'analysisIndex', 'timeS', 'voltagesV', 'currentsA'], { type: { const: 'tran' }, ...commonResult, timeS: array(number), voltagesV: numberSeriesRecord, currentsA: numberSeriesRecord, fourier: array(fourierResult), measurements: array(measurementResult) });
const acResult = object(['type', 'analysisIndex', 'frequencyHz', 'voltagePhasors', 'currentPhasors'], { type: { const: 'ac' }, ...commonResult, frequencyHz: array({ type: 'number', minimum: 0 }), measurements: array(measurementResult), voltagePhasors: complexSeriesRecord, currentPhasors: complexSeriesRecord });
const simulationResult = object(['status', 'analyses'], { status: { const: 'complete' }, analyses: array(ref('analysisResult')) });
const tfResult = object(['type', 'analysisIndex', 'transferFunction', 'inputResistanceOhm', 'outputResistanceOhm'], { type: { const: 'tf' }, ...commonResult, transferFunction: number, inputResistanceOhm: number, outputResistanceOhm: number });
const diagnostic = object(['severity', 'code', 'message'], {
  severity: { enum: ['info', 'warning', 'error'] }, code: string, message: string, path: string,
  source: object(['file', 'line'], { file: string, line: integer(1), column: integer(1), excerpt: string }),
  related: array(object(['message'], { path: string, message: string })),
  suggestions: array(object(['action'], { action: string, replacement: ref('jsonValue') })),
});
const apiError = object(['code', 'message', 'retryable', 'phase', 'details'], {
  code: { enum: ['INVALID_REQUEST', 'INVALID_INPUT', 'PARSE_ERROR', 'INVALID_CIRCUIT', 'UNSUPPORTED_FEATURE', 'UNSUPPORTED_ELEMENT', 'SINGULAR_MATRIX', 'CONVERGENCE_FAILED', 'TIMESTEP_TOO_SMALL', 'RESOURCE_LIMIT', 'CANCELLED', 'BACKEND_UNAVAILABLE', 'INTERNAL_ERROR'] },
  message: string, retryable: { type: 'boolean' }, phase: { enum: ['validation', 'parse', 'compile', 'solve', 'serialize', 'transport'] }, details: { type: 'object', additionalProperties: ref('jsonValue') },
});
const resolvedOptionsProperties = {
  temperature: { type: 'number', exclusiveMinimum: -273.15 }, nominalTemperature: { type: 'number', exclusiveMinimum: -273.15 },
  backend, abstol: number, vntol: number, reltol: number, maxIterations: integer(), maxTransientIterations: integer(), maxTimestep: number,
  integrationMethod: { enum: ['euler', 'trapezoidal', 'gear2'] }, trtol: number, gmin: number, determinism, limits: ref('limits'),
};
const resolvedOptions = object(['backend', 'abstol', 'vntol', 'reltol', 'maxIterations', 'maxTransientIterations', 'maxTimestep', 'integrationMethod', 'trtol', 'gmin', 'determinism'], resolvedOptionsProperties);
const metadataProperties = {
  protocolVersion: { const: '1' }, nativeSchemaVersion: { const: '1.0' }, spiceTsVersion: string, engineBuildId: string, backend, backendVersion: string,
  resolvedOptions: ref('resolvedOptions'), inputSha256: hash, resultSha256: hash,
  runtime: object(['family', 'version'], { family: string, version: string }), architecture: string, determinism,
};
const runMetadata = object(['protocolVersion', 'spiceTsVersion', 'engineBuildId', 'backend', 'backendVersion', 'resolvedOptions', 'inputSha256', 'resultSha256', 'runtime', 'architecture', 'determinism'], metadataProperties);
const { resultSha256: _omitted, ...partialMetadataProperties } = metadataProperties;
const partialRunMetadata = object([], partialMetadataProperties);
const envelopeCommon = { apiVersion: { const: '1' }, requestId: string, diagnostics: array(ref('diagnostic')) };
const successEnvelope = object(['apiVersion', 'ok', 'requestId', 'data', 'diagnostics', 'metadata'], { ...envelopeCommon, ok: { const: true }, data: ref('simulationResult'), metadata: ref('runMetadata') });
const failureEnvelope = object(['apiVersion', 'ok', 'requestId', 'error', 'diagnostics'], { ...envelopeCommon, ok: { const: false }, error: ref('apiError'), metadata: ref('partialRunMetadata') });
const streamPoint: Schema = { oneOf: [
  object(['type', 'axis', 'voltagesV', 'currentsA'], { type: { const: 'dc' }, axis: object(['name', 'unit', 'value'], { name: string, unit: { enum: ['V', 'A'] }, value: number }), voltagesV: numberRecord, currentsA: numberRecord }),
  object(['type', 'timeS', 'voltagesV', 'currentsA'], { type: { const: 'tran' }, timeS: number, voltagesV: numberRecord, currentsA: numberRecord }),
  object(['type', 'frequencyHz', 'voltagePhasors', 'currentPhasors'], { type: { const: 'ac' }, frequencyHz: { type: 'number', minimum: 0 }, voltagePhasors: complexRecord, currentPhasors: complexRecord }),
] };
const simulationEvent: Schema = { oneOf: [
  object(['type', 'analysis', 'analysisIndex'], { type: { const: 'analysis-start' }, analysis: { enum: ['op', 'dc', 'tran', 'ac', 'tf'] }, analysisIndex, step }),
  object(['type', 'analysisIndex', 'pointIndex', 'point'], { type: { const: 'point' }, analysisIndex, step, pointIndex: integer(), point: ref('streamPoint') }),
  object(['type', 'analysis', 'analysisIndex', 'pointCount'], { type: { const: 'analysis-end' }, analysis: { enum: ['op', 'dc', 'tran', 'ac', 'tf'] }, analysisIndex, step, pointCount: integer() }),
  object(['type', 'diagnostic'], { type: { const: 'diagnostic' }, diagnostic: ref('diagnostic') }),
] };
const partialResult = object(['status', 'analyses', 'partialEventSha256'], {
  status: { const: 'partial' }, analyses: array(object(['analysis', 'analysisIndex', 'emittedPointCount', 'complete'], { analysis: { enum: ['dc', 'tran', 'ac'] }, analysisIndex, step, emittedPointCount: integer(), complete: { type: 'boolean' } })), partialEventSha256: hash,
});
const failureTerminal = object(['apiVersion', 'ok', 'requestId', 'error', 'diagnostics', 'partial'], { ...envelopeCommon, ok: { const: false }, error: ref('apiError'), metadata: ref('partialRunMetadata'), partial: ref('partialResult') });
const simulationReadData: Schema = { oneOf: [
  object(['status', 'events', 'nextCursor'], {
    status: { const: 'running' }, events: array(ref('simulationEvent')), nextCursor: string,
  }),
  object(['status', 'events', 'nextCursor', 'terminal'], {
    status: { const: 'complete' }, events: array(ref('simulationEvent')), nextCursor: { const: null }, terminal: ref('successEnvelope'),
  }),
  object(['status', 'events', 'nextCursor', 'terminal'], {
    status: { enum: ['failed', 'cancelled'] }, events: array(ref('simulationEvent')), nextCursor: { const: null }, terminal: ref('failureTerminal'),
  }),
] };

export const commonSchemaV1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://spice-ts.dev/schemas/v1/common.schema.json',
  $defs: {
    jsonValue, sha256: hash, step: object(['index', 'parameter', 'value'], stepProperties), analysis, nativeAnalysis, distoAnalysis, sensitivityAnalysis, poleZeroAnalysis, noiseAnalysis,
    port: object(['name', 'net'], { name: string, net: string }), component, model,
    subcircuit: object(['name', 'ports', 'components'], { name: { type: 'string', minLength: 1 }, ports: array(string), components: array(ref('component')), models: array(ref('model')) }),
    nativeDocument, simulationInput, limits, options,
    simulationRequest: object(['apiVersion', 'input'], { apiVersion: { const: '1' }, input: ref('simulationInput'), options: ref('options'), outputs: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 256, pattern: '^[vViI]\\([^\\s(),]+\\)(?![\\s\\S])' } } }),
    complex, opResult, dcResult, tranResult, acResult, tfResult, tfAnalysis,
    analysisResult: { oneOf: [ref('opResult'), ref('dcResult'), ref('tranResult'), ref('acResult'), ref('tfResult')] }, simulationResult,
    diagnostic, apiError, resolvedOptions, runMetadata, partialRunMetadata, successEnvelope, failureEnvelope,
    streamPoint, simulationEvent, partialResult, failureTerminal,
    streamTerminal: { oneOf: [ref('successEnvelope'), ref('failureTerminal')] }, simulationReadData,
  },
} as const;

const document = (name: string, definition: string) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://spice-ts.dev/schemas/v1/${name}.schema.json`,
  $ref: `https://spice-ts.dev/schemas/v1/common.schema.json#/$defs/${definition}`,
});

export const protocolSchemasV1 = {
  common: commonSchemaV1,
  'simulation-request': document('simulation-request', 'simulationRequest'),
  'simulation-input': document('simulation-input', 'simulationInput'),
  options: document('options', 'options'),
  'spice-ts-document': document('spice-ts-document', 'nativeDocument'),
  'simulation-result': document('simulation-result', 'simulationResult'),
  diagnostic: document('diagnostic', 'diagnostic'),
  'stream-point': document('stream-point', 'streamPoint'),
  'simulation-event': document('simulation-event', 'simulationEvent'),
  'partial-simulation-result': document('partial-simulation-result', 'partialResult'),
  'run-metadata': document('run-metadata', 'runMetadata'),
  'partial-run-metadata': document('partial-run-metadata', 'partialRunMetadata'),
  'success-envelope': document('success-envelope', 'successEnvelope'),
  'failure-envelope': document('failure-envelope', 'failureEnvelope'),
  'stream-terminal': document('stream-terminal', 'streamTerminal'),
  'simulation-read-data': document('simulation-read-data', 'simulationReadData'),
} as const;
