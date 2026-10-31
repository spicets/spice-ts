import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SimulationRequestV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';
import { overrideParameters } from './params.js';
import { measurementListSchema } from './measure.js';

export const MAX_SWEEP_POINTS = 100;
type SweepParameter = { kind: 'param' | 'component' | 'source' | 'temperature'; name: string };
type SweepPoint = { value: number; status: 'complete'; measurements?: unknown } | { value: number; status: 'failed'; error: unknown };

export const sweepProperties = {
  parameter: { type: 'object', required: ['kind', 'name'], additionalProperties: false, properties: {
    kind: { enum: ['param', 'component', 'source', 'temperature'] }, name: { type: 'string', minLength: 1 },
  }, allOf: [{ if: { properties: { kind: { const: 'temperature' } }, required: ['kind'] },
    then: { properties: { name: { const: 'temp' } } } }] },
  values: { type: 'array', minItems: 1, maxItems: MAX_SWEEP_POINTS, items: { type: 'number' } },
  range: { type: 'object', required: ['scale', 'start', 'stop', 'points'], additionalProperties: false, properties: {
    scale: { enum: ['lin', 'dec'] }, start: { type: 'number' }, stop: { type: 'number' }, points: { type: 'integer', minimum: 1 },
  } },
  measurements: measurementListSchema,
};

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} } satisfies SpiceApiErrorV1;
}
function cap(actual: number): void {
  if (actual > MAX_SWEEP_POINTS) throw { code: 'RESOURCE_LIMIT', message: 'Sweep point cap exceeded', phase: 'validation', retryable: false,
    details: { limit: 'maxSweepPoints', maximum: MAX_SWEEP_POINTS, actual } } satisfies SpiceApiErrorV1;
}

function sweepValues(args: Record<string, unknown>): number[] {
  if ((args.values === undefined) === (args.range === undefined)) invalid('Provide exactly one of values or range');
  if (args.values !== undefined) {
    if (!Array.isArray(args.values) || !args.values.length) invalid('values must be a nonempty finite-number list');
    cap(args.values.length);
    if (!args.values.every(finite)) invalid('values must be finite numbers');
    return args.values;
  }
  const r = args.range;
  if (!record(r) || Object.keys(r).some(k => !['scale', 'start', 'stop', 'points'].includes(k))
    || !finite(r.start) || !finite(r.stop) || !finite(r.points) || !Number.isInteger(r.points) || r.points < 1
    || !['lin', 'dec'].includes(r.scale as string)) invalid('Invalid sweep range');
  const { start, stop, points } = r as { start: number; stop: number; points: number };
  if (r.scale === 'lin') {
    cap(points);
    if (points === 1 && start !== stop) invalid('A single linear point requires start = stop');
    return Array.from({ length: points }, (_, i) => points === 1 ? start : i === points - 1 ? stop : start * (1 - i / (points - 1)) + stop * (i / (points - 1)));
  }
  if (start <= 0 || stop < start) invalid('dec requires 0 < start <= stop');
  // points means samples per decade; include the exact stop even for a partial decade.
  const intervals = (Math.log10(stop) - Math.log10(start)) * points;
  const count = Math.ceil(intervals - 1e-12) + 1;
  cap(count);
  return Array.from({ length: count }, (_, i) => i === count - 1 ? stop : 10 ** (Math.log10(start) + i / points));
}

