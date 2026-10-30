import type { AnalysisResultV1, SimulationResultV1 } from '@spice-ts/core/protocol';

const kinds = ['min', 'max', 'avg', 'rms', 'pp', 'at', 'cross', 'when', 'integ', 'delay'] as const;
type Crossing = { signal: string; threshold: number; edge?: 'rising' | 'falling' | 'either'; occurrence?: number };
type Measurement = {
  kind: typeof kinds[number]; signal: string; analysis: number; step?: number;
  from?: number; to?: number; at?: number; value?: number;
  edge?: 'rising' | 'falling' | 'either'; occurrence?: number;
  trigger?: Crossing; target?: Crossing;
};
type MeasurementErrorCode = 'INVALID_MEASUREMENT' | 'UNKNOWN_SIGNAL' | 'UNKNOWN_ANALYSIS' | 'AMBIGUOUS_ANALYSIS' | 'UNKNOWN_STEP' | 'OUT_OF_RANGE' | 'NO_CROSSING' | 'NON_FINITE_RESULT';
type MeasurementResult = { value: number; unit: string } | { error: { code: MeasurementErrorCode; message: string } };

export const measurementListSchema = {
  type: 'array', minItems: 1, maxItems: 128,
  items: {
    type: 'object', required: ['kind', 'analysis'], additionalProperties: false,
    allOf: [{
      if: { properties: { kind: { const: 'delay' } } },
      then: { required: ['trigger', 'target'], not: { anyOf: ['signal', 'at', 'value', 'edge'].map(key => ({ required: [key] })) } },
      else: { required: ['signal'], not: { anyOf: ['trigger', 'target'].map(key => ({ required: [key] })) } },
    }, {
      if: { properties: { kind: { enum: ['cross', 'when'] } } },
      else: { not: { required: ['occurrence'] } },
    }],
    properties: {
      kind: { enum: kinds }, signal: { type: 'string', minLength: 1, maxLength: 256 },
      analysis: { type: 'integer', minimum: 0 },
      step: { type: 'integer', minimum: 0, description: 'Zero-based step.index from SimulationResultV1; use 0 for an unstepped analysis.' },
      ...Object.fromEntries(['from', 'to', 'at', 'value'].map(key => [key, { type: 'number' }])),
      edge: { enum: ['rising', 'falling', 'either'] },
      occurrence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'One-based crossing within from/to; defaults to 1.' },
      ...Object.fromEntries(['trigger', 'target'].map(key => [key, {
        type: 'object', description: 'Transient crossing; counted independently within from/to. Delay is target time minus trigger time, in seconds.', required: ['signal', 'threshold'], additionalProperties: false,
        properties: { signal: { type: 'string', minLength: 1, maxLength: 256 }, threshold: { type: 'number' }, edge: { enum: ['rising', 'falling', 'either'], description: 'Defaults to either.' }, occurrence: { type: 'integer', minimum: 1, description: 'One-based crossing number; defaults to 1.' } },
      }])),
    },
  },
};

function error(code: MeasurementErrorCode, message: string): MeasurementResult {
  return { error: { code, message } };
}

