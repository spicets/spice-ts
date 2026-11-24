import type { SimulationResultV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';

type CrossingDirection = 'either' | 'rising' | 'falling';
type DcMetricsInput = { sweptSource: string; output: string; input?: string; analysis?: number; step?: number; sweepPoints?: number[]; includeSpotGain?: boolean; includeSpotResistance?: boolean; outputLevelsV?: number[]; crossingDirection?: CrossingDirection };
type DcSpot = { sweepPoint: number; inputValue: number | null; outputValue: number | null; outOfRange: boolean; gain?: number | null; gainReason?: string };
type LevelCrossing = { outputLevelV: number; sweepPoint: number | null };
type Metric = { value: number | null; unit: string; reason?: string };
type GainMetric = Metric & { input?: number; sweepPoint?: number };
type DcMetrics = Record<'switchingThreshold' | 'voh' | 'vol' | 'vil' | 'vih' | 'nmL' | 'nmH', Metric> & {
  gainMax: GainMetric; monotonic: boolean; spots?: DcSpot[]; levelCrossings?: LevelCrossing[];
};

type ResistanceSpot = { sweepPoint: number; outputValue: number | null; outOfRange: boolean; resistance: Metric };
type ResistanceResult = { resistanceSpots: ResistanceSpot[] };

const voltagePattern = '^[vV]\\([^()]+\\)$';
const differentialPattern = /^[^\s(),](?:[^(),]*[^\s(),])?\s*,\s*[^\s(),](?:[^(),]*[^\s(),])?$/;
export const dcMetricsProperties = {
  sweptSource: { type: 'string', minLength: 1, maxLength: 256 },
  analysis: { type: 'integer', minimum: 0 },
  step: { type: 'integer', minimum: 0 },
  sweepPoints: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'number' }, description: 'Swept-source coordinates in request order; linearly interpolated without extrapolation.' },
  includeSpotGain: { type: 'boolean', description: 'Add V/V local piecewise-linear secant gain, not an analytic derivative. Exact knots use the following interval in sweep traversal, except the final knot uses the preceding interval. Requires sweepPoints. Out-of-range, zero-input-delta and nonrepresentable gains are null with gainReason.' },
  includeSpotResistance: { type: 'boolean', description: 'Return resistanceSpots for an independent current-source sweep. Resistance is a local piecewise-linear dV(output)/dI secant in ohms, not an analytic derivative; I is the signed source value from positive to negative terminal. Requires sweepPoints and excludes input, includeSpotGain, outputLevelsV and crossingDirection. Exact knots use the following traversal interval except the last; outside-range and nonrepresentable values are null with a reason. No extrapolation.' },
  outputLevelsV: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'number' }, description: 'Output voltage levels in request order; first crossing in sweep traversal, without extrapolation.' },
  crossingDirection: { type: 'string', enum: ['either', 'rising', 'falling'], description: 'Direction of output crossing in sweep traversal. Requires outputLevelsV; defaults to either.' },
  output: { type: 'string', minLength: 1, maxLength: 256, pattern: voltagePattern, description: 'Voltage expression v(node) or v(positive,negative).' },
  input: { type: 'string', minLength: 1, maxLength: 256, pattern: voltagePattern, description: 'Voltage expression v(node) or v(positive,negative); defaults to the voltage sweep.' },
};
const metricSchema = {
  type: 'object', required: ['value', 'unit'], additionalProperties: false,
  properties: { value: { type: ['number', 'null'] }, unit: { type: 'string' }, reason: { type: 'string' } },
};
export const dcMetricsOutputSchema = {
  type: 'object', additionalProperties: false,
  anyOf: [{ required: ['gainMax', 'switchingThreshold', 'voh', 'vol', 'vil', 'vih', 'nmL', 'nmH', 'monotonic'] }, { required: ['resistanceSpots'] }],
  properties: {
    ...Object.fromEntries(['switchingThreshold', 'voh', 'vol', 'vil', 'vih', 'nmL', 'nmH'].map(key => [key, metricSchema])),
    gainMax: { ...metricSchema, properties: { ...metricSchema.properties, input: { type: 'number' }, sweepPoint: { type: 'number' } } },
    resistanceSpots: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['sweepPoint', 'outputValue', 'outOfRange', 'resistance'], properties: { sweepPoint: { type: 'number' }, outputValue: { type: ['number', 'null'] }, outOfRange: { type: 'boolean' }, resistance: metricSchema } } },
    monotonic: { type: 'boolean' },
    spots: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['sweepPoint', 'inputValue', 'outputValue', 'outOfRange'], properties: { sweepPoint: { type: 'number' }, inputValue: { type: ['number', 'null'] }, outputValue: { type: ['number', 'null'] }, outOfRange: { type: 'boolean' }, gain: { type: ['number', 'null'] }, gainReason: { type: 'string' } } } },
    levelCrossings: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['outputLevelV', 'sweepPoint'], properties: { outputLevelV: { type: 'number' }, sweepPoint: { type: ['number', 'null'] } } } },
  },
};
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, retryable: false, phase: 'validation', details: {} } satisfies SpiceApiErrorV1;
}
export function dcMetricsInput<T>(args: T): unknown extends T ? DcMetricsInput : 'includeSpotResistance' extends keyof T ? DcMetricsInput : Omit<DcMetricsInput, 'includeSpotResistance'>;
export function dcMetricsInput(args: unknown): DcMetricsInput {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Expected DC metric arguments');
  const fields = args as Record<string, unknown>;
  if (Object.keys(fields).some(key => !['request', ...Object.keys(dcMetricsProperties)].includes(key))) invalid('Unknown DC metric argument');
  if (fields.sweepPoints !== undefined && (!Array.isArray(fields.sweepPoints) || fields.sweepPoints.length < 1 || fields.sweepPoints.length > 128 || Array.from(fields.sweepPoints).some(v => typeof v !== 'number' || !Number.isFinite(v)))) invalid('Invalid sweepPoints');
  if (fields.includeSpotGain !== undefined && (typeof fields.includeSpotGain !== 'boolean' || (fields.includeSpotGain && fields.sweepPoints === undefined))) invalid('includeSpotGain must be boolean and requires sweepPoints when true');
  if (fields.includeSpotResistance !== undefined && (typeof fields.includeSpotResistance !== 'boolean' || (fields.includeSpotResistance && (fields.sweepPoints === undefined || fields.includeSpotGain === true || fields.input !== undefined || fields.outputLevelsV !== undefined || fields.crossingDirection !== undefined)))) invalid('includeSpotResistance requires sweepPoints and is incompatible with voltage transfer options');
  if (fields.outputLevelsV !== undefined && (!Array.isArray(fields.outputLevelsV) || fields.outputLevelsV.length < 1 || fields.outputLevelsV.length > 128 || Array.from(fields.outputLevelsV).some(v => typeof v !== 'number' || !Number.isFinite(v)))) invalid('Invalid outputLevelsV');
  if (fields.crossingDirection !== undefined && (fields.outputLevelsV === undefined || !['either', 'rising', 'falling'].includes(fields.crossingDirection as string))) invalid('Invalid crossingDirection');
  for (const key of ['analysis', 'step']) {
    if (fields[key] !== undefined && (!Number.isInteger(fields[key]) || (fields[key] as number) < 0)) invalid(`Invalid ${key}`);
  }
  for (const key of ['sweptSource', 'output', ...(fields.input === undefined ? [] : ['input'])]) {
    if (typeof fields[key] !== 'string' || !fields[key].length || fields[key].length > 256) invalid(`Invalid ${key}`);
  }
  for (const signal of [fields.output, fields.input].filter(v => v !== undefined)) {
    if (!new RegExp(voltagePattern).test(signal as string)) invalid('DC transfer expressions must be v(node) or v(positive,negative)');
  }
  return { sweptSource: fields.sweptSource as string, output: fields.output as string, input: fields.input as string | undefined, analysis: fields.analysis as number | undefined, step: fields.step as number | undefined, sweepPoints: fields.sweepPoints as number[] | undefined, includeSpotGain: fields.includeSpotGain as boolean | undefined, includeSpotResistance: fields.includeSpotResistance as boolean | undefined, outputLevelsV: fields.outputLevelsV as number[] | undefined, crossingDirection: fields.crossingDirection as CrossingDirection | undefined };
}
const metric = (value: number | null, reason?: string, unit = 'V'): Metric => {
  if (value !== null && !Number.isFinite(value)) return { value: null, unit, reason: 'Non-finite metric' };
  return value === null ? { value, unit, reason: reason ?? 'Undefined metric' } : { value, unit };
};

