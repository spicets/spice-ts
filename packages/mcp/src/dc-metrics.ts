import type { SimulationResultV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';

type DcMetricsInput = { sweptSource: string; output: string; input?: string };
type Metric = { value: number | null; unit: string; reason?: string };
type GainMetric = Metric & { input?: number; sweepPoint?: number };
type DcMetrics = Record<'switchingThreshold' | 'voh' | 'vol' | 'vil' | 'vih' | 'nmL' | 'nmH', Metric> & {
  gainMax: GainMetric; monotonic: boolean;
};

const voltagePattern = '^[vV]\\(\\s*[^\\s(),](?:[^(),]*[^\\s(),])?\\s*(?:,\\s*[^\\s(),](?:[^(),]*[^\\s(),])?\\s*)?\\)$';
export const dcMetricsProperties = {
  sweptSource: { type: 'string', minLength: 1, maxLength: 256 },
  output: { type: 'string', minLength: 1, maxLength: 256, pattern: voltagePattern, description: 'Voltage expression v(node) or v(positive,negative).' },
  input: { type: 'string', minLength: 1, maxLength: 256, pattern: voltagePattern, description: 'Voltage expression v(node) or v(positive,negative); defaults to the voltage sweep.' },
};
const metricSchema = {
  type: 'object', required: ['value', 'unit'], additionalProperties: false,
  properties: { value: { type: ['number', 'null'] }, unit: { type: 'string' }, reason: { type: 'string' } },
};
export const dcMetricsOutputSchema = {
  type: 'object', additionalProperties: false,
  required: ['gainMax', 'switchingThreshold', 'voh', 'vol', 'vil', 'vih', 'nmL', 'nmH', 'monotonic'],
  properties: {
    ...Object.fromEntries(['switchingThreshold', 'voh', 'vol', 'vil', 'vih', 'nmL', 'nmH'].map(key => [key, metricSchema])),
    gainMax: { ...metricSchema, properties: { ...metricSchema.properties, input: { type: 'number' }, sweepPoint: { type: 'number' } } },
    monotonic: { type: 'boolean' },
  },
};
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, retryable: false, phase: 'validation', details: {} } satisfies SpiceApiErrorV1;
}
export function dcMetricsInput(args: unknown): DcMetricsInput {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Expected DC metric arguments');
  const fields = args as Record<string, unknown>;
  if (Object.keys(fields).some(key => !['request', 'sweptSource', 'output', 'input'].includes(key))) invalid('Unknown DC metric argument');
  for (const key of ['sweptSource', 'output', ...(fields.input === undefined ? [] : ['input'])]) {
    if (typeof fields[key] !== 'string' || !fields[key].length || fields[key].length > 256) invalid(`Invalid ${key}`);
  }
  for (const signal of [fields.output, fields.input].filter(v => v !== undefined)) {
    if (!new RegExp(voltagePattern).test(signal as string)) invalid('DC transfer expressions must be v(node) or v(positive,negative)');
  }
  return { sweptSource: fields.sweptSource as string, output: fields.output as string, input: fields.input as string | undefined };
}
const metric = (value: number | null, reason?: string, unit = 'V'): Metric => {
  if (value !== null && !Number.isFinite(value)) return { value: null, unit, reason: 'Non-finite metric' };
  return value === null ? { value, unit, reason: reason ?? 'Undefined metric' } : { value, unit };
};

/** Secant gains live at interval midpoints. Crossings interpolate adjacent samples. */
export function dcMetricsResult(result: SimulationResultV1, input: DcMetricsInput): DcMetrics {
  const matches = result.analyses.filter(a => a.type === 'dc' && a.axis.name.toLowerCase() === input.sweptSource.toLowerCase());
  if (matches.length !== 1) invalid('Expected exactly one DC sweep for sweptSource; split stepped or repeated analyses into separate requests');
  const a = matches[0];
  if (a.type !== 'dc') invalid('Missing DC sweep');
  const sweep = a.axis.values;
  const voltage = (signal: string): number[] => {
    if (!new RegExp(voltagePattern).test(signal)) invalid('DC transfer expressions must be v(node) or v(positive,negative)');
    const names = signal.slice(2, -1).split(',').map(name => name.trim().toLowerCase());
    const vector = (name: string): number[] => {
      if (names.length === 2 && name === '0') return sweep.map(() => 0);
      const key = Object.keys(a.voltagesV).find(key => key.toLowerCase() === name);
      if (key === undefined) invalid(`Unknown voltage signal: ${signal}`);
      const values = a.voltagesV[key];
      if (values.length !== sweep.length || !values.every(Number.isFinite)) invalid('DC metrics require at least two finite aligned samples');
      return values;
    };
    const positive = vector(names[0]);
    if (names.length === 1) return positive;
    const negative = vector(names[1]);
    return positive.map((value, i) => value - negative[i]);
  };
  const x = input.input ? voltage(input.input) : sweep;
  const y = voltage(input.output);
  if (!input.input && a.axis.unit !== 'V') invalid('A current sweep requires an explicit voltage input expression');
  if (x.length < 2 || y.length !== x.length || sweep.length !== x.length || ![...x, ...y, ...sweep].every(Number.isFinite)) invalid('DC metrics require at least two finite aligned samples');
  const direction = Math.sign(x[1] - x[0]);
  if (!direction || x.some((v, i) => i > 0 && Math.sign(v - x[i - 1]) !== direction)) invalid('Input voltage must be strictly monotonic');
  const gains: number[] = []; const mid: number[] = []; let peak = 0;
  let rising = false; let falling = false;
  for (let i = 1; i < x.length; i++) {
    gains.push((y[i] - y[i - 1]) / (x[i] - x[i - 1]));
    mid.push((x[i] + x[i - 1]) / 2);
    if (Math.abs(gains[i - 1]) > Math.abs(gains[peak])) peak = i - 1;
    rising ||= y[i] > y[i - 1]; falling ||= y[i] < y[i - 1];
  }
  const crossings = (axis: number[], values: number[], target: number): number[] => {
    const roots: number[] = [];
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]; const next = values[i];
      // A boundary equality alone is not a transfer crossing (e.g. a divider at zero).
      if ((prev < target && next >= target) || (prev > target && next <= target)) {
        roots.push(axis[i - 1] + (axis[i] - axis[i - 1]) * ((target - prev) / (next - prev)));
      }
    }
    return roots;
  };
  const unity = crossings(mid, gains, -1).sort((a, b) => a - b);
  const vil = unity.length >= 2 ? unity[0] : null;
  const vih = unity.length >= 2 ? unity[unity.length - 1] : null;
  const reason = 'Fewer than two unity-gain crossings';
  return {
    gainMax: { ...metric(Math.abs(gains[peak]), undefined, 'V/V'), input: mid[peak], sweepPoint: (sweep[peak] + sweep[peak + 1]) / 2 },
    switchingThreshold: metric(crossings(x, y.map((v, i) => v - x[i]), 0)[0] ?? null, 'No Vout = Vin crossing'),
    voh: metric(y[0]), vol: metric(y[y.length - 1]),
    vil: metric(vil, reason), vih: metric(vih, reason),
    nmL: metric(vil === null ? null : vil - y[y.length - 1], reason),
    nmH: metric(vih === null ? null : y[0] - vih, reason),
    monotonic: !(rising && falling),
  };
}