function valid(value: unknown): value is Measurement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Measurement;
  const crossingValid = (c: Crossing | undefined): boolean => !!c && typeof c === 'object' && !Array.isArray(c)
    && typeof c.signal === 'string' && c.signal.length > 0 && c.signal.length <= 256
    && typeof c.threshold === 'number' && Number.isFinite(c.threshold)
    && (c.edge === undefined || ['rising', 'falling', 'either'].includes(c.edge))
    && (c.occurrence === undefined || (Number.isSafeInteger(c.occurrence) && c.occurrence > 0))
    && Object.keys(c).every(key => ['signal', 'threshold', 'edge', 'occurrence'].includes(key));
  return kinds.includes(m.kind) && (m.kind === 'delay' ? crossingValid(m.trigger) && crossingValid(m.target) && m.signal === undefined : typeof m.signal === 'string' && m.signal.length > 0 && m.signal.length <= 256 && m.trigger === undefined && m.target === undefined)
    && Number.isInteger(m.analysis) && m.analysis >= 0
    && (m.step === undefined || (Number.isInteger(m.step) && m.step >= 0))
    && ['from', 'to', 'at', 'value'].every(key => {
      const n = (m as unknown as Record<string, unknown>)[key];
      return n === undefined || (typeof n === 'number' && Number.isFinite(n));
    })
    && Object.keys(m).every(key => ['kind', 'signal', 'analysis', 'step', 'from', 'to', 'at', 'value', 'edge', 'occurrence', 'trigger', 'target'].includes(key))
    && (m.kind !== 'delay' || (m.at === undefined && m.value === undefined && m.edge === undefined))
    && (m.occurrence === undefined || (['cross', 'when'].includes(m.kind) && Number.isSafeInteger(m.occurrence) && m.occurrence > 0))
    && (m.edge === undefined || ['rising', 'falling', 'either'].includes(m.edge))
    && (m.from === undefined || m.to === undefined || m.from <= m.to)
    && (m.kind !== 'at' || m.at !== undefined)
    && (!['cross', 'when'].includes(m.kind) || m.value !== undefined);
}

