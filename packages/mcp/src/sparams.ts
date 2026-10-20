import type { SParameterResult } from '@spice-ts/core';

export interface SparamsArgs {
  netlist: string;
  /** One-based [output port, input port]. Omit to return the full matrix. */
  portPair?: [number, number];
  frequenciesHz?: number[];
}
export const sparamsInputSchema = {
  type: 'object', additionalProperties: false, required: ['netlist'],
  properties: {
    netlist: { type: 'string', minLength: 1 },
    portPair: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 } },
    frequenciesHz: { type: 'array', minItems: 1, items: { type: 'number', exclusiveMinimum: 0 } },
  },
};
const nullable = { type: ['number', 'null'] };
export const sparamsOutputSchema = {
  type: 'object', additionalProperties: false, required: ['ports', 'referenceImpedancesOhm', 'points'],
  properties: {
    ports: { type: 'array', items: { type: 'string' } },
    referenceImpedancesOhm: { type: 'array', items: { type: 'number' } },
    points: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['frequencyHz', 'parameters'],
      properties: {
        frequencyHz: { type: 'number' },
        parameters: { type: 'object', additionalProperties: {
          type: 'object', additionalProperties: false, required: ['magnitude', 'magnitudeDb', 'phaseDeg'],
          properties: { magnitude: { type: 'number' }, magnitudeDb: nullable, phaseDeg: nullable,
            returnLossDb: nullable, insertionLossDb: nullable, vswr: nullable },
        } },
      },
    } },
  },
};
export function sparamsInvalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} };
}
export function sparamsArgs(args: unknown): SparamsArgs {
  if (!args || typeof args !== 'object' || Array.isArray(args)) sparamsInvalid('Expected S-parameter arguments');
  const a = args as Record<string, unknown>;
  if (Object.keys(a).some(k => !['netlist', 'portPair', 'frequenciesHz'].includes(k))
    || typeof a.netlist !== 'string' || !a.netlist.trim()
    || (a.portPair !== undefined && (!Array.isArray(a.portPair) || a.portPair.length !== 2
      || !a.portPair.every(p => Number.isInteger(p) && p > 0)))
    || (a.frequenciesHz !== undefined && (!Array.isArray(a.frequenciesHz) || !a.frequenciesHz.length
      || !a.frequenciesHz.every(f => typeof f === 'number' && Number.isFinite(f) && f > 0)))) {
    sparamsInvalid('Expected netlist, optional one-based portPair [output,input], and positive finite frequenciesHz');
  }
  return a as unknown as SparamsArgs;
}
export function sparamsReport(results: SParameterResult[], args: SparamsArgs) {
  const { ports, referenceImpedances } = results[0];
  if (args.portPair?.some(p => p > ports.length)) sparamsInvalid('Port index exceeds the number of RF ports');
  const pairs = args.portPair ? [args.portPair] : ports.flatMap((_, i) => ports.map((__, j) => [i + 1, j + 1]));
  return {
    ports, referenceImpedancesOhm: referenceImpedances,
    points: results.flatMap(result => result.frequencies.map((frequencyHz, index) => ({
      frequencyHz,
      parameters: Object.fromEntries(pairs.map(([i, j]) => {
        const { real, imaginary } = result.vectors.get(`S_${i}_${j}`)![index];
        const magnitude = Math.hypot(real, imaginary);
        const magnitudeDb = magnitude === 0 ? null : 20 * Math.log10(magnitude);
        // Keep conventional two-digit names, but delimit multi-digit indices to avoid collisions.
        const key = i >= 10 || j >= 10 ? `S_${i}_${j}` : `S${i}${j}`;
        return [key, {
          magnitude, magnitudeDb, phaseDeg: magnitude === 0 ? null : Math.atan2(imaginary, real) * 180 / Math.PI,
          ...(i === j ? { returnLossDb: magnitudeDb === null ? null : -magnitudeDb,
            vswr: magnitude < 1 ? (1 + magnitude) / (1 - magnitude) : null }
            : { insertionLossDb: magnitudeDb === null ? null : -magnitudeDb }),
        }];
      })),
    }))),
  };
}
