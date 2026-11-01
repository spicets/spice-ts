import type { AnalysisDirective } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { paramsSchema } from './params.js';

type ACAnalysis = Extract<AnalysisDirective, { type: 'ac' }>;

export interface ImpedanceSelectors { port: { positive: string; negative: string }; sweep?: ACAnalysis; includeAdmittance?: boolean; spotFrequenciesHz?: number[] }
export interface ImpedanceSpectrum { frequencyHz: number[]; positive: { magnitude: number; phaseDegrees: number }[]; negative: { magnitude: number; phaseDegrees: number }[] }
export const impedanceProperties = {
  includeAdmittance: { type: 'boolean' },
  port: { type: 'object', additionalProperties: false, required: ['positive', 'negative'], properties: {
    positive: { type: 'string', minLength: 1, maxLength: 256 }, negative: { type: 'string', minLength: 1, maxLength: 256 },
  } },
  sweep: { type: 'object', additionalProperties: false, required: ['variation', 'points', 'startFreq', 'stopFreq'], properties: {
    variation: { enum: ['dec', 'oct', 'lin'] }, points: { type: 'integer', minimum: 1 }, startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 },
  } }, params: paramsSchema,
  spotFrequenciesHz: { type: 'array', maxItems: 128, items: { type: 'number', exclusiveMinimum: 0 }, description: 'Optional positive finite frequencies. Real and imaginary impedance are interpolated linearly in log frequency (linear frequency for lin sweeps); no extrapolation.' },
};
const number = { type: 'number' };
const extremum = { type: 'object', additionalProperties: false, required: ['magnitudeOhm', 'frequencyHz'], properties: { magnitudeOhm: number, frequencyHz: number } };
export const impedanceOutputSchema = {
  type: 'object', additionalProperties: false, required: ['port', 'points', 'summary'], properties: {
    port: impedanceProperties.port,
    spots: { type: 'array', maxItems: 128, description: 'Requested frequencies in input order. Complex impedance is interpolated in log frequency, or linear frequency for lin sweeps; out-of-range values are null.', items: { type: 'object', additionalProperties: false,
      required: ['frequencyHz', 'resistanceOhm', 'reactanceOhm', 'magnitudeOhm', 'phaseDeg', 'outOfRange'], properties: {
        frequencyHz: number, resistanceOhm: { type: ['number', 'null'] }, reactanceOhm: { type: ['number', 'null'] }, magnitudeOhm: { type: ['number', 'null'] }, phaseDeg: { type: ['number', 'null'] }, outOfRange: { type: 'boolean' },
      } } },
    points: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['frequencyHz', 'magnitudeOhm', 'phaseDeg', 'resistanceOhm', 'reactanceOhm'], properties: {
        frequencyHz: number, magnitudeOhm: number, phaseDeg: number, resistanceOhm: number, reactanceOhm: number, conductanceS: number, susceptanceS: number,
      } } },
    summary: { type: 'object', additionalProperties: false, required: ['min', 'max', 'resonanceHz'], properties: {
      min: extremum, max: extremum, resonanceHz: { type: 'array', items: number },
    } },
  },
};
export const impedanceErrorCodes = ['UNKNOWN_NODE', 'SHORTED_PORT', 'MISSING_AC_SWEEP'] as const;
export const impedanceFailureSchema = {
  type: 'object', additionalProperties: false, required: ['error'], properties: {
    error: { type: 'object', additionalProperties: false, required: ['code', 'message', 'phase', 'retryable', 'details'], properties: {
      code: { enum: impedanceErrorCodes }, message: { type: 'string' }, phase: { const: 'validation' }, retryable: { const: false }, details: { type: 'object' },
    } },
  },
};
export function impedanceInvalid(message: string, reason?: typeof impedanceErrorCodes[number]): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: reason ? { impedanceCode: reason } : {} };
}
export function impedanceArgs(raw: unknown): ImpedanceSelectors {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['request', 'port', 'sweep', 'params', 'includeAdmittance', 'spotFrequenciesHz'].includes(k))) impedanceInvalid('Expected request, port and optional sweep/params/includeAdmittance/spotFrequenciesHz');
  if (a.includeAdmittance !== undefined && typeof a.includeAdmittance !== 'boolean') impedanceInvalid('Expected includeAdmittance to be a boolean');
  const p = a.port as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['positive', 'negative'].includes(k))
    || ![p.positive, p.negative].every(v => typeof v === 'string' && /^[^\s(),;*$]+$/.test(v) && v.length <= 256)) impedanceInvalid('Expected positive and negative node names');
  const normalize = (s: string) => /^(0|gnd)$/i.test(s) ? '0' : s.toLowerCase();
  const port = { positive: normalize(p.positive as string), negative: normalize(p.negative as string) };
  if (port.positive === port.negative) impedanceInvalid('Port terminals are the same node', 'SHORTED_PORT');
  let sweep: ACAnalysis | undefined;
  if (a.sweep !== undefined) {
    const s = a.sweep as Record<string, unknown>;
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['variation', 'points', 'startFreq', 'stopFreq'].includes(k))
      || !['dec', 'oct', 'lin'].includes(s.variation as string) || !Number.isSafeInteger(s.points) || (s.points as number) < 1
      || typeof s.startFreq !== 'number' || !Number.isFinite(s.startFreq) || s.startFreq <= 0
      || typeof s.stopFreq !== 'number' || !Number.isFinite(s.stopFreq) || s.stopFreq < s.startFreq) impedanceInvalid('Expected a finite positive AC sweep');
    sweep = { type: 'ac', ...s } as ACAnalysis;
  }
  if (a.spotFrequenciesHz !== undefined && (!Array.isArray(a.spotFrequenciesHz) || a.spotFrequenciesHz.length > 128 || !a.spotFrequenciesHz.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0))) impedanceInvalid('Expected at most 128 positive finite spot frequencies');
  return { port, sweep, includeAdmittance: a.includeAdmittance as boolean | undefined, spotFrequenciesHz: a.spotFrequenciesHz as number[] | undefined };
}
export function impedancePlan(request: SimulationRequestV1, sweep: ACAnalysis): SimulationRequestV1 {
  // Reuse the standard bounded AC point estimator without executing a user deck during preflight.
  return { ...request, input: { format: 'spice', source: `.ac ${sweep.variation} ${sweep.points} ${sweep.startFreq} ${sweep.stopFreq}` } };
}
export function impedanceReport(s: ImpedanceSpectrum, selectors: ImpedanceSelectors) {
  if (!s.frequencyHz.length || s.positive.length !== s.frequencyHz.length || s.negative.length !== s.frequencyHz.length) impedanceInvalid('Incomplete impedance spectrum');
  const points = s.frequencyHz.map((frequencyHz, i) => {
    const p = s.positive[i]; const n = s.negative[i];
    const angle = Math.PI / 180;
    const resistanceOhm = p.magnitude * Math.cos(p.phaseDegrees * angle) - n.magnitude * Math.cos(n.phaseDegrees * angle);
    const reactanceOhm = p.magnitude * Math.sin(p.phaseDegrees * angle) - n.magnitude * Math.sin(n.phaseDegrees * angle);
    const magnitudeOhm = Math.hypot(resistanceOhm, reactanceOhm);
    const phaseDeg = Math.atan2(reactanceOhm, resistanceOhm) / angle;
    if (![frequencyHz, resistanceOhm, reactanceOhm, magnitudeOhm, phaseDeg].every(Number.isFinite)) impedanceInvalid('Non-finite impedance spectrum');
    const point = { frequencyHz, resistanceOhm, reactanceOhm, magnitudeOhm, phaseDeg };
    if (!selectors.includeAdmittance) return point;
    const scale = Math.max(Math.abs(resistanceOhm), Math.abs(reactanceOhm));
    if (scale === 0) impedanceInvalid('Cannot compute admittance of zero impedance');
    const re = resistanceOhm / scale; const im = reactanceOhm / scale;
    const denominator = re * re + im * im;
    const conductanceS = (re / denominator) / scale;
    const susceptanceS = (-im / denominator) / scale;
    if (![conductanceS, susceptanceS].every(Number.isFinite)
      || (resistanceOhm !== 0 && conductanceS === 0)
      || (reactanceOhm !== 0 && susceptanceS === 0)) impedanceInvalid('Admittance is not representable');
    return { ...point, conductanceS, susceptanceS };
  });
  let min = points[0]; let max = points[0];
  const resonanceHz: number[] = [];
  // Only isolated zero crossings, never a flat zero-phase resistor or a +/-180-degree wrap.
  for (let i = 0; i < points.length; i++) {
    const p = points[i]; const prev = points[i - 1]; const next = points[i + 1];
    if (p.magnitudeOhm < min.magnitudeOhm) min = p;
    if (p.magnitudeOhm > max.magnitudeOhm) max = p;
    if (p.phaseDeg === 0 && prev && next && prev.phaseDeg * next.phaseDeg < 0 && p.magnitudeOhm > 0) resonanceHz.push(p.frequencyHz);
    if (prev && prev.phaseDeg * p.phaseDeg < 0 && Math.abs(p.phaseDeg - prev.phaseDeg) < 180) {
      const fraction = -prev.phaseDeg / (p.phaseDeg - prev.phaseDeg);
      resonanceHz.push(selectors.sweep?.variation === 'lin'
        ? prev.frequencyHz + fraction * (p.frequencyHz - prev.frequencyHz)
        : Math.exp(Math.log(prev.frequencyHz) + fraction * Math.log(p.frequencyHz / prev.frequencyHz)));
    }
  }
  const extreme = (p: typeof min) => ({ magnitudeOhm: p.magnitudeOhm, frequencyHz: p.frequencyHz });
  const spots = selectors.spotFrequenciesHz?.map(frequencyHz => {
    const index = points.findIndex(p => p.frequencyHz >= frequencyHz);
    if (index < 0 || frequencyHz < points[0].frequencyHz) return { frequencyHz, resistanceOhm: null, reactanceOhm: null, magnitudeOhm: null, phaseDeg: null, outOfRange: true };
    const upper = points[index];
    if (upper.frequencyHz === frequencyHz) return { frequencyHz, resistanceOhm: upper.resistanceOhm, reactanceOhm: upper.reactanceOhm, magnitudeOhm: upper.magnitudeOhm, phaseDeg: upper.phaseDeg, outOfRange: false };
    const lower = points[index - 1];
    // log1p preserves nearby frequency differences; log subtraction avoids overflow for wide spans.
    const logRatio = (value: number) => {
      const relative = (value - lower.frequencyHz) / lower.frequencyHz;
      return Number.isFinite(relative) ? Math.log1p(relative) : Math.log(value) - Math.log(lower.frequencyHz);
    };
    const fraction = selectors.sweep?.variation === 'lin'
      ? (frequencyHz - lower.frequencyHz) / (upper.frequencyHz - lower.frequencyHz)
      : logRatio(frequencyHz) / logRatio(upper.frequencyHz);
    const resistanceOhm = lower.resistanceOhm + fraction * (upper.resistanceOhm - lower.resistanceOhm);
    const reactanceOhm = lower.reactanceOhm + fraction * (upper.reactanceOhm - lower.reactanceOhm);
    return { frequencyHz, resistanceOhm, reactanceOhm, magnitudeOhm: Math.hypot(resistanceOhm, reactanceOhm), phaseDeg: Math.atan2(reactanceOhm, resistanceOhm) * 180 / Math.PI, outOfRange: false };
  });
  return { port: selectors.port, points, summary: { min: extreme(min), max: extreme(max), resonanceHz }, ...(spots === undefined ? {} : { spots }) };
}
