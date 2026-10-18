import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import negative from '../../../protocol/fixtures/negative-v1.json';
import positive from '../../../protocol/fixtures/positive-v1.json';
import {
  canonicalJson,
  canonicalJsonBytes,
  checkConformanceV1,
  protocolSchemasV1,
  sha256CanonicalJson,
  type FailureEnvelopeV1,
  type SimulationRequestV1,
  type SimulationResultV1,
  type StreamTerminalV1,
  type SuccessEnvelopeV1,
} from './index.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);

const validate = (id: string, value: unknown): boolean => {
  const result = ajv.validate(id, value);
  if (!result) console.error(ajv.errorsText(ajv.errors, { separator: '\n' }));
  return result;
};

const hash = 'a'.repeat(64);
const metadata = {
  protocolVersion: '1',
  spiceTsVersion: '0.3.0',
  engineBuildId: 'test-build',
  backend: 'spice-ts-js',
  backendVersion: '0.3.0',
  resolvedOptions: {
    backend: 'spice-ts-js',
    abstol: 1e-12,
    vntol: 1e-6,
    reltol: 1e-3,
    maxIterations: 100,
    maxTransientIterations: 20,
    maxTimestep: 1,
    integrationMethod: 'trapezoidal',
    trtol: 7,
    gmin: 1e-12,
    determinism: 'strict',
  },
  inputSha256: hash,
  resultSha256: hash,
  runtime: { family: 'node', version: '20.19.0' },
  architecture: 'x64',
  determinism: 'strict',
} as const;

