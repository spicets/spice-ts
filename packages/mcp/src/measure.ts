import type { AnalysisResultV1, SimulationResultV1 } from '@spice-ts/core/protocol';

const kinds = ['min', 'max', 'avg', 'rms', 'pp', 'at', 'cross', 'when'] as const;
type Measurement = {
  kind: typeof kinds[number]; signal: string; analysis: number; step?: number;
  from?: number; to?: number; at?: number; value?: number;
  edge?: 'rising' | 'falling' | 'either';
};
type MeasurementErrorCode = 'INVALID_MEASUREMENT' | 'UNKNOWN_SIGNAL' | 'UNKNOWN_ANALYSIS' | 'AMBIGUOUS_ANALYSIS' | 'UNKNOWN_STEP' | 'OUT_OF_RANGE' | 'NO_CROSSING' | 'NON_FINITE_RESULT';
type MeasurementResult = { value: number; unit: string } | { error: { code: MeasurementErrorCode; message: string } };

export const measurementListSchema = {
  type: 'array', minItems: 1, maxItems: 128,
  items: {
    type: 'object', required: ['kind', 'signal', 'analysis'], additionalProperties: false,
    properties: {
      kind: { enum: kinds }, signal: { type: 'string', minLength: 1, maxLength: 256 },
      analysis: { type: 'integer', minimum: 0 },
      step: { type: 'integer', minimum: 0, description: 'Zero-based step.index from SimulationResultV1; use 0 for an unstepped analysis.' },
      ...Object.fromEntries(['from', 'to', 'at', 'value'].map(key => [key, { type: 'number' }])),
      edge: { enum: ['rising', 'falling', 'either'] },
    },
  },
};

function error(code: MeasurementErrorCode, message: string): MeasurementResult {
  return { error: { code, message } };
}

function valid(value: unknown): value is Measurement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Measurement;
  return kinds.includes(m.kind) && typeof m.signal === 'string' && m.signal.length > 0 && m.signal.length <= 256
    && Number.isInteger(m.analysis) && m.analysis >= 0
    && (m.step === undefined || (Number.isInteger(m.step) && m.step >= 0))
    && ['from', 'to', 'at', 'value'].every(key => {
      const n = (m as unknown as Record<string, unknown>)[key];
      return n === undefined || (typeof n === 'number' && Number.isFinite(n));
    })
    && Object.keys(m).every(key => ['kind', 'signal', 'analysis', 'step', 'from', 'to', 'at', 'value', 'edge'].includes(key))
    && (m.edge === undefined || ['rising', 'falling', 'either'].includes(m.edge))
    && (m.from === undefined || m.to === undefined || m.from <= m.to)
    && (m.kind !== 'at' || m.at !== undefined)
    && (!['cross', 'when'].includes(m.kind) || m.value !== undefined);
}

function series(a: AnalysisResultV1, signal: string): { x: number[]; y: number[]; unit: string; axisUnit: string } | undefined {
  if (a.type === 'tf') return undefined;
  const match = /^(?:(db|mag)\()?([vi])\(([^()]+)\)\)?$/i.exec(signal);
  if (!match) return undefined;
  const [, transform, quantity, name] = match;
  // Only AC phasors have magnitude / dB projections.
  if (transform && (a.type !== 'ac' || !signal.endsWith('))'))) return undefined;
  if (!transform && signal.endsWith('))')) return undefined;
  const voltage = quantity.toLowerCase() === 'v';
  const values = a.type === 'ac'
    ? (voltage ? a.voltagePhasors : a.currentPhasors)
    : (voltage ? a.voltagesV : a.currentsA);
  const key = Object.keys(values).find(key => key.toLowerCase() === name.toLowerCase());
  if (key === undefined) return undefined;
  const y = a.type === 'ac'
    ? (voltage ? a.voltagePhasors : a.currentPhasors)[key].map(p => transform?.toLowerCase() === 'db' ? 20 * Math.log10(p.magnitude) : p.magnitude)
    : a.type === 'op' ? [(voltage ? a.voltagesV : a.currentsA)[key]] : (voltage ? a.voltagesV : a.currentsA)[key];
  return {
    x: a.type === 'ac' ? a.frequencyHz : a.type === 'tran' ? a.timeS : a.type === 'dc' ? a.axis.values : [0],
    y, unit: transform?.toLowerCase() === 'db' ? 'dB' : voltage ? 'V' : 'A',
    axisUnit: a.type === 'ac' ? 'Hz' : a.type === 'tran' ? 's' : a.type === 'dc' ? a.axis.unit : '',
  };
}

