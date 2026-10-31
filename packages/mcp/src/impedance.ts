import type { AnalysisDirective } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { paramsSchema } from './params.js';

type ACAnalysis = Extract<AnalysisDirective, { type: 'ac' }>;

export interface ImpedanceSelectors { port: { positive: string; negative: string }; sweep?: ACAnalysis; includeAdmittance?: boolean }
export interface ImpedanceSpectrum { frequencyHz: number[]; positive: { magnitude: number; phaseDegrees: number }[]; negative: { magnitude: number; phaseDegrees: number }[] }
export const impedanceProperties = {
  includeAdmittance: { type: 'boolean' },
  port: { type: 'object', additionalProperties: false, required: ['positive', 'negative'], properties: {
    positive: { type: 'string', minLength: 1, maxLength: 256 }, negative: { type: 'string', minLength: 1, maxLength: 256 },
  } },
  sweep: { type: 'object', additionalProperties: false, required: ['variation', 'points', 'startFreq', 'stopFreq'], properties: {
    variation: { enum: ['dec', 'oct', 'lin'] }, points: { type: 'integer', minimum: 1 }, startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 },
  } }, params: paramsSchema,
};
const number = { type: 'number' };
const extremum = { type: 'object', additionalProperties: false, required: ['magnitudeOhm', 'frequencyHz'], properties: { magnitudeOhm: number, frequencyHz: number } };
export const impedanceOutputSchema = {
  type: 'object', additionalProperties: false, required: ['port', 'points', 'summary'], properties: {
    port: impedanceProperties.port,
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
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['request', 'port', 'sweep', 'params', 'includeAdmittance'].includes(k))) impedanceInvalid('Expected request, port and optional sweep/params/includeAdmittance');
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
  return { port, sweep, includeAdmittance: a.includeAdmittance as boolean | undefined };
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
  return { port: selectors.port, points, summary: { min: extreme(min), max: extreme(max), resonanceHz } };
}
