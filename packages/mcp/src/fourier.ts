import { ngspiceFourier, type FourierResult } from '@spice-ts/core';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

export interface FourierArgs {
  signal: string;
  fundamentalHz: number;
  harmonicCount?: number;
  analysis?: number;
  step?: number;
  windowStartS?: number;
}
interface FourierMetrics {
  dc: number;
  unit: 'V' | 'A';
  thdPercent: number;
  harmonics: FourierResult['harmonics'];
}
const codes = ['UNKNOWN_SIGNAL', 'NO_TRANSIENT', 'UNKNOWN_STEP', 'AMBIGUOUS_ANALYSIS', 'INSUFFICIENT_PERIOD', 'INVALID_DATA'] as const;
type FourierError = { error: { code: typeof codes[number]; message: string } };
export const fourierProperties = {
  signal: { type: 'string', minLength: 1, maxLength: 256 },
  fundamentalHz: { type: 'number', exclusiveMinimum: 0 },
  harmonicCount: { type: 'integer', minimum: 1, maximum: 64, default: 9 },
  analysis: { type: 'integer', minimum: 0 },
  step: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  windowStartS: { type: 'number', minimum: 0 },
};
const rowProperties = Object.fromEntries(['harmonic', 'frequency', 'magnitude', 'phase', 'normalizedMagnitude', 'normalizedPhase'].map(key => [key, { type: 'number' }]));
export const fourierOutputSchemas = [
  {
    type: 'object', required: ['dc', 'unit', 'thdPercent', 'harmonics'], additionalProperties: false,
    properties: {
      dc: { type: 'number' }, unit: { enum: ['V', 'A'] }, thdPercent: { type: 'number' },
      harmonics: { type: 'array', minItems: 1, maxItems: 64, items: {
        type: 'object', required: Object.keys(rowProperties), additionalProperties: false, properties: rowProperties,
      } },
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

export function fourierArgs(raw: unknown): FourierArgs {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a)
    || Object.keys(a).some(key => !['request', ...Object.keys(fourierProperties)].includes(key))
    || typeof a.signal !== 'string' || !a.signal.length || a.signal.length > 256
    || typeof a.fundamentalHz !== 'number' || !Number.isFinite(a.fundamentalHz) || a.fundamentalHz <= 0
    || (a.harmonicCount !== undefined && (!Number.isInteger(a.harmonicCount) || (a.harmonicCount as number) < 1 || (a.harmonicCount as number) > 64))
    || (a.analysis !== undefined && (!Number.isInteger(a.analysis) || (a.analysis as number) < 0))
    || (a.step !== undefined && (!Number.isSafeInteger(a.step) || (a.step as number) < 0))
    || (a.windowStartS !== undefined && (typeof a.windowStartS !== 'number' || !Number.isFinite(a.windowStartS) || a.windowStartS < 0))) {
    throw { code: 'INVALID_REQUEST', message: 'Expected signal, positive finite fundamentalHz, harmonicCount 1 through 64, optional nonnegative integer analysis and step, and windowStartS', phase: 'validation', retryable: false, details: {} };
  }
  return a as unknown as FourierArgs;
}

const error = (code: FourierError['error']['code'], message: string): FourierError => ({ error: { code, message } });

/** ngspice .four defaults: last complete period, 200-point grid, linear interpolation. */
export function fourierMetrics(result: SimulationResultV1, args: FourierArgs): FourierMetrics | FourierError {
  const selected = result.analyses.filter(a => args.analysis === undefined ? a.type === 'tran' : a.analysisIndex === args.analysis);
  if (!selected.length || selected.some(a => a.type !== 'tran')) return error('NO_TRANSIENT', 'Select a transient analysis');
  if (new Set(selected.map(a => a.analysisIndex)).size !== 1) return error('AMBIGUOUS_ANALYSIS', 'Select exactly one transient analysis');
  const traces = args.step === undefined ? selected : selected.filter(a => (a.step?.index ?? 0) === args.step);
  if (!traces.length) return error('UNKNOWN_STEP', 'No transient trace has the requested step index');
  if (traces.length !== 1 || traces[0].type !== 'tran') return error('AMBIGUOUS_ANALYSIS', 'Select exactly one transient step');
  const a = traces[0];
  const match = /^([vi])\(([^()]+)\)$/i.exec(args.signal);
  const values = match?.[1].toLowerCase() === 'v' ? a.voltagesV : a.currentsA;
  const lookup = (name: string) => Object.keys(values).find(key => key.toLowerCase() === name.toLowerCase());
  const key = match && lookup(match[2]);
  const x = a.timeS;
  let y: number[] | undefined = key == null ? undefined : values[key];
  let operands: [number[], number[]] | undefined;
  if (!y && match?.[1].toLowerCase() === 'v') {
    const terminals = match[2].split(',').map(name => name.trim());
    if (terminals.length === 2 && terminals.every(Boolean)) {
      const resolve = (name: string) => {
        if (/^(0|gnd)$/i.test(name)) return x.map(() => 0);
        const found = lookup(name);
        return found === undefined ? undefined : values[found];
      };
      const positive = resolve(terminals[0]); const negative = resolve(terminals[1]);
      if (positive && negative) {
        if (positive.length !== x.length || negative.length !== x.length) return error('INVALID_DATA', 'Expected at least two finite aligned samples and strictly increasing times');
        y = positive.map((v, i) => v - negative[i]);
        operands = [positive, negative];
      }
    }
  }
  if (!y) return error('UNKNOWN_SIGNAL', 'Expected an existing v(node) or i(branch) signal');
  if (x.length < 2 || x.length !== y.length || y.some(v => !Number.isFinite(v))
    || x.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= x[i - 1]))) return error('INVALID_DATA', 'Expected at least two finite aligned samples and strictly increasing times');
  const start = x[x.length - 1] - 1 / args.fundamentalHz;
  if (!Number.isFinite(start) || start < Math.max(x[0], args.windowStartS ?? x[0])) return error('INSUFFICIENT_PERIOD', 'The requested window must contain the full last period');
  if (operands) {
    // Check only the measured period and the sample needed to interpolate its start.
    const first = x.findIndex(t => t >= start);
    const from = Math.max(0, first - (x[first] > start ? 1 : 0));
    const [positive, negative] = operands;
    // Compare against the least uncertain sample, so a large common-mode
    // operand at any one point cannot mask resolved changes at other points.
    const scale = (i: number) => Math.max(Math.abs(positive[i]), Math.abs(negative[i]));
    let reference = from;
    for (let i = from + 1; i < x.length; i++) if (scale(i) < scale(reference)) reference = i;
    const roundoff = y.every((v, i) => i < from || Math.abs(v - y![reference]) <= Number.EPSILON * Math.max(scale(i), scale(reference)));
    if (roundoff) return error('INVALID_DATA', 'Fourier arithmetic is non-finite, or the fundamental is zero');
  }
  // Retain pre-window samples as interpolation support, just like the core command.
  try {
    const table = ngspiceFourier(args.signal, Float64Array.from(x), Float64Array.from(y), args.fundamentalHz, (args.harmonicCount ?? 9) + 1, 200, 1, 1);
    const harmonics = table.harmonics.slice(1);
    if (!Number.isFinite(table.thd) || table.harmonics.some(row => Object.values(row).some(v => !Number.isFinite(v)))) return error('INVALID_DATA', 'Fourier arithmetic is non-finite, or the fundamental is zero');
    return { dc: table.harmonics[0].magnitude, unit: match![1].toLowerCase() === 'v' ? 'V' : 'A', thdPercent: table.thd, harmonics };
  } catch {
    return error('INVALID_DATA', 'Cannot interpolate the transient signal');
  }
}
