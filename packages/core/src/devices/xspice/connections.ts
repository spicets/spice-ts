import { InvalidCircuitError } from '../../errors.js';
import type { XspiceInstanceCard, XspiceModelCard, XspiceToken } from '../../parser/xspice-parser.js';
import type { XspiceAnalogPortType, XspiceCodeModelSpec, XspiceParamValue, XspicePortType } from './spec.js';

/** One port of an A instance after its port type was applied. */
export interface XspicePort {
  readonly type: XspicePortType;
  /** Positive node name (v, vd, i, id), or the digital node (d). */
  readonly positive?: string;
  /** Negative node name; ground for single-ended types. */
  readonly negative?: string;
  /** Controlling voltage source name (vnam). */
  readonly source?: string;
  /** A `~` before a digital node: the port reads (or drives) the inverted state. */
  readonly invert?: boolean;
}

export interface XspiceConnection {
  readonly name: string;
  readonly direction: 'in' | 'out' | 'inout';
  readonly isNull: boolean;
  readonly ports: readonly XspicePort[];
}

const SINGLE_ENDED = new Set(['v', 'i', 'g', 'h']);
const DIFFERENTIAL = new Set(['vd', 'id', 'gd', 'hd']);

/**
 * Read an A-card's connection tokens against the code model's port table,
 * as ngspice MIF_INP2A / MIFget_port do: an optional `%type` per connection
 * (and per vector element), `[ ... ]` for vector connections, `null` where the
 * table allows it, two nodes for differential types and one (plus ground)
 * for single-ended types.
 *
 * @throws {@link InvalidCircuitError} for malformed connections or port types spice-ts does not stamp
 */
export function resolveXspiceConnections(
  card: XspiceInstanceCard,
  spec: XspiceCodeModelSpec,
  ground: string,
): XspiceConnection[] {
  const tokens = card.connectionTokens;
  let index = 0;
  const fail = (message: string): never => {
    throw new InvalidCircuitError(`XSPICE instance '${card.name}': ${message}`);
  };
  const next = (): XspiceToken | undefined => tokens[index];

  const readPortType = (allowed: readonly string[]): string => {
    index++; // '%'
    const token = tokens[index++];
    if (token === undefined || token.kind !== 'string') return fail('Invalid port type specifier');
    const type = token.text.toLowerCase();
    if (!allowed.includes(type)) return fail(`Port type ${type} is invalid`);
    return type;
  };

  const readPort = (type: string): XspicePort => {
    if (type === 'd' || type === 'real') {
      const invert = next()?.kind === 'tilde';
      if (invert) index++;
      const node = tokens[index++];
      if (node === undefined || node.kind !== 'string') return fail('Expected node/instance identifier');
      return { type, positive: node.text, invert };
    }
    if (next()?.kind === 'tilde') fail('Tilde not allowed on analog nodes');
    const first = tokens[index++];
    if (first === undefined || first.kind !== 'string') return fail('Expected node/instance identifier');
    if (type === 'vnam') return { type: 'vnam', source: first.text };
    if (SINGLE_ENDED.has(type)) {
      return { type: type as XspiceAnalogPortType, positive: first.text, negative: ground };
    }
    if (DIFFERENTIAL.has(type)) {
      const second = tokens[index++];
      if (second === undefined || second.kind !== 'string') return fail('Expected node identifier');
      return { type: type as XspiceAnalogPortType, positive: first.text, negative: second.text };
    }
    return fail(`port type '%${type}' is not supported by spice-ts (supported: %v, %vd, %i, %id, %vnam, %g, %gd)`);
  };

  const connections: XspiceConnection[] = [];
  for (const conn of spec.connections) {
    const base = { name: conn.name, direction: conn.direction };
    if (index >= tokens.length) {
      if (connections.length === 0 || !conn.nullAllowed) {
        fail('Encountered end of line before all required connections were found.');
      }
      connections.push({ ...base, isNull: true, ports: [] });
      continue;
    }
    let type = conn.defaultType;
    if (next()!.kind === 'percent') type = readPortType(conn.allowedTypes);
    if (next()?.kind === 'null') {
      if (!conn.nullAllowed) fail('NULL connection found where not allowed');
      index++;
      connections.push({ ...base, isNull: true, ports: [] });
      continue;
    }
    if (!conn.vector) {
      if (next()?.kind === 'larray') fail('Scalar connection expected, [ found');
      if (next()?.kind === 'rarray') fail('Unexpected ]');
      connections.push({ ...base, isNull: false, ports: [readPort(type)] });
      continue;
    }
    if (next()?.kind !== 'larray') fail('Missing [, an array connection was expected');
    index++;
    const ports: XspicePort[] = [];
    while (index < tokens.length && next()!.kind !== 'rarray') {
      if (next()!.kind === 'percent') type = readPortType(conn.allowedTypes);
      if (next()?.kind === 'null') fail('NULL connection found where not allowed');
      if (next()?.kind === 'larray') fail('Unexpected [ - Arrays of arrays not allowed');
      ports.push(readPort(type));
    }
    if (index >= tokens.length) fail('Missing ] in array connection');
    index++; // ']'
    if (ports.length < 1) fail('Array connection must have at least one port');
    const [min, max] = conn.vectorBounds ?? [undefined, undefined];
    if (min !== undefined && ports.length < min) fail('Too few ports in connection');
    if (max !== undefined && ports.length > max) fail('Too many ports in connection');
    connections.push({ ...base, isNull: false, ports });
  }
  if (index < tokens.length) {
    fail('Too many connections -- expecting model name but encountered other tokens.');
  }
  return connections;
}

/**
 * Fill parameter defaults and check sizes as ngspice MIFsetup/MIF_INP2A do:
 * an omitted vector parameter tied to a connection repeats its default once
 * per port; a given one must match the connection size; a parameter with no
 * default must be given.
 */
export function resolveXspiceParams(
  instanceName: string,
  model: XspiceModelCard,
  spec: XspiceCodeModelSpec,
  connections: readonly XspiceConnection[],
): Map<string, readonly XspiceParamValue[]> {
  const resolved = new Map<string, readonly XspiceParamValue[]>();
  for (const param of spec.params) {
    const connectionSize = param.sizeFromConnection === undefined
      ? undefined
      : connections.find(connection => connection.name === param.sizeFromConnection)!.ports.length;
    const given = model.params.get(param.name);
    if (given !== undefined) {
      if (connectionSize !== undefined && given.length !== connectionSize) {
        throw new InvalidCircuitError(
          `XSPICE instance '${instanceName}': Size of array parameter ${param.name} on model `
            + `${model.name} does not match connection size`,
        );
      }
      resolved.set(param.name, given);
      continue;
    }
    if (!param.nullAllowed) {
      throw new InvalidCircuitError(`Null not allowed for parameter '${param.name}' on model '${model.name}'.`);
    }
    if (param.defaultValue === undefined) {
      // ngspice MIFgetMod: a string parameter may stay NULL (PARAM_NULL).
      if (param.type === 'string') {
        resolved.set(param.name, []);
        continue;
      }
      throw new InvalidCircuitError(`Parameter '${param.name}' on model '${model.name}' has no default.`);
    }
    const size = param.vector
      ? connectionSize ?? Math.max(param.defaultValue.length, param.vectorBounds?.[0] ?? 0)
      : 1;
    const values: XspiceParamValue[] = [];
    for (let i = 0; i < size; i++) {
      values.push(param.defaultValue[Math.min(i, param.defaultValue.length - 1)]);
    }
    resolved.set(param.name, values);
  }
  return resolved;
}