/** Scalar-only reduction of a bounded simulation. Each measurement fails independently. */
export function measureResult(result: SimulationResultV1, measurements: unknown[]): { measurements: MeasurementResult[] } {
  return { measurements: measurements.map(raw => {
    if (!valid(raw)) return error('INVALID_MEASUREMENT', 'Invalid measurement fields');
    const m = raw;
    const analyses = result.analyses.filter(a => a.analysisIndex === m.analysis);
    if (!analyses.length) return error('UNKNOWN_ANALYSIS', 'No analysis with this index');
    if (m.step === undefined && analyses.length !== 1) return error('AMBIGUOUS_ANALYSIS', `Analysis has ${analyses.length} steps; select a zero-based step index`);
    const analysis = m.step === undefined ? analyses[0] : analyses.find(a => (a.step?.index ?? 0) === m.step);
    if (!analysis) return error('UNKNOWN_STEP', 'No step with this index in the selected analysis');
    const data = series(analysis, m.signal);
    if (!data) return error('UNKNOWN_SIGNAL', 'Signal or projection is unavailable');
    let { x, y } = data;
    if (!x.length || x.length !== y.length || ![...x, ...y].every(Number.isFinite)) return error('NON_FINITE_RESULT', 'Signal has empty or non-finite data');
    if (x.length > 1 && x[0] > x[x.length - 1]) { x = [...x].reverse(); y = [...y].reverse(); }
    if (x.some((v, i) => i > 0 && v <= x[i - 1])) return error('INVALID_MEASUREMENT', 'Analysis axis must be strictly monotonic');
    const lo = m.from ?? x[0];
    const hi = m.to ?? x[x.length - 1];
    if (lo < x[0] || hi > x[x.length - 1] || lo > hi || (m.at !== undefined && (m.at < lo || m.at > hi))) return error('OUT_OF_RANGE', 'Measurement lies outside the analysis window');
    const interpolate = (at: number): number => {
      let left = 0; let right = x.length - 1;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (x[middle] < at) left = middle + 1;
        else right = middle;
      }
      const i = left;
      if (i === 0 || x[i] === at) return y[i];
      return y[i - 1] + (y[i] - y[i - 1]) * ((at - x[i - 1]) / (x[i] - x[i - 1]));
    };
    if (m.kind === 'at') return { value: interpolate(m.at!), unit: data.unit };
    const points = [lo, ...x.filter(v => v > lo && v < hi), ...(hi > lo ? [hi] : [])];
    const samples = points.map(interpolate);
    let value: number;
    let unit = data.unit;
    if (m.kind === 'cross' || m.kind === 'when') {
      unit = data.axisUnit;
      if (!unit) return error('INVALID_MEASUREMENT', 'Crossings require a swept analysis');
      const target = m.value!;
      const i = samples.findIndex((v, i) => {
        if (i === 0) return false;
        const prev = samples[i - 1];
        const rising = prev < target && v >= target;
        const falling = prev > target && v <= target;
        return m.edge === 'rising' ? rising : m.edge === 'falling' ? falling : rising || falling;
      });
      if (i < 0) return error('NO_CROSSING', 'No crossing in the selected window');
      value = points[i - 1] + (points[i] - points[i - 1]) * ((target - samples[i - 1]) / (samples[i] - samples[i - 1]));
    } else if (m.kind === 'min' || m.kind === 'max' || m.kind === 'pp') {
      const min = samples.reduce((a, b) => Math.min(a, b));
      const max = samples.reduce((a, b) => Math.max(a, b));
      value = m.kind === 'min' ? min : m.kind === 'max' ? max : max - min;
    } else if (hi === lo) {
      value = m.kind === 'rms' ? Math.abs(samples[0]) : samples[0];
    } else {
      let integral = 0;
      for (let i = 1; i < points.length; i++) {
        const a = samples[i - 1]; const b = samples[i];
        integral += (points[i] - points[i - 1]) * (m.kind === 'rms' ? (a * a + a * b + b * b) / 3 : (a + b) / 2);
      }
      value = m.kind === 'rms' ? Math.sqrt(integral / (hi - lo)) : integral / (hi - lo);
    }
    return Number.isFinite(value) ? { value, unit } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
  }) };
}
