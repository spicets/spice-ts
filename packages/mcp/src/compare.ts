import type { SimulationResultV1 } from '@spice-ts/core/protocol';

type Phasor = { magnitude: number; phaseDegrees: number };
type SignalSet = { x: number[]; signals: Record<string, (number | Phasor)[]>; axisUnit?: string };
type Metrics = { maxAbsError: number; maxRelError: number | null; xAtWorstError: number; firstExceededX: number | null; pass: boolean };
type Comparison = Metrics & { signal: string; phase?: Metrics };
type ErrorCode = 'INVALID_REQUEST' | 'AXIS_MISMATCH' | 'UNKNOWN_SIGNAL' | 'NON_MONOTONIC_AXIS' | 'EMPTY_OVERLAP' | 'UNKNOWN_ANALYSIS' | 'AMBIGUOUS_ANALYSIS' | 'UNKNOWN_STEP' | 'RESOURCE_LIMIT';
class ComparisonError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}
const fail = (code: ErrorCode, message: string): never => { throw new ComparisonError(code, message); };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const wrapped = (degrees: number) => ((degrees % 360) + 540) % 360 - 180;

const numbers = { type: 'array', items: { type: 'number' } };
const sourceSchema = {
  oneOf: [
    { type: 'object', required: ['x', 'signals'], additionalProperties: false, properties: {
      x: numbers, axisUnit: { type: 'string' }, signals: { type: 'object', additionalProperties: { type: 'array', items: { oneOf: [
        { type: 'number' }, { type: 'object', required: ['magnitude', 'phaseDegrees'], additionalProperties: false, properties: { magnitude: { type: 'number', minimum: 0 }, phaseDegrees: { type: 'number' } } },
      ] } } },
    } },
    { type: 'object', required: ['result', 'analysis'], additionalProperties: false, properties: { result: { $ref: '#/$defs/simulationResult' }, analysis: { type: 'integer', minimum: 0 }, step: { type: 'integer', minimum: 0 } } },
    { type: 'object', required: ['jobId', 'analysis'], additionalProperties: false, properties: { jobId: { type: 'string', minLength: 1 }, analysis: { type: 'integer', minimum: 0 }, step: { type: 'integer', minimum: 0 } } },
  ],
};
export const compareInputSchema = {
  type: 'object' as const, required: ['reference', 'actual', 'signals'], additionalProperties: false,
  properties: {
    reference: sourceSchema, actual: sourceSchema,
    signals: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } },
    absTolerance: { type: 'number', minimum: 0 }, relTolerance: { type: 'number', minimum: 0 }, phaseToleranceDegrees: { type: 'number', minimum: 0 },
  },
};

const metricProperties = {
  maxAbsError: { type: 'number', minimum: 0 }, maxRelError: { type: ['number', 'null'], minimum: 0 },
  xAtWorstError: { type: 'number' }, firstExceededX: { type: ['number', 'null'] }, pass: { type: 'boolean' },
};
export const compareOutputSchema = {
  type: 'object' as const, required: ['pass', 'overlap', 'pointsCompared', 'comparisons'], additionalProperties: false,
  properties: {
    pass: { type: 'boolean' }, overlap: { ...numbers, minItems: 2, maxItems: 2 }, pointsCompared: { type: 'integer', minimum: 1 },
    comparisons: { type: 'array', minItems: 1, maxItems: 128, items: {
      type: 'object', required: ['signal', ...Object.keys(metricProperties)], additionalProperties: false,
      properties: { signal: { type: 'string' }, ...metricProperties, phase: {
        type: 'object', required: Object.keys(metricProperties), additionalProperties: false, properties: metricProperties,
      } },
    } },
  },
};

