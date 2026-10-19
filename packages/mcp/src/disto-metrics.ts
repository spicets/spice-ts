import { DistortionResult } from '@spice-ts/core';
import type { ComplexDistortionValue, DistortionProduct } from '@spice-ts/core';

/** Structured-clone representation of core's result across the worker boundary. */
export interface DistoSpectrum {
  frequencies: number[];
  voltageArrays: Map<DistortionProduct, Map<string, ComplexDistortionValue[]>>;
  currentArrays: Map<DistortionProduct, Map<string, ComplexDistortionValue[]>>;
  f2OverF1?: number;
}
const nullableNumber = { type: ['number', 'null'] };
export const distoMetricsOutputSchema = {
  type: 'object', additionalProperties: false,
  required: ['output', 'magnitudeUnit', 'decibelReference', 'f2Hz', 'products'],
  properties: {
    output: { type: 'string' }, magnitudeUnit: { const: 'V' }, decibelReference: { const: '1 V' }, f2Hz: nullableNumber,
    products: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['product', 'points'],
      properties: {
        product: { enum: ['HD2', 'HD3', 'SIM2', 'DIM2', 'DIM3'] },
        points: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          required: ['frequencyHz', 'real', 'imaginary', 'magnitude', 'magnitudeDb', 'phaseDeg'],
          properties: { frequencyHz: { type: 'number' }, real: { type: 'number' }, imaginary: { type: 'number' },
            magnitude: { type: 'number', minimum: 0 }, magnitudeDb: nullableNumber, phaseDeg: nullableNumber },
        } },
      },
    } },
  },
};
// Tool-local code: protocol v1 does not define UNSUPPORTED_ANALYSIS.
export const distoUnsupportedSchema = {
  type: 'object', additionalProperties: false, required: ['error'], properties: {
    error: { type: 'object', additionalProperties: false, required: ['code', 'message', 'phase', 'retryable', 'details'],
      properties: { code: { const: 'UNSUPPORTED_ANALYSIS' }, message: { type: 'string' }, phase: { const: 'validation' },
        retryable: { const: false }, details: { type: 'object' } } },
  },
};
export function unsupportedDisto(): never {
  throw { code: 'UNSUPPORTED_ANALYSIS', message: 'Distortion metrics require exactly one unstepped .disto without control blocks or .pz', phase: 'validation', retryable: false, details: {} };
}
export function distoOutput(args: unknown): string {
  const a = args as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a)
    || Object.keys(a).some(k => !['request', 'output'].includes(k))
    || typeof a.output !== 'string' || !/^v\([^\s(),]+\)$/i.test(a.output)) {
    throw { code: 'INVALID_REQUEST', message: 'Expected output v(node)', phase: 'validation', retryable: false, details: {} };
  }
  return a.output;
}
export function distoMetrics(spectrum: DistoSpectrum, output: string) {
  const result = new DistortionResult(spectrum.frequencies, spectrum.voltageArrays, spectrum.currentArrays, spectrum.f2OverF1);
  const names = { 2: 'HD2', 3: 'HD3', 'f1+f2': 'SIM2', 'f1-f2': 'DIM2', '2f1-f2': 'DIM3' };
  const products = result.products.map(product => {
    let values: ComplexDistortionValue[];
    try { values = result.voltage(output.slice(2, -1), product); } catch {
      throw { code: 'INVALID_REQUEST', message: `Unknown output node: ${output}`, phase: 'validation', retryable: false, details: {} };
    }
    return { product: names[product], points: values.map((value, i) => {
      const magnitude = Math.hypot(value.real, value.imaginary);
      if (![value.real, value.imaginary, magnitude].every(Number.isFinite)) {
        throw { code: 'INVALID_REQUEST', message: 'Non-finite distortion result', phase: 'serialize', retryable: false, details: {} };
      }
      return { frequencyHz: result.frequencies[i], ...value, magnitude,
        magnitudeDb: magnitude === 0 ? null : 20 * Math.log10(magnitude),
        phaseDeg: magnitude === 0 ? null : Math.atan2(value.imaginary, value.real) * 180 / Math.PI };
    }) };
  });
  return { output, magnitudeUnit: 'V', decibelReference: '1 V',
    f2Hz: result.f2OverF1 === undefined ? null : result.frequencies[0] * result.f2OverF1, products };
}