/** Secant gains live at interval midpoints. Crossings interpolate adjacent samples. */
export function dcMetricsResult<T extends DcMetricsInput>(result: SimulationResultV1, input: T): 'includeSpotResistance' extends keyof T ? DcMetrics | ResistanceResult : DcMetrics;
export function dcMetricsResult(result: SimulationResultV1, input: DcMetricsInput): DcMetrics | ResistanceResult {
  const matches = result.analyses.filter(a => a.type === 'dc' && a.axis.name.toLowerCase() === input.sweptSource.toLowerCase()
    && (input.analysis === undefined || a.analysisIndex === input.analysis)
    && (input.step === undefined || (a.step?.index ?? 0) === input.step));
  if (matches.length !== 1) invalid('Expected exactly one DC sweep for sweptSource and selectors');
  const a = matches[0];
  if (a.type !== 'dc') invalid('Missing DC sweep');
  let sweep = a.axis.values;
  const voltage = (signal: string): number[] => {
    if (!new RegExp(voltagePattern).test(signal)) invalid('DC transfer expressions must be v(node) or v(positive,negative)');
    const literal = signal.slice(2, -1).toLowerCase();
    const hasLiteral = Object.keys(a.voltagesV).some(key => key.toLowerCase() === literal);
    const differential = literal.trim();
    if (!hasLiteral && literal.includes(',') && !differentialPattern.test(differential)) invalid(`Unknown voltage signal: ${signal}`);
    const names = hasLiteral || !literal.includes(',') ? [literal] : differential.split(',').map(name => name.trim());
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
  if (input.includeSpotResistance) {
    if (a.axis.unit !== 'A' || !/^i/i.test(input.sweptSource)) invalid('Spot resistance requires an independent current-source sweep');
    const y = voltage(input.output);
    if (sweep.length < 2 || y.length !== sweep.length || ![...sweep, ...y].every(Number.isFinite)) invalid('DC metrics require at least two finite aligned samples');
    const direction = Math.sign(sweep[1] - sweep[0]);
    if (!direction || sweep.some((v, i) => i > 0 && Math.sign(v - sweep[i - 1]) !== direction)) invalid('Sweep coordinates must be strictly monotonic');
    return { resistanceSpots: input.sweepPoints!.map(sweepPoint => {
      if (direction * (sweepPoint - sweep[0]) < 0 || direction * (sweepPoint - sweep[sweep.length - 1]) > 0) {
        return { sweepPoint, outputValue: null, outOfRange: true, resistance: metric(null, 'Outside sweep range', 'ohm') };
      }
      let end = 1;
      while (end < sweep.length - 1 && direction * (sweepPoint - sweep[end]) >= 0) end++;
      let dx = sweep[end] - sweep[end - 1]; let dy = y[end] - y[end - 1];
      const fraction = Number.isFinite(dx) ? (sweepPoint - sweep[end - 1]) / dx : (sweepPoint / 2 - sweep[end - 1] / 2) / (sweep[end] / 2 - sweep[end - 1] / 2);
      const outputValue = y[end - 1] * (1 - fraction) + y[end] * fraction;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        dx = sweep[end] / 2 - sweep[end - 1] / 2;
        dy = y[end] / 2 - y[end - 1] / 2;
      }
      const value = dy / dx;
      const resistance = !Number.isFinite(value) || (value === 0 && y[end] !== y[end - 1]) ? metric(null, 'Non-finite or nonrepresentable resistance', 'ohm') : metric(value, undefined, 'ohm');
      return { sweepPoint, outputValue: Number.isFinite(outputValue) ? outputValue : null, outOfRange: false, resistance };
    }) };
  }
  let x = input.input ? voltage(input.input) : sweep;
  let y = voltage(input.output);
  if (!input.input && a.axis.unit !== 'V') invalid('A current sweep requires an explicit voltage input expression');
  if (x.length < 2 || y.length !== x.length || sweep.length !== x.length || ![...x, ...y, ...sweep].every(Number.isFinite)) invalid('DC metrics require at least two finite aligned samples');
  const levelCrossings = input.outputLevelsV?.map(outputLevelV => {
    let sweepPoint: number | null = (input.crossingDirection === undefined || input.crossingDirection === 'either') && y[0] === outputLevelV ? sweep[0] : null;
    for (let i = 1; sweepPoint === null && i < y.length; i++) {
      const prev = y[i - 1]; const next = y[i];
      if ((input.crossingDirection !== 'falling' && prev < outputLevelV && next >= outputLevelV) || (input.crossingDirection !== 'rising' && prev > outputLevelV && next <= outputLevelV)) {
        const delta = next - prev;
        // Halving before subtraction avoids overflow for opposite-sign extremes.
        const fraction = Number.isFinite(delta) ? (outputLevelV - prev) / delta
          : (outputLevelV / 2 - prev / 2) / (next / 2 - prev / 2);
        const start = sweep[i - 1]; const end = sweep[i];
        // A weighted sum avoids overflowing the difference between opposite signs.
        sweepPoint = Math.sign(start) !== Math.sign(end)
          ? start * (1 - fraction) + end * fraction
          : start + (end - start) * fraction;
      }
    }
    return { outputLevelV, sweepPoint };
  });
  const direction = input.includeSpotGain ? (x.slice(1).map((v, i) => Math.sign(v - x[i])).find(d => d !== 0) ?? 1) : Math.sign(x[1] - x[0]);
  if (!direction || x.some((v, i) => i > 0 && Math.sign(v - x[i - 1]) !== direction && (!input.includeSpotGain || v !== x[i - 1]))) invalid('Input voltage must be strictly monotonic');
  const reversed = direction < 0;
  if (reversed) {
    x = [...x].reverse();
    y = [...y].reverse();
    sweep = [...sweep].reverse();
  }
  let spots: DcSpot[] | undefined;
  if (input.sweepPoints !== undefined) {
    const sweepDirection = Math.sign(sweep[1] - sweep[0]);
    if (!sweepDirection || sweep.some((v, i) => i > 0 && Math.sign(v - sweep[i - 1]) !== sweepDirection)) invalid('Sweep coordinates must be strictly monotonic');
    spots = input.sweepPoints.map(sweepPoint => {
      if (sweepDirection * (sweepPoint - sweep[0]) < 0 || sweepDirection * (sweepPoint - sweep[sweep.length - 1]) > 0) return { sweepPoint, inputValue: null, outputValue: null, outOfRange: true, ...(input.includeSpotGain ? { gain: null, gainReason: 'Outside sweep range' } : {}) };
      let i = 1;
      while (i < sweep.length - 1 && sweepDirection * (sweepPoint - sweep[i]) > 0) i++;
      const delta = sweep[i] - sweep[i - 1];
      const t = input.includeSpotGain && !Number.isFinite(delta)
        ? (sweepPoint / 2 - sweep[i - 1] / 2) / (sweep[i] / 2 - sweep[i - 1] / 2)
        : (sweepPoint - sweep[i - 1]) / delta;
      const interpolate = (values: number[]) => {
        const value = values[i - 1] + t * (values[i] - values[i - 1]);
        return input.includeSpotGain && !Number.isFinite(value) ? values[i - 1] * (1 - t) + values[i] * t : value;
      };
      const spot: DcSpot = { sweepPoint, inputValue: interpolate(x), outputValue: interpolate(y), outOfRange: false };
      if (input.includeSpotGain) {
        // i is the preceding interval at a knot in this normalized order.
        // Choose the following interval in the original traversal instead.
        let end = i;
        if (!reversed && sweepPoint === sweep[i] && i < sweep.length - 1) end++;
        if (reversed && sweepPoint === sweep[i - 1] && i > 1) end--;
        const zeroInput = x[end] === x[end - 1];
        let dx = x[end] - x[end - 1]; let dy = y[end] - y[end - 1];
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
          dx = x[end] / 2 - x[end - 1] / 2;
          dy = y[end] / 2 - y[end - 1] / 2;
        }
        const gain = dy / dx;
        spot.gain = zeroInput || !Number.isFinite(gain) || (gain === 0 && y[end] !== y[end - 1]) ? null : gain;
        if (spot.gain === null) spot.gainReason = zeroInput ? 'Zero input voltage change' : 'Non-finite or nonrepresentable gain';
      }
      return spot;
    });
  }
  const gains: number[] = []; const mid: number[] = []; let peak = -1;
  let rising = false; let falling = false;
  for (let i = 1; i < x.length; i++) {
    // Keep a gap in the sampled gains so unity-crossing interpolation cannot bridge a plateau.
    const plateau = x[i] === x[i - 1];
    gains.push(plateau ? NaN : (y[i] - y[i - 1]) / (x[i] - x[i - 1]));
    const midpoint = (a: number, b: number) => input.includeSpotGain && !Number.isFinite(a + b) ? a / 2 + b / 2 : (a + b) / 2;
    mid.push(midpoint(x[i], x[i - 1]));
    if (!plateau && (peak < 0 || Math.abs(gains[i - 1]) > Math.abs(gains[peak]))) peak = i - 1;
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
    gainMax: peak < 0 ? metric(null, 'No intervals with input voltage change', 'V/V') : { ...metric(Math.abs(gains[peak]), undefined, 'V/V'), input: mid[peak], sweepPoint: (sweep[peak] + sweep[peak + 1]) / 2 },
    switchingThreshold: metric(crossings(x, y.map((v, i) => v - x[i]), 0)[0] ?? null, 'No Vout = Vin crossing'),
    voh: metric(y[0]), vol: metric(y[y.length - 1]),
    vil: metric(vil, reason), vih: metric(vih, reason),
    nmL: metric(vil === null ? null : vil - y[y.length - 1], reason),
    nmH: metric(vih === null ? null : y[0] - vih, reason),
    monotonic: !(rising && falling),
    ...(spots === undefined ? {} : { spots }),
    ...(levelCrossings === undefined ? {} : { levelCrossings }),
  };
}