function source(value: unknown, resolveJob: (id: string) => SimulationResultV1): SignalSet {
  if (!record(value)) return fail('INVALID_REQUEST', 'Expected a signal set or result reference');
  if ('result' in value || 'jobId' in value) {
    if (!fields(value, ['result', 'jobId', 'analysis', 'step']) || ('result' in value) === ('jobId' in value)
      || !Number.isInteger(value.analysis) || (value.analysis as number) < 0
      || (value.step !== undefined && (!Number.isInteger(value.step) || (value.step as number) < 0))) return fail('INVALID_REQUEST', 'Expected exactly one result or jobId and nonnegative integer analysis and step indices');
    if ('jobId' in value && (typeof value.jobId !== 'string' || !value.jobId)) return fail('INVALID_REQUEST', 'Expected a job id');
    const result = 'jobId' in value ? resolveJob(value.jobId as string) : value.result;
    if (!record(result) || result.status !== 'complete' || !Array.isArray(result.analyses)) return fail('INVALID_REQUEST', 'Expected a complete protocol-v1 result');
    const analyses = result.analyses.filter(a => record(a) && a.analysisIndex === value.analysis);
    if (!analyses.length) return fail('UNKNOWN_ANALYSIS', 'No analysis with this index');
    if (value.step === undefined && analyses.length !== 1) return fail('AMBIGUOUS_ANALYSIS', 'Select a zero-based step index');
    const a = value.step === undefined ? analyses[0] : analyses.find(a => (a.step?.index ?? 0) === value.step);
    if (!a) return fail('UNKNOWN_STEP', 'No step with this index in the selected analysis');
    if (!['op', 'dc', 'tran', 'ac'].includes(a.type)) return fail('INVALID_REQUEST', 'Unknown analysis type');
    const ac = a.type === 'ac';
    const signals: Record<string, unknown> = Object.create(null);
    for (const [prefix, values] of [['v', ac ? a.voltagePhasors : a.voltagesV], ['i', ac ? a.currentPhasors : a.currentsA]] as const) {
      if (!record(values)) return fail('INVALID_REQUEST', 'Invalid analysis signal records');
      for (const [name, y] of Object.entries(values)) signals[`${prefix}(${name})`] = a.type === 'op' ? [y] : y;
    }
    return source({ x: ac ? a.frequencyHz : a.type === 'tran' ? a.timeS : a.type === 'dc' ? a.axis?.values : [0], signals,
      axisUnit: ac ? 'Hz' : a.type === 'tran' ? 's' : a.type === 'dc' ? a.axis?.unit : '' }, resolveJob);
  }
  if (!fields(value, ['x', 'signals', 'axisUnit']) || !Array.isArray(value.x) || !value.x.every(finite) || !record(value.signals)
    || (value.axisUnit !== undefined && typeof value.axisUnit !== 'string')) return fail('INVALID_REQUEST', 'Invalid finite axis or signal map');
  const x = value.x as number[];
  if (!x.length) return fail('EMPTY_OVERLAP', 'Axis is empty');
  if (x.some((v, i) => i > 0 && v <= x[i - 1])) return fail('NON_MONOTONIC_AXIS', 'Axis must be strictly increasing');
  for (const y of Object.values(value.signals)) {
    if (!Array.isArray(y) || y.length !== x.length) return fail('AXIS_MISMATCH', 'Signal length differs from its axis');
    if (!y.every(v => finite(v) || (record(v) && fields(v, ['magnitude', 'phaseDegrees']) && finite(v.magnitude) && v.magnitude >= 0 && finite(v.phaseDegrees)))) return fail('INVALID_REQUEST', 'Signal values must be finite numbers or polar phasors');
    if (y.some(v => typeof v !== typeof y[0])) return fail('AXIS_MISMATCH', 'Cannot mix real and complex samples');
  }
  return value as SignalSet;
}