function series(a: AnalysisResultV1, signal: string): { x: number[]; y: number[]; unit: string; axisUnit: string } | undefined {
  if (a.type === 'tf') return undefined;
  const match = /^(?:(db|mag|phase)\()?([vi])\(([^()]+)\)\)?$/i.exec(signal);
  if (!match) return undefined;
  const [, transform, quantity, name] = match;
  // Projections are available only for AC phasors.
  if (transform && (a.type !== 'ac' || !signal.endsWith('))'))) return undefined;
  if (!transform && signal.endsWith('))')) return undefined;
  const voltage = quantity.toLowerCase() === 'v';
  const values = a.type === 'ac'
    ? (voltage ? a.voltagePhasors : a.currentPhasors)
    : (voltage ? a.voltagesV : a.currentsA);
  const key = Object.keys(values).find(key => key.toLowerCase() === name.toLowerCase());
  if (key === undefined) return undefined;
  const projection = transform?.toLowerCase();
  const y = a.type === 'ac'
    ? (voltage ? a.voltagePhasors : a.currentPhasors)[key].map(p => projection === 'phase'
      ? (p.magnitude > 0 && Number.isFinite(p.magnitude) && Number.isFinite(p.phaseDegrees) ? p.phaseDegrees : NaN)
      : projection === 'db' ? 20 * Math.log10(p.magnitude) : p.magnitude)
    : a.type === 'op' ? [(voltage ? a.voltagesV : a.currentsA)[key]] : (voltage ? a.voltagesV : a.currentsA)[key];
  if (a.type === 'ac' && projection === 'phase') {
    const descending = a.frequencyHz.length > 1 && a.frequencyHz[0] > a.frequencyHz[a.frequencyHz.length - 1];
    if (descending) y.reverse();
    for (let i = 1; i < y.length; i++) {
      const delta = y[i] - y[i - 1];
      y[i] = y[i - 1] + ((delta + 180) % 360 + 360) % 360 - 180;
    }
    if (descending) y.reverse();
  }
  return {
    x: a.type === 'ac' ? a.frequencyHz : a.type === 'tran' ? a.timeS : a.type === 'dc' ? a.axis.values : [0],
    y, unit: projection === 'phase' ? 'deg' : projection === 'db' ? 'dB' : voltage ? 'V' : 'A',
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
    if (m.kind === 'delay') {
      if (analysis.type !== 'tran') return error('INVALID_MEASUREMENT', 'Delay requires a transient analysis');
      const crossing = (spec: Crossing): MeasurementResult => {
        const data = series(analysis, spec.signal);
        if (!data) return error('UNKNOWN_SIGNAL', `Signal ${spec.signal} is unavailable`);
        const { x, y } = data;
        if (!x.length || x.length !== y.length || ![...x, ...y].every(Number.isFinite)) return error('NON_FINITE_RESULT', 'Signal has empty or non-finite data');
        if (x.some((v, i) => i > 0 && v <= x[i - 1])) return error('INVALID_MEASUREMENT', 'Analysis axis must be strictly increasing');
        const lo = m.from ?? x[0]; const hi = m.to ?? x[x.length - 1];
        if (lo < x[0] || hi > x[x.length - 1] || lo > hi) return error('OUT_OF_RANGE', 'Measurement lies outside the analysis window');
        let count = 0;
        let initialPlateau = y[0] === spec.threshold;
        for (let i = 1; i < x.length; i++) {
          const rising = y[i - 1] < spec.threshold && y[i] >= spec.threshold;
          const falling = (y[i - 1] > spec.threshold && y[i] <= spec.threshold)
            || (initialPlateau && y[i] < spec.threshold);
          if (y[i] !== spec.threshold) initialPlateau = false;
          if (!(spec.edge === 'rising' ? rising : spec.edge === 'falling' ? falling : rising || falling)) continue;
          const time = x[i - 1] + (x[i] - x[i - 1]) * ((spec.threshold - y[i - 1]) / (y[i] - y[i - 1]));
          if (time < lo || time > hi) continue;
          if (++count === (spec.occurrence ?? 1)) return { value: time, unit: 's' };
        }
        return error('NO_CROSSING', `No crossing for ${spec.signal} in the selected window`);
      };
      const trigger = crossing(m.trigger!);
      if ('error' in trigger) return trigger;
      const target = crossing(m.target!);
      if ('error' in target) return target;
      const value = target.value - trigger.value;
      return Number.isFinite(value) ? { value, unit: 's' } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
    }
    if (m.kind === 'integ' && analysis.type !== 'tran') return error('INVALID_MEASUREMENT', 'Integral requires a transient analysis');
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
    if (m.kind === 'cross' || m.kind === 'when') {
      if (!data.axisUnit) return error('INVALID_MEASUREMENT', 'Crossings require a swept analysis');
      const target = m.value!;
      let count = 0;
      for (let i = 1; i < x.length; i++) {
        const rising = y[i - 1] < target && y[i] >= target;
        const falling = y[i - 1] > target && y[i] <= target;
        if (!(m.edge === 'rising' ? rising : m.edge === 'falling' ? falling : rising || falling)) continue;
        const at = x[i - 1] + (x[i] - x[i - 1]) * ((target - y[i - 1]) / (y[i] - y[i - 1]));
        if (at >= lo && at <= hi && ++count === (m.occurrence ?? 1)) return { value: at, unit: data.axisUnit };
      }
      return error('NO_CROSSING', 'No crossing in the selected window');
    }
    const points = [lo, ...x.filter(v => v > lo && v < hi), ...(hi > lo ? [hi] : [])];
    const samples = points.map(interpolate);
    let value: number;
    let unit = data.unit;
    if (m.kind === 'min' || m.kind === 'max' || m.kind === 'pp') {
      const min = samples.reduce((a, b) => Math.min(a, b));
      const max = samples.reduce((a, b) => Math.max(a, b));
      value = m.kind === 'min' ? min : m.kind === 'max' ? max : max - min;
    } else if (hi === lo) {
      value = m.kind === 'integ' ? 0 : m.kind === 'rms' ? Math.abs(samples[0]) : samples[0];
    } else {
      let integral = 0;
      for (let i = 1; i < points.length; i++) {
        const a = samples[i - 1]; const b = samples[i];
        integral += (points[i] - points[i - 1]) * (m.kind === 'rms' ? (a * a + a * b + b * b) / 3 : (a + b) / 2);
      }
      value = m.kind === 'integ' ? integral : m.kind === 'rms' ? Math.sqrt(integral / (hi - lo)) : integral / (hi - lo);
    }
    if (m.kind === 'integ') unit += '*s';
    return Number.isFinite(value) ? { value, unit } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
  }) };
}
