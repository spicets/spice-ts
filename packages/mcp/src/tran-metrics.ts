import type { SimulationResultV1 } from '@spice-ts/core/protocol';

export interface TranMetricsArgs {
  signal: string;
  analysis?: number;
  step?: number;
  initialValue?: number;
  finalValue?: number;
  settlingBandPercent?: number;
  riseTimePercent?: [number, number];
  timeRangeS?: [number, number];
  includeSignalStatistics?: boolean;
}
export interface TranMetrics {
  initialValue: number; finalValue: number; unit: 'V' | 'A';
  riseTimeS: number | null; fallTimeS: number | null;
  maxRiseSlewPerS: number; maxFallSlewPerS: number; slewUnit: 'V/s' | 'A/s';
  overshootPercent: number; undershootPercent: number;
  settlingTimeS: number; peakValue: number; peakTimeS: number;
  signalStatistics?: { mean: number; rms: number; peakToPeak: number; unit: 'V' | 'A' };
}
const codes = ['NOT_TRANSIENT', 'UNKNOWN_STEP', 'SIGNAL_NOT_FOUND', 'NO_TRANSITION', 'NOT_SETTLED', 'INVALID_DATA'] as const;
type MetricsError = { error: { code: typeof codes[number]; message: string } };
const metricNames = ['initialValue', 'finalValue', 'riseTimeS', 'fallTimeS', 'overshootPercent', 'undershootPercent', 'settlingTimeS', 'peakValue', 'peakTimeS', 'maxRiseSlewPerS', 'maxFallSlewPerS'] as const;
export const tranMetricsProperties = {
  signal: { type: 'string', minLength: 1, maxLength: 256 },
  analysis: { type: 'integer', minimum: 0 },
  step: { type: 'integer', minimum: 0 },
  includeSignalStatistics: { type: 'boolean', default: false },
  timeRangeS: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Increasing simulation-time bounds in seconds, within the selected trace.' },
  initialValue: { type: 'number' }, finalValue: { type: 'number' },
  settlingBandPercent: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100, default: 2 },
  riseTimePercent: { type: 'array', items: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100 }, minItems: 2, maxItems: 2, default: [10, 90], description: 'Low and high transition-normalized percentages, in increasing order, for rise/fall time.' },
};
export const tranMetricsOutputSchemas = [
  {
    type: 'object', required: [...metricNames, 'unit', 'slewUnit'], additionalProperties: false,
    properties: {
      ...Object.fromEntries(metricNames.map(key => [key, { type: key === 'riseTimeS' || key === 'fallTimeS' ? ['number', 'null'] : 'number' }])),
      unit: { enum: ['V', 'A'] },
      slewUnit: { enum: ['V/s', 'A/s'] },
      signalStatistics: {
        type: 'object', required: ['mean', 'rms', 'peakToPeak', 'unit'], additionalProperties: false,
        properties: { mean: { type: 'number' }, rms: { type: 'number' }, peakToPeak: { type: 'number' }, unit: { enum: ['V', 'A'] } },
      },
    },
  },
  {
    type: 'object', required: ['error'], additionalProperties: false,
    properties: { error: {
      type: 'object', required: ['code', 'message'], additionalProperties: false,
      properties: { code: { enum: codes }, message: { type: 'string' } },
    } },
  },
];

export function tranMetricsArgs(raw: unknown): TranMetricsArgs {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a)
    || Object.keys(a).some(key => !['request', ...Object.keys(tranMetricsProperties)].includes(key))
    || typeof a.signal !== 'string' || !a.signal.length || a.signal.length > 256
    || (a.analysis !== undefined && (!Number.isInteger(a.analysis) || (a.analysis as number) < 0))
    || (a.step !== undefined && (!Number.isInteger(a.step) || (a.step as number) < 0))
    || (a.includeSignalStatistics !== undefined && typeof a.includeSignalStatistics !== 'boolean')
    || ['initialValue', 'finalValue', 'settlingBandPercent'].some(key => a[key] !== undefined && (typeof a[key] !== 'number' || !Number.isFinite(a[key])))
    || (a.timeRangeS !== undefined && (!Array.isArray(a.timeRangeS) || a.timeRangeS.length !== 2
      || Array.from(a.timeRangeS).some(value => typeof value !== 'number' || !Number.isFinite(value))
      || a.timeRangeS[0] >= a.timeRangeS[1]))
    || (a.riseTimePercent !== undefined && (!Array.isArray(a.riseTimePercent) || a.riseTimePercent.length !== 2
      || Array.from(a.riseTimePercent).some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 100)
      || a.riseTimePercent[0] >= a.riseTimePercent[1]))
    || (a.settlingBandPercent !== undefined && ((a.settlingBandPercent as number) <= 0 || (a.settlingBandPercent as number) >= 100))) {
    throw { code: 'INVALID_REQUEST', message: 'Expected signal, optional nonnegative integer analysis and step, finite endpoint values, an increasing finite timeRangeS, settlingBandPercent between 0 and 100, and increasing riseTimePercent endpoints between 0 and 100', phase: 'validation', retryable: false, details: {} };
  }
  return a as unknown as TranMetricsArgs;
}

