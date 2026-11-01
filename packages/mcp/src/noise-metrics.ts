import type { NoiseResult } from '@spice-ts/core';

export interface NoiseMetricsArgs { bandHz?: [number, number]; spotFrequenciesHz?: number[]; signalRms?: number; outputSignalRms?: number; outputNoisePercentiles?: number[] }
const positive = { type: 'number', exclusiveMinimum: 0 };
export const noiseMetricsProperties = {
  bandHz: { type: 'array', items: positive, minItems: 2, maxItems: 2 },
  spotFrequenciesHz: { type: 'array', items: positive, maxItems: 128 },
  signalRms: { ...positive, maximum: Number.MAX_VALUE, description: 'Input-referred RMS signal in inputUnit (V or A).' },
  outputSignalRms: { ...positive, maximum: Number.MAX_VALUE, description: 'Output-referred RMS signal in volts.' },
  outputNoisePercentiles: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100 } },
};
const method = 'trapezoidal PSD integration in linear frequency; linear PSD at clipped band edges; density linear in log-frequency for spots; no extrapolation';
export const noiseMetricsOutputSchema = {
  type: 'object', additionalProperties: false,
  required: ['bandHz', 'integratedOutputNoiseVrms', 'integratedInputNoiseRms', 'inputUnit', 'spots', 'method'],
  properties: {
    bandHz: noiseMetricsProperties.bandHz,
    integratedOutputNoiseVrms: { type: 'number', minimum: 0 },
    integratedInputNoiseRms: { type: 'number', minimum: 0 },
    signalToNoiseRatioDb: { type: ['number', 'null'] },
    signalToNoiseRatioReason: { const: 'zero integrated input noise' },
    outputSignalToNoiseRatioDb: { type: ['number', 'null'], description: 'Output SNR in dB, or null when integrated output noise is zero.' },
    outputSignalToNoiseRatioReason: { const: 'zero integrated output noise' },
    outputNoisePercentileFrequencies: {
      type: 'array', minItems: 1, maxItems: 32, items: {
        type: 'object', additionalProperties: false, required: ['percent', 'frequencyHz'],
        properties: { percent: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100 }, frequencyHz: { type: ['number', 'null'], minimum: 0 }, reason: { const: 'zero integrated output noise' } },
      },
    },
    inputUnit: { enum: ['V', 'A'] }, method: { const: method },
    spots: {
      type: 'array', maxItems: 128, items: {
        type: 'object', additionalProperties: false,
        required: ['frequencyHz', 'outputNoiseVPerSqrtHz', 'inputNoisePerSqrtHz', 'outOfRange'],
        properties: {
          frequencyHz: positive, outputNoiseVPerSqrtHz: { type: ['number', 'null'], minimum: 0 },
          inputNoisePerSqrtHz: { type: ['number', 'null'], minimum: 0 }, outOfRange: { type: 'boolean' },
        },
      },
    },
  },
};
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} };
}
export function noiseMetricsArgs(raw: unknown): NoiseMetricsArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected noise metric selectors');
  const a = raw as Record<string, unknown>;
  const hz = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (('request' in a) === ('netlist' in a) || ('netlist' in a && typeof a.netlist !== 'string')) invalid('Expected exactly one netlist or protocol-v1 request');
  if (Object.keys(a).some(k => !['request', 'netlist', 'params', 'bandHz', 'spotFrequenciesHz', 'signalRms', 'outputSignalRms', 'outputNoisePercentiles'].includes(k))
    || ('signalRms' in a && !hz(a.signalRms))
    || ('outputSignalRms' in a && !hz(a.outputSignalRms))
    || ('outputNoisePercentiles' in a && (!Array.isArray(a.outputNoisePercentiles) || a.outputNoisePercentiles.length < 1 || a.outputNoisePercentiles.length > 32 || !a.outputNoisePercentiles.every(v => hz(v) && v < 100)))
    || (a.bandHz !== undefined && (!Array.isArray(a.bandHz) || a.bandHz.length !== 2 || !a.bandHz.every(hz) || a.bandHz[0] >= a.bandHz[1]))
    || (a.spotFrequenciesHz !== undefined && (!Array.isArray(a.spotFrequenciesHz) || a.spotFrequenciesHz.length > 128 || !a.spotFrequenciesHz.every(hz)))) invalid('Expected positive finite signalRms and outputSignalRms, an increasing positive bandHz pair and up to 128 positive spotFrequenciesHz');
  return a as NoiseMetricsArgs;
}