function interpolate(x: number[], y: number[], at: number): number {
  let lo = 0; let hi = x.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (x[mid] < at) lo = mid + 1; else hi = mid; }
  if (x[lo] === at || lo === 0) return y[lo];
  const weight = (at - x[lo - 1]) / (x[lo] - x[lo - 1]);
  return y[lo - 1] * (1 - weight) + y[lo] * weight;
}
function phases(y: Phasor[]): number[] {
  const values = [wrapped(y[0].phaseDegrees)];
  for (let i = 1; i < y.length; i++) values.push(values[i - 1] + wrapped(wrapped(y[i].phaseDegrees) - wrapped(y[i - 1].phaseDegrees)));
  return values;
}
function metrics(x: number[], reference: number[], actual: number[], abs: number, rel: number, phase = false): Metrics {
  const peak = reference.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  let maxAbsError = 0; let xAtWorstError = x[0]; let firstExceededX: number | null = null;
  for (let i = 0; i < x.length; i++) {
    const error = Math.abs(phase ? wrapped(actual[i] - reference[i]) : actual[i] - reference[i]);
    if (!finite(error)) return fail('INVALID_REQUEST', 'Comparison overflowed finite arithmetic');
    if (error > maxAbsError) { maxAbsError = error; xAtWorstError = x[i]; }
    if (firstExceededX === null && error > abs + rel * peak) firstExceededX = x[i];
  }
  const relative = peak === 0 ? (maxAbsError === 0 ? 0 : null) : maxAbsError / peak;
  return { maxAbsError, maxRelError: relative !== null && !finite(relative) ? null : relative, xAtWorstError, firstExceededX, pass: firstExceededX === null };
}

/** Compare only union samples in the common window. Never extrapolate. */
export function compareSignals(args: unknown, resolveJob: (id: string) => SimulationResultV1, maxPoints: number) {
  try {
    if (!record(args) || !fields(args, ['reference', 'actual', 'signals', 'absTolerance', 'relTolerance', 'phaseToleranceDegrees'])
      || !Array.isArray(args.signals) || args.signals.length < 1 || args.signals.length > 128
      || !args.signals.every(s => typeof s === 'string' && s.length > 0 && s.length <= 256) || new Set(args.signals).size !== args.signals.length
      || !['absTolerance', 'relTolerance', 'phaseToleranceDegrees'].every(k => args[k] === undefined || (finite(args[k]) && args[k] >= 0))) return fail('INVALID_REQUEST', 'Invalid signal selection or nonnegative tolerances');
    const reference = source(args.reference, resolveJob); const actual = source(args.actual, resolveJob);
    if (reference.axisUnit !== undefined && actual.axisUnit !== undefined && reference.axisUnit !== actual.axisUnit) return fail('AXIS_MISMATCH', 'Axis units differ');
    const lo = Math.max(reference.x[0], actual.x[0]); const hi = Math.min(reference.x.at(-1)!, actual.x.at(-1)!);
    if (lo > hi) return fail('EMPTY_OVERLAP', 'Axes have no common window');
    const x = [...new Set([...reference.x, ...actual.x].filter(v => v >= lo && v <= hi))].sort((a, b) => a - b);
    if (x.length * args.signals.length > maxPoints) return fail('RESOURCE_LIMIT', 'Comparison exceeds maxResultPoints');
    const comparisons: Comparison[] = args.signals.map(signal => {
      if (!Object.hasOwn(reference.signals, signal) || !Object.hasOwn(actual.signals, signal)) return fail('UNKNOWN_SIGNAL', `Signal ${signal} is unavailable`);
      const r = reference.signals[signal]; const a = actual.signals[signal];
      if (typeof r[0] !== typeof a[0]) return fail('AXIS_MISMATCH', 'Real and complex signals cannot be compared');
      const complex = typeof r[0] !== 'number';
      const ry = r.map(v => typeof v === 'number' ? v : v.magnitude); const ay = a.map(v => typeof v === 'number' ? v : v.magnitude);
      const comparison: Comparison = { signal, ...metrics(x, x.map(v => interpolate(reference.x, ry, v)), x.map(v => interpolate(actual.x, ay, v)), args.absTolerance as number ?? 0, args.relTolerance as number ?? 0) };
      if (complex) {
        const rp = phases(r as Phasor[]); const ap = phases(a as Phasor[]);
        comparison.phase = metrics(x, x.map(v => interpolate(reference.x, rp, v)), x.map(v => interpolate(actual.x, ap, v)), args.phaseToleranceDegrees as number ?? 0, 0, true);
        comparison.pass &&= comparison.phase.pass;
      }
      return comparison;
    });
    return { pass: comparisons.every(c => c.pass), overlap: [lo, hi], pointsCompared: x.length, comparisons };
  } catch (error) {
    if (!(error instanceof ComparisonError)) throw error;
    return { error: { code: error.code, message: error.message, phase: 'validation' as const, retryable: false, details: {} } };
  }
}
