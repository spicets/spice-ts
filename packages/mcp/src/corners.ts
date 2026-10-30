import { mapProtocolErrorV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { measurementListSchema } from './measure.js';
import { overrideParameters, ParameterOverrideError, paramsSchema } from './params.js';
import { overrideComponent } from './sweep.js';

export const MAX_CORNERS = 64;
type Corner = { name: string; params?: Record<string, number>; temp?: number; components?: Record<string, number> };
type CornerResult = { name: string; status: 'complete'; value: number; unit: string }
  | { name: string; status: 'failed'; error: unknown };
type CornerSummary = { min: { name: string; value: number }; max: { name: string; value: number }; spread: number; unit: string };
export type CornersResult = { corners: CornerResult[]; summary: CornerSummary | null };

export const cornersProperties = {
  corners: { type: 'array', minItems: 1, maxItems: MAX_CORNERS, items: {
    type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 }, params: paramsSchema,
      components: { type: 'object', description: 'Case-insensitive top-level R/C/L component value overrides. Values must be finite and positive.', additionalProperties: { type: 'number', exclusiveMinimum: 0 } },
      temp: { type: 'number', exclusiveMinimum: -273.15, description: 'Circuit temperature in degrees Celsius. Overrides SPICE temperature cards or native request options.temperature.' },
    },
  } },
  measurement: measurementListSchema.items,
};

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} } satisfies SpiceApiErrorV1;
}

/** Named deterministic runs share the server's quota and one outer deadline. */
export async function runCorners(
  args: unknown, request: SimulationRequestV1, originalFormat: SimulationRequestV1['input']['format'],
  execute: (request: SimulationRequestV1, measurements: unknown[]) => Promise<CallToolResult>,
  check: (result: CornersResult) => void,
): Promise<CornersResult> {
  if (!record(args) || Object.keys(args).some(k => !['request', 'corners', 'measurement'].includes(k))
    || !record(args.measurement)) invalid('Expected request, corners and one measurement');
  if (!Array.isArray(args.corners) || !args.corners.length) invalid('corners must be a nonempty list');
  if (args.corners.length > MAX_CORNERS) throw {
    code: 'RESOURCE_LIMIT', message: 'Corner count cap exceeded', phase: 'validation', retryable: false,
    details: { limit: 'maxCorners', maximum: MAX_CORNERS, actual: args.corners.length },
  } satisfies SpiceApiErrorV1;
  const names = new Set<string>();
  for (const c of args.corners) {
    if (!record(c) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 128 || names.has(c.name)
      || Object.keys(c).some(k => !['name', 'params', 'temp', 'components'].includes(k))
      || (c.temp !== undefined && (typeof c.temp !== 'number' || !Number.isFinite(c.temp) || c.temp <= -273.15))) invalid('Invalid or duplicate corner name or temperature');
    names.add(c.name);
  }
  if (request.input.format === 'spice' && typeof request.input.source !== 'string') invalid('Corners require SPICE text input');
  const result: CornersResult = { corners: [], summary: null };
  for (const corner of args.corners as Corner[]) {
    check(result);
    let entry: CornerResult;
    try {
      let changed = overrideParameters(request, corner.params);
      if (corner.components !== undefined) {
        if (originalFormat === 'circuit-json') invalid('Component overrides require SPICE text or native spice-ts JSON input');
        if (!record(corner.components)) invalid('components must be a record of positive finite numbers');
        const entries = Object.entries(corner.components);
        const keys = entries.map(([name]) => name.toLowerCase());
        if (new Set(keys).size !== keys.length || entries.some(([name, value]) =>
          !/^[A-Za-z_][\w.:-]*$/.test(name) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
          invalid('Invalid or duplicate component override');
        }
        for (const [name, value] of entries) changed = overrideComponent(changed, name, value as number);
      }
      if (corner.temp !== undefined && originalFormat === 'circuit-json') invalid('Temperature overrides require SPICE text input');
      if (corner.temp !== undefined && changed.input.format === 'spice-ts') {
        changed = { ...changed, options: { ...changed.options, temperature: corner.temp } };
      }
      if (corner.temp !== undefined && changed.input.format === 'spice') {
        const source = changed.input.source;
        const index = /^\s*\.end\s*(?:[;$].*)?$/im.exec(source)?.index ?? source.length;
        changed = { ...changed, input: { ...changed.input, source: source.slice(0, index) + `\n.temp ${corner.temp}\n` + source.slice(index) } };
      }
      const response = await execute(changed, [args.measurement]);
      const content = response.structuredContent!;
      const measured = (content.measurements as ({ value: number; unit: string } | { error: unknown })[] | undefined)?.[0];
      if (response.isError) entry = { name: corner.name, status: 'failed', error: content.error };
      else if (!measured || 'error' in measured) entry = { name: corner.name, status: 'failed', error: measured && 'error' in measured ? measured.error : mapProtocolErrorV1(new Error('Missing measurement result')) };
      else entry = { name: corner.name, status: 'complete', ...measured };
    } catch (error) {
      entry = { name: corner.name, status: 'failed', error: error instanceof ParameterOverrideError ? error.apiError : mapProtocolErrorV1(error) };
    }
    result.corners.push(entry);
    if (entry.status === 'complete') {
      const point = { name: entry.name, value: entry.value };
      if (!result.summary) result.summary = { min: point, max: point, spread: 0, unit: entry.unit };
      else {
        if (entry.value < result.summary.min.value) result.summary.min = point;
        if (entry.value > result.summary.max.value) result.summary.max = point;
        result.summary.spread = result.summary.max.value - result.summary.min.value;
      }
    }
    check(result);
  }
  return result;
}
