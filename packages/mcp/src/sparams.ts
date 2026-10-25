import type { SParameterResult } from '@spice-ts/core';
import type { JsonObject, SimulationRequestV1 } from '@spice-ts/core/protocol';
import { commonSchemaV1 } from '@spice-ts/core/protocol';

// Only this tool accepts native SP analyses on circuit-json inputs.
export const sparamsRequestDefs = structuredClone(commonSchemaV1.$defs);
const sparamsSimulationInput = sparamsRequestDefs.simulationInput as { oneOf: { properties: Record<string, unknown> }[] };
sparamsSimulationInput.oneOf[2].properties.analyses = { type: 'array', items: { $ref: '#/$defs/nativeAnalysis' } };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate original input before schema/conversion can obscure its JSON pointers. */
export function validateSparamsPorts(request: SimulationRequestV1): void {
  const input = request.input;
  if (input.format === 'spice') return;
  const native = input.format === 'spice-ts';
  const document: unknown = native ? input.document : undefined;
  const circuit = isObject(document) ? document.circuit : undefined;
  const components: unknown = native ? (isObject(circuit) ? circuit.components : undefined) : input.circuit;
  if (!Array.isArray(components)) return; // Let the request schema report malformed containers.
  const base = native ? '/input/document/circuit/components' : '/input/circuit';
  const ports: { number: number; path: string }[] = [];
  const seen = new Set<number>();
  components.forEach((component: unknown, index: number) => {
    if (!isObject(component) || (native ? typeof component.type !== 'string' || component.type.toUpperCase() !== 'V'
      : component.type !== 'source_component' || component.ftype !== 'simple_voltage_source')) return;
    const metadata = native ? component.params : component;
    if (!isObject(metadata)) return;
    const path = `${base}/${index}${native ? '/params' : ''}`;
    if ('portnum' in metadata && (typeof metadata.portnum !== 'number' || !Number.isFinite(metadata.portnum)
      || !Number.isInteger(metadata.portnum) || metadata.portnum <= 0)) {
      sparamsInvalid('portnum must be a positive finite integer', `${path}/portnum`);
    }
    if ('z0' in metadata) {
      if (typeof metadata.z0 !== 'number' || !Number.isFinite(metadata.z0) || metadata.z0 <= 0) {
        sparamsInvalid('z0 must be a positive finite number', `${path}/z0`);
      }
      if (!('portnum' in metadata)) sparamsInvalid('z0 requires portnum', `${path}/z0`);
    }
    if (typeof metadata.portnum === 'number') {
      if (seen.has(metadata.portnum)) sparamsInvalid('Duplicate RF port number', `${path}/portnum`);
      seen.add(metadata.portnum);
      ports.push({ number: metadata.portnum, path: `${path}/portnum` });
    }
  });
  if (ports.length < 2) sparamsInvalid('S-parameters require at least two RF ports', base);
  ports.sort((a, b) => a.number - b.number).forEach((port, index) => {
    if (port.number !== index + 1) sparamsInvalid('RF port numbers must be contiguous starting at 1', port.path);
  });
}

/** RF metadata is an MCP S-parameter extension, not a shared circuit-json contract. */
export function prepareSparamsRequest(request: SimulationRequestV1): SimulationRequestV1 {
  if (request.input.format !== 'circuit-json' || !Array.isArray(request.input.circuit)) return request;
  return { ...request, input: { ...request.input, circuit: request.input.circuit.map(element => {
    if (!isObject(element) || element.type !== 'source_component'
      || element.ftype !== 'simple_voltage_source') return element;
    const { portnum: _portnum, z0: _z0, ...rest } = element;
    return rest;
  }) } };
}

export function mapSparamsPorts(original: SimulationRequestV1, converted: SimulationRequestV1): SimulationRequestV1 {
  if (original.input.format !== 'circuit-json' || converted.input.format !== 'spice-ts') return converted;
  const metadata = new Map(original.input.circuit.filter(isObject).filter(element => element.type === 'source_component'
    && element.ftype === 'simple_voltage_source').map(element => [element.source_component_id, element]));
  const document = converted.input.document;
  return { ...converted, input: { ...converted.input, document: { ...document, circuit: { ...document.circuit,
    components: document.circuit.components.map(component => {
      const source = metadata.get(component.id);
      return source ? { ...component, params: { ...component.params,
        ...(source.portnum !== undefined ? { portnum: source.portnum } : {}),
        ...(source.z0 !== undefined ? { z0: source.z0 } : {}),
      } } : component;
    }),
  } } } };
}

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
export function sparamsInvalid(message: string, path?: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: path ? { path } : {} };
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
