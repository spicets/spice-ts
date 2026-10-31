import type { NoiseResult } from '@spice-ts/core';

export interface NoiseMetricsArgs { bandHz?: [number, number]; spotFrequenciesHz?: number[]; signalRms?: number }
const positive = { type: 'number', exclusiveMinimum: 0 };
export const noiseMetricsProperties = {
  bandHz: { type: 'array', items: positive, minItems: 2, maxItems: 2 },
  spotFrequenciesHz: { type: 'array', items: positive, maxItems: 128 },
  signalRms: { ...positive, maximum: Number.MAX_VALUE, description: 'Input-referred RMS signal in inputUnit (V or A).' },
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
  if (Object.keys(a).some(k => !['request', 'netlist', 'bandHz', 'spotFrequenciesHz', 'signalRms'].includes(k))
    || ('signalRms' in a && !hz(a.signalRms))
    || (a.bandHz !== undefined && (!Array.isArray(a.bandHz) || a.bandHz.length !== 2 || !a.bandHz.every(hz) || a.bandHz[0] >= a.bandHz[1]))
    || (a.spotFrequenciesHz !== undefined && (!Array.isArray(a.spotFrequenciesHz) || a.spotFrequenciesHz.length > 128 || !a.spotFrequenciesHz.every(hz)))) invalid('Expected positive finite signalRms, an increasing positive bandHz pair and up to 128 positive spotFrequenciesHz');
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
      const a = ((f[i] - left) / span + (f[i] - right) / span) / 2;
      const b = ((left - f[i - 1]) / span + (right - f[i - 1]) / span) / 2;
      const width = Math.sqrt(right - left);
      const contribution = (density: number, weight: number) => width > 1
        ? (density * Math.sqrt(weight)) * width
        : (density * width) * Math.sqrt(weight);
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
  return { bandHz: band, integratedOutputNoiseVrms, integratedInputNoiseRms, inputUnit: /^i/i.test(spectrum.inputSource) ? 'A' : 'V', spots, method,
    ...(args.signalRms === undefined ? {} : integratedInputNoiseRms === 0
      ? { signalToNoiseRatioDb: null, signalToNoiseRatioReason: 'zero integrated input noise' }
      : { signalToNoiseRatioDb: 20 * (Math.log10(args.signalRms) - Math.log10(integratedInputNoiseRms)) }),
  };
}