/** Only top-level R/C/L scalar values are component targets, never models or subcircuit instances. */
export function overrideComponent(request: SimulationRequestV1, name: string, value: number): SimulationRequestV1 {
  const key = name.toLowerCase();
  const field = ({ r: 'resistance', c: 'capacitance', l: 'inductance' } as Record<string, string>)[key[0]];
  if (!field) invalid('Component sweeps support top-level R/C/L values only');
  if (request.input.format === 'spice') {
    if (typeof request.input.source !== 'string') invalid('Expected SPICE source');
    let depth = 0; let control = false; let matches = 0;
    const source = request.input.source.split(/\r?\n/).map(line => {
      if (/^\s*\.control\b/i.test(line)) control = true;
      if (/^\s*\.endc\b/i.test(line)) { control = false; return line; }
      if (control) return line;
      if (/^\s*\.subckt\b/i.test(line)) depth++;
      if (/^\s*\.ends\b/i.test(line)) { depth--; return line; }
      if (depth !== 0) return line;
      const match = /^(\s*)(\S+)(\s+\S+\s+\S+\s+)(\{[^}]*\}|'[^']*'|"[^"]*"|[^\s;$]+)(.*)$/.exec(line);
      if (!match || match[2].toLowerCase() !== key) return line;
      matches++;
      return `${match[1]}${match[2]}${match[3]}${value}${match[5]}`;
    }).join('\n');
    if (matches !== 1) invalid('Expected exactly one top-level component target');
    return { ...request, input: { ...request.input, source } };
  }
  if (request.input.format !== 'spice-ts') invalid('Component sweep requires SPICE text or native spice-ts JSON IR');
  const input = request.input;
  const components = input.document?.circuit?.components;
  if (!Array.isArray(components)) invalid('Expected native circuit components');
  const matches = components.filter(c => c.name.toLowerCase() === key);
  if (matches.length !== 1 || matches[0].type.toLowerCase() !== key[0]) invalid('Expected exactly one matching R/C/L component');
  return { ...request, input: { ...input, document: { ...input.document, circuit: { ...input.document.circuit,
    components: components.map(c => c === matches[0] ? { ...c, params: { ...c.params, [field]: value } } : c),
  } } } };
}

function overrideSource(request: SimulationRequestV1, name: string, value: number): SimulationRequestV1 {
  const input = request.input;
  if (input.format !== 'spice-ts') invalid('Source sweeps require native spice-ts JSON input');
  const components = input.document?.circuit?.components;
  if (!Array.isArray(components)) invalid('Expected native circuit components');
  const matches = components.filter(c => typeof c.name === 'string' && c.name.toLowerCase() === name.toLowerCase());
  const target = matches[0];
  if (matches.length !== 1 || typeof target.type !== 'string' || !['V', 'I'].includes(target.type.toUpperCase()) ||
    !record(target.params) || !finite(target.params.dc) ||
    (target.params.waveform !== undefined && target.params.waveform !== 'dc') ||
    target.params.distortionF1 !== undefined || target.params.distortionF2 !== undefined) invalid('Expected exactly one top-level DC voltage or current source');
  return { ...request, input: { ...input, document: { ...input.document, circuit: { ...input.document.circuit,
    components: components.map(c => c === target ? { ...c, params: { ...c.params, dc: value } } : c),
  } } } };
}

/** Sequential execution reuses the server's worker, quota, conversion and error boundary for every point. */
export async function runSweep(
  args: unknown, request: SimulationRequestV1,
  execute: (request: SimulationRequestV1, measurements: unknown) => Promise<CallToolResult>,
  check: (points: SweepPoint[]) => void,
): Promise<{ parameter: SweepParameter; points: SweepPoint[] }> {
  if (!record(args) || Object.keys(args).some(k => !['request', 'parameter', 'values', 'range', 'measurements'].includes(k))) invalid('Invalid sweep fields');
  const p = args.parameter;
  if (!record(p) || !['param', 'component', 'source', 'temperature'].includes(p.kind as string) || typeof p.name !== 'string'
    || !/^[A-Za-z_][\w.:-]*$/.test(p.name) || Object.keys(p).some(k => !['kind', 'name'].includes(k))) invalid('Invalid sweep parameter');
  const parameter = p as SweepParameter;
  const values = sweepValues(args);
  if (parameter.kind === 'temperature' && (parameter.name !== 'temp' || request.input.format !== 'spice-ts'
    || values.some(value => !finite(value) || value <= -273.15))) invalid('Temperature sweeps require native spice-ts input, name temp and values above absolute zero');
  if (args.measurements !== undefined && (!Array.isArray(args.measurements) || args.measurements.length < 1 || args.measurements.length > 128)) invalid('Expected 1 through 128 measurements');
  const points: SweepPoint[] = [];
  for (const value of values) {
    check(points);
    const changed = parameter.kind === 'temperature' ? { ...request, options: { ...request.options, temperature: value } }
      : parameter.kind === 'param' ? overrideParameters(request, { [parameter.name]: value })
      : parameter.kind === 'source' ? overrideSource(request, parameter.name, value) : overrideComponent(request, parameter.name, value);
    const response = await execute(changed, args.measurements);
    const content = response.structuredContent!;
    if (response.isError) points.push({ value, status: 'failed', error: content.error });
    else points.push({ value, status: 'complete', ...(args.measurements === undefined ? {} : { measurements: content.measurements }) });
    check(points);
  }
  return { parameter, points };
}
