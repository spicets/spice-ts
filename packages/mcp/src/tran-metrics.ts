import type { SimulationResultV1 } from '@spice-ts/core/protocol';

export interface TranMetricsArgs {
  signal: string;
  analysis?: number;
  step?: number;
  initialValue?: number;
  finalValue?: number;
  settlingBandPercent?: number;
}
export interface TranMetrics {
  initialValue: number; finalValue: number; unit: 'V' | 'A';
  riseTimeS: number | null; fallTimeS: number | null;
  maxRiseSlewPerS: number; maxFallSlewPerS: number; slewUnit: 'V/s' | 'A/s';
  overshootPercent: number; undershootPercent: number;
  settlingTimeS: number; peakValue: number; peakTimeS: number;
}
const codes = ['NOT_TRANSIENT', 'UNKNOWN_STEP', 'SIGNAL_NOT_FOUND', 'NO_TRANSITION', 'NOT_SETTLED', 'INVALID_DATA'] as const;
type MetricsError = { error: { code: typeof codes[number]; message: string } };
const metricNames = ['initialValue', 'finalValue', 'riseTimeS', 'fallTimeS', 'overshootPercent', 'undershootPercent', 'settlingTimeS', 'peakValue', 'peakTimeS', 'maxRiseSlewPerS', 'maxFallSlewPerS'] as const;
export const tranMetricsProperties = {
  signal: { type: 'string', minLength: 1, maxLength: 256 },
  analysis: { type: 'integer', minimum: 0 },
  step: { type: 'integer', minimum: 0 },
  initialValue: { type: 'number' }, finalValue: { type: 'number' },
  settlingBandPercent: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100, default: 2 },
};
export const tranMetricsOutputSchemas = [
  {
    type: 'object', required: [...metricNames, 'unit', 'slewUnit'], additionalProperties: false,
    properties: {
      ...Object.fromEntries(metricNames.map(key => [key, { type: key === 'riseTimeS' || key === 'fallTimeS' ? ['number', 'null'] : 'number' }])),
      unit: { enum: ['V', 'A'] },
      slewUnit: { enum: ['V/s', 'A/s'] },
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
    || ['initialValue', 'finalValue', 'settlingBandPercent'].some(key => a[key] !== undefined && (typeof a[key] !== 'number' || !Number.isFinite(a[key])))
    || (a.settlingBandPercent !== undefined && ((a.settlingBandPercent as number) <= 0 || (a.settlingBandPercent as number) >= 100))) {
    throw { code: 'INVALID_REQUEST', message: 'Expected signal, optional nonnegative integer analysis and step, finite endpoint values and settlingBandPercent between 0 and 100', phase: 'validation', retryable: false, details: {} };
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
  const x = a.timeS;
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
  const low = crossing(0.1); const high = crossing(0.9);
  if (low === undefined || high === undefined || high < low) return error('NO_TRANSITION', 'No ordered 10% and 90% crossings in the sampled interval');
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
  return metrics;
}