describe('protocol v1 JSON Schemas', () => {
  it('round-trips all tagged simulation inputs', () => {
    for (const request of Object.values(positive.requests)) {
      expect(validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', request)).toBe(true);
      expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    }
  });

  it('validates exact OP, DC, TRAN and AC result fields and SI units', () => {
    expect(validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', positive.result)).toBe(true);
    expect(positive.result.analyses.map((analysis) => analysis.type)).toEqual(['op', 'dc', 'tran', 'ac']);
  });

  it('validates stream points and events', () => {
    for (const event of positive.events) {
      expect(validate('https://spice-ts.dev/schemas/v1/simulation-event.schema.json', event)).toBe(true);
    }
  });

  it('rejects unsupported versions, invalid tagged unions and internal backends', () => {
    const id = 'https://spice-ts.dev/schemas/v1/simulation-request.schema.json';
    expect(validate(id, negative.unsupportedVersion)).toBe(false);
    expect(validate(id, negative.invalidUnion)).toBe(false);
    expect(validate(id, negative.internalBackend)).toBe(false);

    for (const backend of ['spice-ts-js', 'spice-ts-wasm', 'ngspice-wasm']) {
      const request = { ...positive.requests.spice, options: { backend } };
      expect(validate(id, request)).toBe(true);
    }
  });

  it('rejects non-normalized virtual-file names', () => {
    const id = 'https://spice-ts.dev/schemas/v1/simulation-request.schema.json';
    for (const name of negative.nonNormalizedVirtualFiles) {
      expect(validate(id, {
        apiVersion: '1', input: { format: 'spice', source: '.op', virtualFiles: { [name]: '.op' } },
      })).toBe(false);
    }
    expect(validate(id, {
      apiVersion: '1', input: { format: 'spice', source: '.op', virtualFiles: { 'models/diode.lib': '.model D D' } },
    })).toBe(true);
  });

  it('requires complete success metadata and forbids result hashes on failure metadata', () => {
    const success: SuccessEnvelopeV1<SimulationResultV1> = {
      apiVersion: '1', ok: true, requestId: 'req-1', data: positive.result as SimulationResultV1,
      diagnostics: [], metadata,
    };
    expect(validate('https://spice-ts.dev/schemas/v1/success-envelope.schema.json', success)).toBe(true);
    const missingHash = { ...success, metadata: { ...metadata, resultSha256: undefined } };
    expect(validate('https://spice-ts.dev/schemas/v1/success-envelope.schema.json', JSON.parse(JSON.stringify(missingHash)))).toBe(false);
    expect(validate('https://spice-ts.dev/schemas/v1/stream-terminal.schema.json', negative.partialWithResultHash)).toBe(false);
  });

  it('requires partial failed and cancelled terminals without complete-result hashes', () => {
    for (const [status, code] of [['failed', 'CONVERGENCE_FAILED'], ['cancelled', 'CANCELLED']] as const) {
      const terminal = {
        apiVersion: '1', ok: false, requestId: `req-${status}`,
        error: { code, message: status, retryable: true, phase: 'solve', details: {} },
        diagnostics: [], metadata: { inputSha256: hash },
        partial: { status: 'partial', analyses: [], partialEventSha256: hash },
      };
      expect(validate('https://spice-ts.dev/schemas/v1/stream-terminal.schema.json', terminal)).toBe(true);
      expect(validate('https://spice-ts.dev/schemas/v1/simulation-read-data.schema.json', {
        status, events: [], nextCursor: null, terminal,
      })).toBe(true);
    }
    expect(validate('https://spice-ts.dev/schemas/v1/simulation-read-data.schema.json', {
      status: 'running', events: [], nextCursor: 'cursor-1', terminal: {},
    })).toBe(false);
  });
});

describe('semantic conformance', () => {
  it('reports stable duplicate, series-length and key-order diagnostics', () => {
    expect(checkConformanceV1('spice-ts-document', negative.duplicateIds)).toEqual([
      { code: 'DUPLICATE_CASE_INSENSITIVE_ID', path: '/circuit/components/1/id', message: 'Component id duplicates /circuit/components/0/id under SPICE case-insensitive comparison' },
    ]);
    expect(checkConformanceV1('simulation-result', negative.mismatchedSeries)).toEqual([
      { code: 'SERIES_LENGTH_MISMATCH', path: '/analyses/0/voltagesV/out', message: 'Series length 1 does not match axis length 2' },
    ]);
    expect(checkConformanceV1('simulation-result', {
      status: 'complete', analyses: [{ type: 'op', analysisIndex: 0, voltagesV: { z: 1, a: 2 }, currentsA: {} }],
    })[0]?.code).toBe('UNSORTED_RECORD_KEYS');
  });

  it('enforces contiguous point indexes and matching point discriminators', () => {
    expect(checkConformanceV1('simulation-events', [
      { type: 'analysis-start', analysis: 'dc', analysisIndex: 0 },
      { type: 'point', analysisIndex: 0, pointIndex: 1, point: { type: 'tran', timeS: 0, voltagesV: {}, currentsA: {} } },
    ])).toEqual([
      { code: 'NONCONTIGUOUS_POINT_INDEX', path: '/1/pointIndex', message: 'Expected pointIndex 0, received 1' },
      { code: 'POINT_ANALYSIS_MISMATCH', path: '/1/point/type', message: 'Point type tran does not match enclosing analysis dc' },
    ]);
  });

  it('enforces zero-based analysis ordering and legal stepped reuse', () => {
    expect(checkConformanceV1('simulation-result', positive.steppedResult)).toEqual([]);
    expect(checkConformanceV1('simulation-result', negative.nonZeroFirstAnalysisIndex)).toEqual([{
      code: 'NONCONTIGUOUS_ANALYSIS_INDEX', path: '/analyses/0/analysisIndex', message: 'Expected analysisIndex 0, received 2',
    }]);
    expect(checkConformanceV1('simulation-result', negative.gappedAnalysisIndexes)).toEqual([{
      code: 'NONCONTIGUOUS_ANALYSIS_INDEX', path: '/analyses/1/analysisIndex', message: 'Expected analysisIndex 1, received 2',
    }]);
    expect(checkConformanceV1('simulation-result', negative.duplicateAnalysisIndexes)).toEqual([{
      code: 'ILLEGAL_ANALYSIS_INDEX_REUSE', path: '/analyses/1/analysisIndex', message: 'analysisIndex 0 may repeat only for stepped results',
    }]);
    expect(checkConformanceV1('simulation-result', negative.duplicateStepIndexes)).toEqual([{
      code: 'NONCONTIGUOUS_STEP_INDEX', path: '/analyses/1/step/index', message: 'Expected step.index 1, received 0',
    }]);
    expect(checkConformanceV1('simulation-result', negative.descendingStepIndexes)).toEqual([{
      code: 'NONCONTIGUOUS_STEP_INDEX', path: '/analyses/2/step/index', message: 'Expected step.index 2, received 0',
    }]);
  });

  it('enforces analysis and step ordering in streams', () => {
    expect(checkConformanceV1('simulation-events', positive.steppedEvents)).toEqual([]);
    expect(checkConformanceV1('simulation-events', negative.invalidEventOrdering)).toEqual([
      { code: 'NONCONTIGUOUS_STEP_INDEX', path: '/2/step/index', message: 'Expected step.index 1, received 0' },
      { code: 'NONCONTIGUOUS_STEP_INDEX', path: '/6/step/index', message: 'Expected step.index 2, received 0' },
      { code: 'NONCONTIGUOUS_ANALYSIS_INDEX', path: '/8/analysisIndex', message: 'Expected analysisIndex 1, received 2' },
    ]);
    expect(checkConformanceV1('simulation-events', negative.duplicateUnsteppedEvents)).toEqual([
      { code: 'ILLEGAL_ANALYSIS_INDEX_REUSE', path: '/2/analysisIndex', message: 'analysisIndex 0 may repeat only for stepped results' },
    ]);
  });

  it('reconstructs the same transient axes and series from stream points', () => {
    const points = positive.events
      .filter((event) => event.type === 'point')
      .map((event) => event.point)
      .filter((point): point is NonNullable<typeof point> => point !== undefined);
    const transient = positive.result.analyses.find((analysis) => analysis.type === 'tran') as
      | { timeS: number[]; voltagesV: Record<string, number[]> }
      | undefined;
    expect(points.map((point) => point.timeS)).toEqual(transient?.timeS ?? []);
    expect(points.map((point) => point.voltagesV.out)).toEqual(transient?.voltagesV.out ?? []);
  });
});

describe('canonical JSON and SHA-256', () => {
  it('uses Unicode code-point key order, UTF-8 and no whitespace', () => {
    const value = { '\u{10000}': 'astral', '\ue000': 'bmp', b: 1, a: 'é' };
    expect(canonicalJson(value)).toBe('{"a":"é","b":1,"":"bmp","𐀀":"astral"}');
    expect(new TextDecoder().decode(canonicalJsonBytes(value))).toBe(canonicalJson(value));
  });

  it('normalizes negative zero and rejects non-finite or non-JSON numbers', () => {
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('NON_FINITE_NUMBER at /value');
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow('NON_FINITE_NUMBER at /value');
    expect(() => canonicalJson({ value: 1n })).toThrow('UNSUPPORTED_JSON_VALUE at /value');
    expect(checkConformanceV1('json-value', { value: -0 })).toEqual([
      { code: 'NON_CANONICAL_NUMBER', path: '/value', message: 'Negative zero must be normalized to 0' },
    ]);
    expect(checkConformanceV1('json-value', { value: Number.NaN })).toEqual([
      { code: 'NON_FINITE_NUMBER', path: '/value', message: 'JSON numbers must be finite' },
    ]);
  });

  it('produces a stable canonical hash and deterministic chunk replay', () => {
    expect(sha256CanonicalJson({ b: 2, a: 1 })).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
    expect(sha256CanonicalJson(positive.events)).toBe(sha256CanonicalJson(JSON.parse(JSON.stringify(positive.events))));
  });
});

describe('public TypeScript contract', () => {
  it('keeps envelope and request types JSON-safe', () => {
    const request: SimulationRequestV1 = positive.requests.spice as SimulationRequestV1;
    const failure: FailureEnvelopeV1 = {
      apiVersion: '1', ok: false, requestId: 'req-1',
      error: { code: 'CANCELLED', message: 'cancelled', retryable: true, phase: 'solve', details: {} },
      diagnostics: [],
    };
    const terminal: StreamTerminalV1 = { ...failure, partial: { status: 'partial', analyses: [], partialEventSha256: hash } };
    expect(request.apiVersion).toBe('1');
    expect(terminal.partial.status).toBe('partial');
  });

  it('ships every registered schema as a JSON document', () => {
    for (const [name, schema] of Object.entries(protocolSchemasV1)) {
      const path = fileURLToPath(new URL(`../../../protocol/schemas/${name}.schema.json`, import.meta.url));
      const shipped = JSON.parse(readFileSync(path, 'utf8'));
      expect(shipped.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(shipped).toEqual(schema);
    }
  });
});
