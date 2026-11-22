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
  // Native instances may contain additional ports. Check the aggregate in the
  // bounded worker after compilation rather than expanding an untrusted graph here.
  if (native && components.some(component => isObject(component) && typeof component.type === 'string'
    && component.type.toUpperCase() === 'X')) return;
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
  includeGroupDelay?: boolean;
  includeReciprocity?: boolean;
  includeStability?: boolean;
}
export const sparamsInputSchema = {
  type: 'object', additionalProperties: false, required: ['netlist'],
  properties: {
    netlist: { type: 'string', minLength: 1 },
    portPair: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 } },
    frequenciesHz: { type: 'array', minItems: 1, items: { type: 'number', exclusiveMinimum: 0 } },
    includeGroupDelay: { type: 'boolean', description: 'Include backward sampled phase-secant group delay in seconds. Phase wrapping can alias delay; this is not a continuous or alias-free estimate. Explicit frequencies are separate one-point segments and produce null delays.' },
    includeReciprocity: { type: 'boolean', description: 'Include the absolute dimensionless complex difference |Sij - Sji| at each sample. It depends on reference normalization; unequal-reference matrices cannot generally be judged reciprocal from this metric. This is not a dB ratio, passivity test or categorical verdict.' },
    includeStability: { type: 'boolean', description: 'Include sampled two-port Rollett stability metrics for equal positive real references. Not a global stability guarantee.' },
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
        stability: {
          type: 'object', additionalProperties: false, required: ['delta', 'deltaMagnitude', 'rollettK', 'reason'],
          description: 'Sampled two-port criterion only. Null K means undefined or nonrepresentable, not unstable.',
          properties: {
            delta: { anyOf: [{ type: 'object', additionalProperties: false, required: ['real', 'imaginary'], properties: { real: { type: 'number' }, imaginary: { type: 'number' } } }, { type: 'null' }] },
            deltaMagnitude: nullable, rollettK: nullable,
            reason: { type: ['string', 'null'], description: 'Why K or delta is null, if applicable.' },
          },
        },
        parameters: { type: 'object', additionalProperties: {
          type: 'object', additionalProperties: false, required: ['real', 'imaginary', 'magnitude', 'magnitudeDb', 'phaseDeg'],
          properties: { real: { type: 'number' }, imaginary: { type: 'number' }, magnitude: { type: 'number' }, magnitudeDb: nullable, phaseDeg: nullable,
            returnLossDb: nullable, insertionLossDb: nullable, vswr: nullable, groupDelaySeconds: nullable,
            reciprocityDifferenceMagnitude: { ...nullable, description: 'Absolute complex difference |Sij - Sji|, dimensionless. Null when the reverse sample is missing or nonfinite, or subtraction or magnitude is not representable as a finite number. Depends on reference normalization.' } },
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
  if (Object.keys(a).some(k => !['netlist', 'portPair', 'frequenciesHz', 'includeGroupDelay', 'includeReciprocity', 'includeStability'].includes(k))
    || typeof a.netlist !== 'string' || !a.netlist.trim()
    || (a.includeGroupDelay !== undefined && typeof a.includeGroupDelay !== 'boolean')
    || (a.includeReciprocity !== undefined && typeof a.includeReciprocity !== 'boolean')
    || (a.includeStability !== undefined && typeof a.includeStability !== 'boolean')
    || (a.portPair !== undefined && (!Array.isArray(a.portPair) || a.portPair.length !== 2
      || !a.portPair.every(p => Number.isInteger(p) && p > 0)))
    || (a.frequenciesHz !== undefined && (!Array.isArray(a.frequenciesHz) || !a.frequenciesHz.length
      || !a.frequenciesHz.every(f => typeof f === 'number' && Number.isFinite(f) && f > 0)))) {
    sparamsInvalid('Expected netlist, optional one-based portPair [output,input], and positive finite frequenciesHz');
  }
  return a as unknown as SparamsArgs;
}
function sampledStability(result: SParameterResult, index: number) {
  const [a, b, c, d] = ['S_1_1', 'S_1_2', 'S_2_1', 'S_2_2'].map(key => result.vectors.get(key)![index]);
  let real = (a.real * d.real - a.imaginary * d.imaginary) - (b.real * c.real - b.imaginary * c.imaginary);
  let imaginary = (a.real * d.imaginary + a.imaginary * d.real) - (b.real * c.imaginary + b.imaginary * c.real);
  if (!Number.isFinite(real) || !Number.isFinite(imaginary)) {
    // Scale before multiplying to permit cancellation of otherwise overflowing products.
    const scale = Math.max(...[a, b, c, d].flatMap(v => [Math.abs(v.real), Math.abs(v.imaginary)]));
    const [x, y, z, w] = [a, b, c, d].map(v => ({ real: v.real / scale, imaginary: v.imaginary / scale }));
    // Never overwrite a directly representable component with a lossy scaled one.
    // If a nonzero product vanishes under scaling, report an unrepresentable
    // determinant rather than silently dropping a term after cancellation.
    const lost = (p: number, q: number, sp: number, sq: number) => p !== 0 && q !== 0 && sp * sq === 0;
    if (!Number.isFinite(real)) {
      real = lost(a.real, d.real, x.real, w.real) || lost(a.imaginary, d.imaginary, x.imaginary, w.imaginary)
        || lost(b.real, c.real, y.real, z.real) || lost(b.imaginary, c.imaginary, y.imaginary, z.imaginary)
        ? NaN : ((x.real * w.real - x.imaginary * w.imaginary) - (y.real * z.real - y.imaginary * z.imaginary)) * scale * scale;
    }
    if (!Number.isFinite(imaginary)) {
      imaginary = lost(a.real, d.imaginary, x.real, w.imaginary) || lost(a.imaginary, d.real, x.imaginary, w.real)
        || lost(b.real, c.imaginary, y.real, z.imaginary) || lost(b.imaginary, c.real, y.imaginary, z.real)
        ? NaN : ((x.real * w.imaginary + x.imaginary * w.real) - (y.real * z.imaginary + y.imaginary * z.real)) * scale * scale;
    }
  }
  // Detect cancellation of rounded products, including products that round to
  // the same value despite having different exact factors. Identical factor
  // pairs with opposite signs cancel exactly and need no warning.
  const unreliable = (terms: [number, number, number][], component: number) => {
    const remaining = terms.filter(([p, q]) => p !== 0 && q !== 0);
    for (let i = remaining.length - 1; i >= 0; i--) {
      const [p, q, sign] = remaining[i];
      const j = remaining.findIndex(([r, s, other], n) => n < i && sign === -other
        && ((p === r && q === s) || (p === s && q === r)));
      if (j >= 0) { remaining.splice(i, 1); remaining.splice(j, 1); i--; }
    }
    // Individually rounded subnormal products (including underflow to zero)
    // can corrupt even an exactly representable final difference.
    if (remaining.some(([p, q]) => Math.abs(p * q) < 2 ** -1022)) return true;
    if (remaining.length < 2) return false;
    const scale = Math.max(...remaining.flatMap(([p, q]) => [Math.abs(p), Math.abs(q)]));
    const sum = remaining.reduce((v, [p, q]) => v + Math.abs((p / scale) * (q / scale)), 0);
    return Math.abs((component / scale) / scale) <= 8 * Number.EPSILON * sum;
  };
  if (unreliable([[a.real, d.real, 1], [a.imaginary, d.imaginary, -1], [b.real, c.real, -1], [b.imaginary, c.imaginary, 1]], real)
    || unreliable([[a.real, d.imaginary, 1], [a.imaginary, d.real, 1], [b.real, c.imaginary, -1], [b.imaginary, c.real, -1]], imaginary)) {
    return { delta: null, deltaMagnitude: null, rollettK: null, reason: 'Delta could not be computed reliably due to cancellation or products too small to be representable at full precision.' };
  }
  const deltaMagnitude = Math.hypot(real, imaginary);
  if (!Number.isFinite(real) || !Number.isFinite(imaginary) || !Number.isFinite(deltaMagnitude)) {
    return { delta: null, deltaMagnitude: null, rollettK: null, reason: 'Delta calculation overflowed or could not be computed reliably as a finite number.' };
  }
  const delta = { real, imaginary };
  const bMag = Math.hypot(b.real, b.imaginary), cMag = Math.hypot(c.real, c.imaginary);
  if (bMag === 0 || cMag === 0) return { delta, deltaMagnitude, rollettK: null, reason: 'Zero transmission makes K undefined.' };
  const scale = Math.max(1, Math.hypot(a.real, a.imaginary), Math.hypot(d.real, d.imaginary), deltaMagnitude);
  const numerator = (1 / scale) ** 2 - (Math.hypot(a.real, a.imaginary) / scale) ** 2
    - (Math.hypot(d.real, d.imaginary) / scale) ** 2 + (deltaMagnitude / scale) ** 2;
  // Cancellation can erase the determinant's contribution before division by a
  // very small transmission product. Do not report a precise-looking K when
  // the numerator is within the floating-point error of its contributing terms.
  const aScaled = Math.hypot(a.real, a.imaginary) / scale;
  const dScaled = Math.hypot(d.real, d.imaginary) / scale;
  const deltaScaled = deltaMagnitude / scale;
  const errorScale = (1 / scale) ** 2 + aScaled ** 2 + dScaled ** 2 + deltaScaled ** 2
    + 2 * deltaScaled * (aScaled * dScaled + (bMag / scale) * (cMag / scale));
  if (Math.abs(numerator) <= 16 * Number.EPSILON * errorScale) {
    return { delta, deltaMagnitude, rollettK: null, reason: 'K numerator could not be computed reliably due to cancellation.' };
  }
  const denominator = 2 * ((bMag / scale) * (cMag / scale));
  // Subnormal division can lose most of the denominator's significant bits.
  if (denominator > 0 && denominator < 2 ** -1021) {
    return { delta, deltaMagnitude, rollettK: null, reason: 'K denominator could not be computed reliably at subnormal precision.' };
  }
  let k = numerator / denominator;
  if (!Number.isFinite(k) || !Number.isFinite(denominator) || denominator === 0 || (k === 0 && numerator !== 0)) {
    // Avoid under/overflow in the denominator when K itself remains representable.
    k = numerator === 0 ? 0 : Math.sign(numerator) * Math.exp(Math.log(Math.abs(numerator)) + 2 * Math.log(scale) - Math.log(2) - Math.log(bMag) - Math.log(cMag));
  }
  return Number.isFinite(k) && (k !== 0 || numerator === 0)
    ? { delta, deltaMagnitude, rollettK: k, reason: null }
    : { delta, deltaMagnitude, rollettK: null, reason: 'K is not representable as a finite number.' };
}

export function sparamsReport(results: SParameterResult[], args: SparamsArgs) {
  const { ports, referenceImpedances } = results[0];
  if (args.includeStability) {
    for (const result of results) {
      if (result.ports.length !== 2 || result.referenceImpedances.length !== 2
        || !Number.isFinite(result.referenceImpedances[0]) || result.referenceImpedances[0] <= 0
        || result.referenceImpedances[0] !== result.referenceImpedances[1]) {
        sparamsInvalid('Stability requires two ports with equal positive finite real references');
      }
      for (const key of ['S_1_1', 'S_1_2', 'S_2_1', 'S_2_2']) {
        const vector = result.vectors.get(key);
        if (!vector || result.frequencies.some((_, i) => !vector[i] || !Number.isFinite(vector[i].real) || !Number.isFinite(vector[i].imaginary))) {
          sparamsInvalid('Stability requires all four finite complex S-parameters at every sample');
        }
      }
    }
  }
  if (args.portPair?.some(p => p > ports.length)) sparamsInvalid('Port index exceeds the number of RF ports');
  const pairs = args.portPair ? [args.portPair] : ports.flatMap((_, i) => ports.map((__, j) => [i + 1, j + 1]));
  return {
    ports, referenceImpedancesOhm: referenceImpedances,
    points: results.flatMap(result => result.frequencies.map((frequencyHz, index) => ({
      frequencyHz,
      ...(args.includeStability ? { stability: sampledStability(result, index) } : {}),
      parameters: Object.fromEntries(pairs.map(([i, j]) => {
        const vector = result.vectors.get(`S_${i}_${j}`)?.[index];
        if (!vector || !Number.isFinite(vector.real) || !Number.isFinite(vector.imaginary)) {
          throw new Error('Invalid S-parameter vector');
        }
        const { real, imaginary } = vector;
        const magnitude = Math.hypot(real, imaginary);
        if (!Number.isFinite(magnitude)) throw new Error('Invalid S-parameter magnitude');
        const magnitudeDb = magnitude === 0 ? null : 20 * Math.log10(magnitude);
        // Keep conventional two-digit names, but delimit multi-digit indices to avoid collisions.
        const key = i >= 10 || j >= 10 ? `S_${i}_${j}` : `S${i}${j}`;
        let reciprocityDifferenceMagnitude: number | null = null;
        if (args.includeReciprocity) {
          const reverse = result.vectors.get(`S_${j}_${i}`)?.[index];
          if (reverse && Number.isFinite(reverse.real) && Number.isFinite(reverse.imaginary)) {
            const difference = Math.hypot(real - reverse.real, imaginary - reverse.imaginary);
            if (Number.isFinite(difference)) reciprocityDifferenceMagnitude = difference;
          }
        }
        let groupDelaySeconds: number | null = null;
        if (args.includeGroupDelay && index > 0 && magnitude !== 0) {
          const previous = result.vectors.get(`S_${i}_${j}`)?.[index - 1];
          const spacing = frequencyHz - result.frequencies[index - 1];
          if (previous && (previous.real !== 0 || previous.imaginary !== 0) && Number.isFinite(spacing) && spacing > 0) {
            let phase = Math.atan2(imaginary, real) - Math.atan2(previous.imaginary, previous.real);
            if (phase > Math.PI) phase -= 2 * Math.PI;
            if (phase < -Math.PI) phase += 2 * Math.PI;
            if (Math.abs(phase) !== Math.PI) {
              const delay = (-phase / (2 * Math.PI)) / spacing;
              if (Number.isFinite(delay)) groupDelaySeconds = delay;
            }
          }
        }
        return [key, {
          real, imaginary, magnitude, magnitudeDb, phaseDeg: magnitude === 0 ? null : Math.atan2(imaginary, real) * 180 / Math.PI,
          ...(args.includeGroupDelay ? { groupDelaySeconds } : {}),
          ...(args.includeReciprocity ? { reciprocityDifferenceMagnitude } : {}),
          ...(i === j ? { returnLossDb: magnitudeDb === null ? null : -magnitudeDb,
            vswr: magnitude < 1 ? (1 + magnitude) / (1 - magnitude) : null }
            : { insertionLossDb: magnitudeDb === null ? null : -magnitudeDb }),
        }];
      })),
    }))),
  };
}
