import type { SimulationResultV1 } from '@spice-ts/core/protocol';

const metricNames = ['dcGainDb', 'f3dbHz', 'unityGainHz', 'phaseMarginDeg', 'gainMarginDb', 'peakingDb', 'peakFrequencyHz'] as const;
type Metric = typeof metricNames[number];
const reasonCodes = ['NON_FINITE_GAIN', 'NO_HALF_POWER_CROSSING', 'NO_UNITY_GAIN_CROSSING', 'NO_PHASE_CROSSING'] as const;
type ReasonCode = typeof reasonCodes[number];
export interface AcMetricsArgs { output: string; input?: string; analysis?: number; step?: number; groupDelayAtHz?: number; includeBandpass?: boolean; frequenciesHz?: number[] }
const bandpassNames = ['peakFrequencyHz', 'lowerHalfPowerHz', 'upperHalfPowerHz', 'bandwidthHz', 'qualityFactor'] as const;
type BandpassMetric = typeof bandpassNames[number];
type BandpassReason = 'NON_FINITE_GAIN' | 'NO_LOWER_HALF_POWER_CROSSING' | 'NO_UPPER_HALF_POWER_CROSSING' | 'NON_FINITE_BANDPASS';
export const acMetricsProperties = {
  output: { type: 'string', minLength: 1, maxLength: 256 },
  input: { type: 'string', minLength: 1, maxLength: 256 },
  analysis: { type: 'integer', minimum: 0 },
  step: { type: 'integer', minimum: 0 },
  frequenciesHz: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'number', exclusiveMinimum: 0 }, description: 'Transfer spots in request order. Gain dB and unwrapped phase are interpolated linearly in log frequency; no extrapolation.' },
  includeBandpass: { type: 'boolean', description: 'Report sampled global peak and nearest half-power crossings, interpolating gain in dB linearly in log frequency. The first maximum wins ties; crossings are never extrapolated.' },
  groupDelayAtHz: { type: 'number', exclusiveMinimum: 0, description: 'Frequency in Hz for group delay. Sample delays use centered phase differences, or one-sided differences at endpoints; between samples delays are linearly interpolated in Hz. No extrapolation; adjacent phase changes must be below 180 degrees.' },
};
export const acMetricsOutputSchema = {
  type: 'object', additionalProperties: false,
  required: [...metricNames, 'referenceFrequencyHz', 'reasons'],
  properties: {
    ...Object.fromEntries(metricNames.map(key => [key, { type: ['number', 'null'] }])),
    groupDelaySeconds: { type: 'number' },
    spots: {
      type: 'array', minItems: 1, maxItems: 128,
      items: { type: 'object', additionalProperties: false, required: ['frequencyHz', 'gainDb', 'phaseDeg', 'reasons'],
        allOf: ['gainDb', 'phaseDeg'].map(key => ({
          if: { properties: { [key]: { type: 'null' } }, required: [key] },
          then: { properties: { reasons: { required: [key] } } },
          else: { properties: { reasons: { not: { required: [key] } } } },
        })),
        properties: {
        frequencyHz: { type: 'number', exclusiveMinimum: 0 }, gainDb: { type: ['number', 'null'] }, phaseDeg: { type: ['number', 'null'] },
        reasons: { type: 'object', additionalProperties: false, properties: {
          gainDb: { type: 'string', enum: ['OUT_OF_RANGE', 'UNDEFINED_VALUE'] }, phaseDeg: { type: 'string', enum: ['OUT_OF_RANGE', 'UNDEFINED_VALUE'] },
        } },
      } },
    },
    bandpass: {
      type: 'object', additionalProperties: false, required: [...bandpassNames, 'reasons'],
      properties: {
        ...Object.fromEntries(bandpassNames.map(key => [key, { type: ['number', 'null'] }])),
        reasons: { type: 'object', additionalProperties: false, properties: Object.fromEntries(bandpassNames.map(key => [key, { type: 'string', enum: ['NON_FINITE_GAIN', 'NO_LOWER_HALF_POWER_CROSSING', 'NO_UPPER_HALF_POWER_CROSSING', 'NON_FINITE_BANDPASS'] }])) },
      },
    },
    referenceFrequencyHz: { type: 'number', exclusiveMinimum: 0 },
    reasons: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(metricNames.map(key => [key, { type: 'string', enum: reasonCodes }])),
    },
  },
};