const error = (code: MetricsError['error']['code'], message: string): MetricsError => ({ error: { code, message } });

/** Endpoint levels default to first/last samples; no extrapolation. */
export function tranMetrics(result: SimulationResultV1, args: TranMetricsArgs): TranMetrics | MetricsError {
  const selected = result.analyses.filter(a => args.analysis === undefined ? a.type === 'tran' : a.analysisIndex === args.analysis);
  if (!selected.length || selected.some(a => a.type !== 'tran') || new Set(selected.map(a => a.analysisIndex)).size !== 1) return error('NOT_TRANSIENT', 'Select exactly one transient analysis');
  const traces = args.step === undefined ? selected : selected.filter(a => (a.step?.index ?? 0) === args.step);
  if (!traces.length) return error('UNKNOWN_STEP', 'No transient trace has the requested step index');
  if (traces.length !== 1 || traces[0].type !== 'tran') return error('NOT_TRANSIENT', 'Select exactly one transient trace');
  const a = traces[0];
  const match = /^([vi])\(([^()]+)\)$/i.exec(args.signal);
  const values = match?.[1].toLowerCase() === 'v' ? a.voltagesV : a.currentsA;
  const key = match ? Object.keys(values).find(key => key.toLowerCase() === match[2].toLowerCase()) : undefined;
  let x = a.timeS;
  let y = key === undefined ? undefined : values[key];
  if (!y && match?.[1].toLowerCase() === 'v') {
    const terminals = match[2].split(',').map(name => name.trim());
    if (terminals.length === 2 && terminals.every(Boolean)) {
      const resolve = (name: string): number[] | undefined => {
        if (/^(0|gnd)$/i.test(name)) return x.map(() => 0);
        const found = Object.keys(a.voltagesV).find(node => node.toLowerCase() === name.toLowerCase());
        return found === undefined ? undefined : a.voltagesV[found];
      };
      const positive = resolve(terminals[0]); const negative = resolve(terminals[1]);
      if (positive && negative) {
        if (positive.length !== x.length || negative.length !== x.length
          || !Array.from(positive).every(Number.isFinite) || !Array.from(negative).every(Number.isFinite)) return error('INVALID_DATA', 'Expected finite aligned samples and strictly increasing times');
        y = positive.map((value, i) => value - negative[i]);
      }
    }
  }
  if (!y) return error('SIGNAL_NOT_FOUND', 'Expected an existing v(node) or i(branch) signal');
  if (x.length < 2 || y.length !== x.length || y.some(v => !Number.isFinite(v))
    || x.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= x[i - 1]))) return error('INVALID_DATA', 'Expected finite aligned samples and strictly increasing times');
  if (args.timeRangeS) {
    const [start, end] = args.timeRangeS;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < x[0] || end > x[x.length - 1]) {
      throw { code: 'INVALID_REQUEST', message: 'timeRangeS must be increasing and within the selected transient trace', phase: 'validation', retryable: false, details: {} };
    }
    const sampleAt = (time: number) => {
      const i = x.findIndex(t => t >= time);
      if (x[i] === time) return y![i];
      const fraction = (time - x[i - 1]) / (x[i] - x[i - 1]);
      return y![i - 1] + fraction * (y![i] - y![i - 1]);
    };
    const clippedX = [start]; const clippedY = [sampleAt(start)];
    for (let i = 0; i < x.length; i++) {
      if (x[i] > start && x[i] < end) { clippedX.push(x[i]); clippedY.push(y[i]); }
    }
    clippedX.push(end); clippedY.push(sampleAt(end));
    x = clippedX; y = clippedY;
  }
  const initialValue = args.initialValue ?? y[0]; const finalValue = args.finalValue ?? y[y.length - 1];
  const delta = finalValue - initialValue;
  if (Math.abs(delta) <= Number.EPSILON * 16 * Math.max(Math.abs(initialValue), Math.abs(finalValue))) return error('NO_TRANSITION', 'Initial and final levels do not define a transition');
  const z = y.map(v => (v - initialValue) / delta);
  if (!z.every(Number.isFinite)) return error('INVALID_DATA', 'Normalized response is not finite');
  const interpolate = (i: number, level: number) => x[i - 1] + (x[i] - x[i - 1]) * ((level - z[i - 1]) / (z[i] - z[i - 1]));
  const crossing = (level: number) => {
    for (let i = 1; i < x.length; i++) {
      if (z[i - 1] <= level && z[i] >= level && z[i] > z[i - 1]) return interpolate(i, level);
    }
    return undefined;
  };
  const [lowPercent, highPercent] = args.riseTimePercent ?? [10, 90];
  const low = crossing(lowPercent / 100); const high = crossing(highPercent / 100);
  if (low === undefined || high === undefined || high < low) return error('NO_TRANSITION', `No ordered ${lowPercent}% and ${highPercent}% crossings in the sampled interval`);
  const band = (args.settlingBandPercent ?? 2) / 100;
  let lastOutside = -1; let peak = 0; let minimum = 0;
  for (let i = 0; i < z.length; i++) {
    if (Math.abs(z[i] - 1) > band) lastOutside = i;
    if (z[i] > z[peak]) peak = i;
    if (z[i] < z[minimum]) minimum = i;
  }
  if (lastOutside === x.length - 1) return error('NOT_SETTLED', 'Final sample lies outside the requested settling band');
  const settlingTimeS = lastOutside < 0 ? x[0] : interpolate(lastOutside + 1, z[lastOutside] < 1 ? 1 - band : 1 + band);
  // Require a terminal hold lasting at least 10% of the sampled duration.
  if (settlingTimeS > x[x.length - 1] - (x[x.length - 1] - x[0]) * 0.1) return error('NOT_SETTLED', 'Response did not remain in band for the final 10% of the sampled duration; extend the run or supply a known finalValue');
  let maxRiseSlewPerS = 0; let maxFallSlewPerS = 0;
  for (let i = 1; i < x.length; i++) {
    const dy = y[i] - y[i - 1]; const dt = x[i] - x[i - 1];
    const slope = dy / dt;
    if (!Number.isFinite(dy) || !Number.isFinite(dt) || !Number.isFinite(slope)) return error('INVALID_DATA', 'Slew arithmetic is not finite');
    maxRiseSlewPerS = Math.max(maxRiseSlewPerS, slope);
    maxFallSlewPerS = Math.min(maxFallSlewPerS, slope);
  }
  const metrics: TranMetrics = {
    initialValue, finalValue, unit: match![1].toLowerCase() === 'v' ? 'V' : 'A',
    maxRiseSlewPerS, maxFallSlewPerS, slewUnit: match![1].toLowerCase() === 'v' ? 'V/s' : 'A/s',
    riseTimeS: delta > 0 ? high - low : null, fallTimeS: delta < 0 ? high - low : null,
    overshootPercent: Math.max(0, z[peak] - 1) * 100,
    undershootPercent: Math.max(0, -z[minimum]) * 100,
    settlingTimeS, peakValue: y[peak], peakTimeS: x[peak],
  };
  if (Object.values(metrics).some(v => typeof v === 'number' && !Number.isFinite(v))) return error('INVALID_DATA', 'Metric arithmetic is not finite');
  if (args.includeSignalStatistics) {
    const duration = x[x.length - 1] - x[0];
    let scale = 0; let min = y[0]; let max = y[0];
    for (const value of y) { scale = Math.max(scale, Math.abs(value)); min = Math.min(min, value); max = Math.max(max, value); }
    let mean = 0; let rms = 0;
    if (scale !== 0) {
      for (let i = 1; i < x.length; i++) {
        const rootWeight = Math.sqrt(x[i] - x[i - 1]) / Math.sqrt(duration);
        const left = y[i - 1] / scale; const right = y[i] / scale;
        const midpoint = y[i - 1] + (y[i] - y[i - 1]) / 2;
        mean += (midpoint * rootWeight) * rootWeight;
        // (a² + ab + b²)/3 = ((a+b)/2)² + ((a-b)/sqrt(12))².
        rms = Math.hypot(rms, rootWeight * ((left + right) / 2), (rootWeight / Math.sqrt(12)) * (left - right));
      }
      rms *= scale;
    }
    const peakToPeak = max - min;
    if (![mean, rms, peakToPeak].every(Number.isFinite)) return error('INVALID_DATA', 'Signal statistics arithmetic is not finite');
    metrics.signalStatistics = { mean, rms, peakToPeak, unit: metrics.unit };
  }
  return metrics;
}