export function noiseMetrics(spectrum: NoiseResult, args: NoiseMetricsArgs) {
  const f = spectrum.frequencies;
  const out = spectrum.outputNoiseDensity;
  const input = spectrum.inputNoiseDensity;
  if (!f.length || f.some((v, i) => !Number.isFinite(v) || v <= 0 || (i > 0 && v <= f[i - 1]))
    || [out, input].some(y => y.length !== f.length || y.some(v => !Number.isFinite(v) || v < 0))) invalid('Invalid noise spectrum');
  const band = args.bandHz ?? [f[0], f[f.length - 1]];
  if (band[0] < f[0] || band[1] > f[f.length - 1]) invalid('Noise band lies outside the simulated sweep');
  const integrate = (y: number[]) => {
    let rms = 0; let nonzero = false;
    // Keep subnormal interval contributions on a common scale until after summation.
    // At this threshold even the widest finite interval cannot overflow the scaled RMS.
    const scale = y.every((density, i) => density <= 2 ** -512 ||
      !((i > 0 && f[i - 1] < band[1] && f[i] > band[0]) ||
        (i + 1 < f.length && f[i] < band[1] && f[i + 1] > band[0]))) ? 2 ** 512 : 1;
    for (let i = 1; i < f.length; i++) {
      const left = Math.max(band[0], f[i - 1]); const right = Math.min(band[1], f[i]);
      if (right <= left) continue;
      nonzero ||= y[i - 1] !== 0 || y[i] !== 0;
      if (y[i - 1] === y[i]) {
        rms = Math.hypot(rms, (y[i] * scale) * Math.sqrt(right - left));
        continue;
      }
      const span = f[i] - f[i - 1];
      // Integrate the two linear-PSD basis functions over the clipped interval.
      // Take square roots before dividing: the normalized weight itself can
      // underflow even though its square root and the final RMS are representable.
      const rootSpan = Math.sqrt(span);
      const rootWeight = (d1: number, d2: number) =>
        Math.hypot(Math.sqrt(d1) / rootSpan, Math.sqrt(d2) / rootSpan) / Math.SQRT2;
      const a = rootWeight(f[i] - left, f[i] - right);
      const b = rootWeight(left - f[i - 1], right - f[i - 1]);
      const width = Math.sqrt(right - left);
      const contribution = (density: number, weight: number) => width > 1
        ? (density * weight) * width
        : (density * width) * weight;
      rms = Math.hypot(rms, contribution(y[i - 1] * scale, a), contribution(y[i] * scale, b));
    }
    rms /= scale;
    if (rms === 0 && nonzero) invalid('Noise integration underflow');
    return rms;
  };
  const spots = (args.spotFrequenciesHz ?? []).map(frequencyHz => {
    const outOfRange = frequencyHz < f[0] || frequencyHz > f[f.length - 1];
    const at = (y: number[]) => {
      if (outOfRange) return null;
      const i = f.findIndex(hz => hz >= frequencyHz);
      if (i === 0 || f[i] === frequencyHz) return y[i];
      const t = Math.log(frequencyHz / f[i - 1]) / Math.log(f[i] / f[i - 1]);
      return y[i - 1] + t * (y[i] - y[i - 1]);
    };
    return { frequencyHz, outputNoiseVPerSqrtHz: at(out), inputNoisePerSqrtHz: at(input), outOfRange };
  });
  const integratedOutputNoiseVrms = integrate(out); const integratedInputNoiseRms = integrate(input);
  if (![integratedOutputNoiseVrms, integratedInputNoiseRms].every(Number.isFinite)) invalid('Noise integration overflow');
  const percentiles = args.outputNoisePercentiles?.map(percent => {
    if (integratedOutputNoiseVrms === 0) return { percent, frequencyHz: null, reason: 'zero integrated output noise' };
    // Normalize by the integrated RMS. Segment power is evaluated as a ratio,
    // keeping both very small and very large densities representable.
    const powers: { left: number; right: number; a: number; b: number; power: number }[] = [];
    for (let i = 1; i < f.length; i++) {
      const left = Math.max(band[0], f[i - 1]); const right = Math.min(band[1], f[i]);
      if (right <= left) continue;
      const span = f[i] - f[i - 1];
      const t0 = (left - f[i - 1]) / span; const t1 = (right - f[i - 1]) / span;
      // Squared normalized densities represent PSD, not amplitude interpolation.
      const scale = Math.max(out[i - 1], out[i]);
      const p0 = scale === 0 ? 0 : (out[i - 1] / scale) ** 2;
      const p1 = scale === 0 ? 0 : (out[i] / scale) ** 2;
      const a = p0 * ((f[i] - left) / span) + p1 * t0; const b = p0 * ((f[i] - right) / span) + p1 * t1;
      const rootPower = (scale / integratedOutputNoiseVrms) * Math.sqrt(right - left);
      const power = (rootPower * Math.sqrt(a / 2 + b / 2)) ** 2;
      powers.push({ left, right, a, b, power });
    }
    const total = powers.reduce((sum, segment) => sum + segment.power, 0);
    if (!(total > 0) || !Number.isFinite(total)) invalid('Noise percentile integration overflow or underflow');
    let target = total * (percent / 100);
    for (const segment of powers) {
      if (segment.power === 0) continue;
      if (target > segment.power) { target -= segment.power; continue; }
      const fraction = Math.max(0, Math.min(1, target / segment.power));
      const root = Math.hypot(Math.sqrt(1 - fraction) * segment.a, Math.sqrt(fraction) * segment.b);
      const position = fraction === 0 ? 0 : fraction * (segment.a + segment.b) / (segment.a + root);
      return { percent, frequencyHz: segment.left + (segment.right - segment.left) * Math.min(1, position) };
    }
    return { percent, frequencyHz: powers.filter(segment => segment.power > 0).at(-1)!.right };
  });
  return { bandHz: band, integratedOutputNoiseVrms, integratedInputNoiseRms, inputUnit: /^i/i.test(spectrum.inputSource) ? 'A' : 'V', spots, method,
    ...(percentiles === undefined ? {} : { outputNoisePercentileFrequencies: percentiles }),
    ...(args.signalRms === undefined ? {} : integratedInputNoiseRms === 0
      ? { signalToNoiseRatioDb: null, signalToNoiseRatioReason: 'zero integrated input noise' }
      : { signalToNoiseRatioDb: 20 * (Math.log10(args.signalRms) - Math.log10(integratedInputNoiseRms)) }),
    ...(args.outputSignalRms === undefined ? {} : integratedOutputNoiseVrms === 0
      ? { outputSignalToNoiseRatioDb: null, outputSignalToNoiseRatioReason: 'zero integrated output noise' }
      : { outputSignalToNoiseRatioDb: 20 * (Math.log10(args.outputSignalRms) - Math.log10(integratedOutputNoiseVrms)) }),
  };
}