function invalid(message: string, details: Record<string, string> = {}): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details };
}

function validateFrequencies(value: unknown): void {
  if (value !== undefined && (!Array.isArray(value) || value.length < 1 || value.length > 128
    || Array.from(value).some(hz => typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0))) {
    invalid('Spot frequencies must contain 1 to 128 finite positive numbers', { reason: 'INVALID_SPOT_FREQUENCIES' });
  }
}

export function acMetricsArgs(raw: unknown): AcMetricsArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected AC metric selectors');
  const a = raw as Record<string, unknown>;
  validateFrequencies(a.frequenciesHz);
  if (a.groupDelayAtHz !== undefined && (typeof a.groupDelayAtHz !== 'number' || !Number.isFinite(a.groupDelayAtHz) || a.groupDelayAtHz <= 0)) {
    invalid('Group delay frequency must be finite and positive', { reason: 'INVALID_GROUP_DELAY_FREQUENCY' });
  }
  if (Object.keys(a).some(key => !['request', 'output', 'input', 'analysis', 'step', 'groupDelayAtHz', 'includeBandpass', 'frequenciesHz'].includes(key))
    || (a.includeBandpass !== undefined && typeof a.includeBandpass !== 'boolean')
    || typeof a.output !== 'string' || !a.output.length || a.output.length > 256
    || (a.input !== undefined && (typeof a.input !== 'string' || !a.input.length || a.input.length > 256))
    || (a.analysis !== undefined && (!Number.isInteger(a.analysis) || (a.analysis as number) < 0))
    || (a.step !== undefined && (!Number.isInteger(a.step) || (a.step as number) < 0))) {
    invalid('Expected output node, optional input node and nonnegative analysis and step indices');
  }
  return a as unknown as AcMetricsArgs;
}

/** Reduce a single AC sweep; never extrapolate a crossing outside sampled frequencies. */
export function acMetrics(result: SimulationResultV1, args: AcMetricsArgs) {
  validateFrequencies(args.frequenciesHz);
  if (args.groupDelayAtHz !== undefined && (!Number.isFinite(args.groupDelayAtHz) || args.groupDelayAtHz <= 0)) {
    invalid('Group delay frequency must be finite and positive', { reason: 'INVALID_GROUP_DELAY_FREQUENCY' });
  }
  const selected = result.analyses.filter(a => args.analysis === undefined ? a.type === 'ac' : a.analysisIndex === args.analysis);
  if (!selected.length || selected.some(a => a.type !== 'ac') || new Set(selected.map(a => a.analysisIndex)).size !== 1) invalid('Select exactly one AC analysis');
  const traces = args.step === undefined ? selected : selected.filter(a => (a.step?.index ?? 0) === args.step);
  if (!traces.length) invalid('No AC trace has the requested step index', { reason: 'UNKNOWN_STEP' });
  if (traces.length !== 1 || traces[0].type !== 'ac') invalid('Select exactly one AC trace; specify a step for stepped analyses');
  const a = traces[0];
  const node = (name: string) => {
    const key = Object.keys(a.voltagePhasors).find(key => key.toLowerCase() === name.toLowerCase());
    if (key === undefined) invalid('Unknown voltage node', { reason: 'UNKNOWN_NODE', node: name });
    return a.voltagePhasors[key];
  };
  const voltage = (selector: string) => {
    if (!/[(),]/.test(selector)) return node(selector);
    const match = /^v\(\s*([^\s(),]+)\s*,\s*([^\s(),]+)\s*\)$/i.exec(selector);
    if (!match || selector.length > 256) invalid('Invalid differential voltage selector', { reason: 'INVALID_SELECTOR' });
    const operand = (name: string) => name === '0'
      ? a.frequencyHz.map(() => ({ magnitude: 0, phaseDegrees: 0 })) : node(name);
    const positive = operand(match[1]); const negative = operand(match[2]);
    if (positive.length !== a.frequencyHz.length || negative.length !== a.frequencyHz.length) invalid('AC frequencies must be finite, positive and increasing');
    return positive.map((p, i) => {
      const q = negative[i];
      if (![p.magnitude, p.phaseDegrees, q.magnitude, q.phaseDegrees].every(Number.isFinite) || p.magnitude < 0 || q.magnitude < 0) {
        invalid('Transfer function contains invalid phasors or a zero input', { reason: 'UNDEFINED_TRANSFER' });
      }
      // Subtract in p's frame, using the relative angle before converting to
      // radians. Independent sine evaluations lose tiny phase differences.
      const principal = (angle: number) => {
        const r = angle % 360;
        return r >= 180 ? r - 360 : r < -180 ? r + 360 : r;
      };
      const pa = principal(p.phaseDegrees); const qa = principal(q.phaseDegrees);
      let delta = qa - pa;
      // Split the wrap at ±180 to retain differences smaller than an ulp of 360.
      if (delta > 180) delta = (qa - 180) - (pa + 180);
      else if (delta < -180) delta = (qa + 180) - (pa - 180);
      const radians = delta * Math.PI / 180;
      const sineHalf = Math.sin(radians / 2);
      const real = (p.magnitude - q.magnitude) + q.magnitude * (2 * sineHalf * sineHalf);
      const imag = -q.magnitude * Math.sin(radians);
      return { magnitude: Math.hypot(real, imag), phaseDegrees: pa + Math.atan2(imag, real) * 180 / Math.PI };
    });
  };
  const out = voltage(args.output);
  const input = args.input === undefined ? undefined : voltage(args.input);
  const f = a.frequencyHz;
  if (args.groupDelayAtHz !== undefined && f.length < 2) invalid('Group delay requires at least two frequency samples', { reason: 'INSUFFICIENT_GROUP_DELAY_POINTS' });
  if (!f.length || out.length !== f.length || (input && input.length !== f.length)
    || f.some((v, i) => !Number.isFinite(v) || v <= 0 || (i > 0 && v <= f[i - 1]))) invalid('AC frequencies must be finite, positive and increasing');
  if (args.groupDelayAtHz !== undefined) {
    if (args.groupDelayAtHz < f[0] || args.groupDelayAtHz > f[f.length - 1]) invalid('Group delay frequency is outside the sweep', { reason: 'GROUP_DELAY_OUT_OF_RANGE' });
  }
  const db: number[] = []; const phase: number[] = [];
  for (let i = 0; i < f.length; i++) {
    const p = out[i]; const q = input?.[i];
    if (!Number.isFinite(p.magnitude) || p.magnitude < 0 || !Number.isFinite(p.phaseDegrees)
      || (q && (!Number.isFinite(q.magnitude) || q.magnitude <= 0 || !Number.isFinite(q.phaseDegrees)))) {
      invalid('Transfer function contains invalid phasors or a zero input', { reason: 'UNDEFINED_TRANSFER' });
    }
    if (args.groupDelayAtHz !== undefined && p.magnitude === 0) invalid('Group delay is undefined for zero output magnitude', { reason: 'UNDEFINED_TRANSFER' });
    db.push(20 * Math.log10(p.magnitude / (q?.magnitude ?? 1)));
    let angle = p.phaseDegrees - (q?.phaseDegrees ?? 0);
    // Choose the principal initial phase, then unwrap relative to the preceding sample.
    angle = ((angle + 180) % 360 + 360) % 360 - 180;
    if (i > 0) {
      while (angle - phase[i - 1] > 180) angle -= 360;
      while (angle - phase[i - 1] < -180) angle += 360;
    }
    phase.push(angle);
  }
  type Crossing = { hz: number; index: number; fraction: number };
  const crossing = (values: number[], target: number): Crossing | undefined => {
    for (let i = 1; i < f.length; i++) {
      if (!Number.isFinite(values[i - 1]) || !Number.isFinite(values[i])) continue;
      if (values[i - 1] >= target && values[i] <= target && values[i - 1] > values[i]) {
        const fraction = (target - values[i - 1]) / (values[i] - values[i - 1]);
        return { hz: Math.exp(Math.log(f[i - 1]) + fraction * Math.log(f[i] / f[i - 1])), index: i, fraction };
      }
    }
    return undefined;
  };
  const at = (values: number[], c: Crossing) => values[c.index - 1] + c.fraction * (values[c.index] - values[c.index - 1]);
  const reasons: Partial<Record<Metric, ReasonCode>> = {};
  const finite = (key: Metric, value: number | undefined, reason: ReasonCode) => {
    if (value !== undefined && Number.isFinite(value)) return value;
    reasons[key] = reason;
    return null;
  };
  const bandwidth = crossing(db, db[0] - 10 * Math.log10(2));
  const unity = crossing(db, 0);
  const phaseCrossing = crossing(phase, -180);
  // Sampled maximum only: do not invent an inter-sample resonant peak.
  let peakIndex = 0;
  for (let i = 1; i < db.length; i++) if (db[i] > db[peakIndex]) peakIndex = i;
  let bandpass: (Record<BandpassMetric, number | null> & { reasons: Partial<Record<BandpassMetric, BandpassReason>> }) | undefined;
  if (args.includeBandpass) {
    const why: Partial<Record<BandpassMetric, BandpassReason>> = {};
    const peak = Number.isFinite(db[peakIndex]) ? f[peakIndex] : null;
    const target = db[peakIndex] - 10 * Math.log10(2);
    // Search outwards from the first global maximum. Interpolate dB in log Hz,
    // matching the existing low-pass crossing convention. Never extrapolate.
    const find = (direction: -1 | 1): number | null => {
      for (let i = peakIndex; i + direction >= 0 && i + direction < f.length; i += direction) {
        const j = i + direction;
        if (!Number.isFinite(db[i]) || !Number.isFinite(db[j])) return null;
        if (db[i] >= target && db[j] <= target && db[i] > db[j]) {
          const fraction = (target - db[i]) / (db[j] - db[i]);
          const hz = Math.exp(Math.log(f[i]) + fraction * (Math.log(f[j]) - Math.log(f[i])));
          return Math.min(Math.max(hz, Math.min(f[i], f[j])), Math.max(f[i], f[j]));
        }
      }
      return null;
    };
    const lower = peak === null ? null : find(-1);
    const upper = peak === null ? null : find(1);
    if (peak === null) why.peakFrequencyHz = 'NON_FINITE_GAIN';
    if (lower === null) why.lowerHalfPowerHz = peak === null ? 'NON_FINITE_GAIN' : 'NO_LOWER_HALF_POWER_CROSSING';
    if (upper === null) why.upperHalfPowerHz = peak === null ? 'NON_FINITE_GAIN' : 'NO_UPPER_HALF_POWER_CROSSING';
    let width = lower === null || upper === null ? null : upper - lower;
    let q = width === null || peak === null ? null : peak / width;
    const missing = why.lowerHalfPowerHz ?? why.upperHalfPowerHz;
    if (width !== null && (!Number.isFinite(width) || width <= 0)) { width = null; q = null; }
    if (q !== null && !Number.isFinite(q)) q = null;
    if (width === null) why.bandwidthHz = missing ?? 'NON_FINITE_BANDPASS';
    if (q === null) why.qualityFactor = missing ?? 'NON_FINITE_BANDPASS';
    bandpass = { peakFrequencyHz: peak, lowerHalfPowerHz: lower, upperHalfPowerHz: upper, bandwidthHz: width, qualityFactor: q, reasons: why };
  }
  let groupDelaySeconds: number | undefined;
  if (args.groupDelayAtHz !== undefined) {
    // Differentiate unwrapped transfer phase at samples, then interpolate in linear Hz.
    const delayAt = (i: number) => {
      const left = Math.max(0, i - 1); const right = Math.min(f.length - 1, i + 1);
      return -(phase[right] - phase[left]) / 360 / (f[right] - f[left]);
    };
    const right = f.findIndex(hz => hz >= args.groupDelayAtHz!);
    const left = Math.max(0, right - 1);
    const fraction = left === right ? 0 : (args.groupDelayAtHz - f[left]) / (f[right] - f[left]);
    groupDelaySeconds = delayAt(left) + fraction * (delayAt(right) - delayAt(left));
    if (!Number.isFinite(groupDelaySeconds)) invalid('Group delay is not finite', { reason: 'UNDEFINED_TRANSFER' });
  }
  const spots = args.frequenciesHz?.map(frequencyHz => {
    const undefinedSpot = (reason: 'OUT_OF_RANGE' | 'UNDEFINED_VALUE') => ({
      frequencyHz, gainDb: null, phaseDeg: null, reasons: { gainDb: reason, phaseDeg: reason },
    });
    if (frequencyHz < f[0] || frequencyHz > f[f.length - 1]) return undefinedSpot('OUT_OF_RANGE');
    const right = f.findIndex(hz => hz >= frequencyHz);
    const left = f[right] === frequencyHz ? right : right - 1;
    if (!Number.isFinite(db[left]) || !Number.isFinite(db[right])) return undefinedSpot('UNDEFINED_VALUE');
    const logRatio = (x: number, base: number) => {
      const relative = (x - base) / base;
      return Number.isFinite(relative) ? Math.log1p(relative) : Math.log(x) - Math.log(base);
    };
    const fraction = left === right ? 0 : logRatio(frequencyHz, f[left]) / logRatio(f[right], f[left]);
    const gainDb = left === right ? db[left] : db[left] + fraction * (db[right] - db[left]);
    const phaseDeg = left === right ? phase[left] : phase[left] + fraction * (phase[right] - phase[left]);
    if (!Number.isFinite(gainDb) || !Number.isFinite(phaseDeg)) return undefinedSpot('UNDEFINED_VALUE');
    return { frequencyHz, gainDb, phaseDeg, reasons: {} };
  });
  return {
    dcGainDb: finite('dcGainDb', db[0], 'NON_FINITE_GAIN'),
    f3dbHz: finite('f3dbHz', bandwidth?.hz, 'NO_HALF_POWER_CROSSING'),
    unityGainHz: finite('unityGainHz', unity?.hz, 'NO_UNITY_GAIN_CROSSING'),
    phaseMarginDeg: finite('phaseMarginDeg', unity ? 180 + at(phase, unity) : undefined, 'NO_UNITY_GAIN_CROSSING'),
    gainMarginDb: finite('gainMarginDb', phaseCrossing ? -at(db, phaseCrossing) : undefined, 'NO_PHASE_CROSSING'),
    peakingDb: finite('peakingDb', db[peakIndex] - db[0], 'NON_FINITE_GAIN'),
    peakFrequencyHz: finite('peakFrequencyHz', Number.isFinite(db[peakIndex]) ? f[peakIndex] : undefined, 'NON_FINITE_GAIN'),
    referenceFrequencyHz: f[0], reasons,
    ...(groupDelaySeconds === undefined ? {} : { groupDelaySeconds }),
    ...(bandpass === undefined ? {} : { bandpass }),
    ...(spots === undefined ? {} : { spots }),
  };
}
