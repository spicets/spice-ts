import { mapProtocolErrorV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { measurementListSchema } from './measure.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { overrideParameters, ParameterOverrideError, paramsSchema } from './params.js';
import { overrideComponent } from './sweep.js';

export const MAX_CORNERS = 64;
type Corner = { name: string; params?: Record<string, number>; temp?: number; components?: Record<string, number>; sources?: Record<string, number> };
type CornerResult = { name: string; status: 'complete'; value: number; unit: string }
  | { name: string; status: 'failed'; error: unknown };
type CornerSummary = { min: { name: string; value: number }; max: { name: string; value: number }; spread: number; unit: string };
type NamedMeasurementResult = { id: string } & ({ value: number; unit: string } | { error: unknown });
type MultiCornerResult = { name: string; status: 'complete'; measurements: NamedMeasurementResult[] } | { name: string; status: 'failed'; error: unknown };
export type CornersResult = { corners: CornerResult[]; summary: CornerSummary | null };
export type MultiCornersResult = { corners: MultiCornerResult[]; summaries: { id: string; summary: CornerSummary | null }[] };

const namedMeasurementsSchema = { type: 'array', minItems: 1, maxItems: 16, items: {
  type: 'object', required: ['id', 'measurement'], additionalProperties: false, properties: {
    id: { type: 'string', minLength: 1, maxLength: 128, pattern: '.*\\S.*' }, measurement: measurementListSchema.items,
  },
} };
const validateNamedMeasurements = new AjvJsonSchemaValidator().getValidator(namedMeasurementsSchema);

export const cornersProperties = {
  corners: { type: 'array', minItems: 1, maxItems: MAX_CORNERS, items: {
    type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 }, params: paramsSchema,
      components: { type: 'object', description: 'Case-insensitive top-level R/C/L component value overrides. Names must match ^[A-Za-z_][\\w.:-]*$; values must be finite and positive. Invalid names fail their corner.', additionalProperties: { type: 'number', exclusiveMinimum: 0 } },
      sources: { type: 'object', description: 'Case-insensitive top-level native spice-ts DC voltage or current source overrides. Values must be finite; invalid targets fail their corner.', additionalProperties: { type: 'number' } },
      temp: { type: 'number', exclusiveMinimum: -273.15, description: 'Circuit temperature in degrees Celsius. Overrides SPICE temperature cards or native request options.temperature.' },
    },
  } },
  measurement: measurementListSchema.items,
  measurements: namedMeasurementsSchema,
};

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} } satisfies SpiceApiErrorV1;
}

/** Named deterministic runs share the server's quota and one outer deadline. */
export async function runCorners(
  args: unknown, request: SimulationRequestV1, originalFormat: SimulationRequestV1['input']['format'],
  execute: (request: SimulationRequestV1, measurements: unknown[]) => Promise<CallToolResult>,
  check: (result: CornersResult | MultiCornersResult) => void,
): Promise<CornersResult | MultiCornersResult> {
  if (!record(args) || Object.keys(args).some(k => !['request', 'corners', 'measurement', 'measurements'].includes(k))) invalid('Invalid corners fields');
  const multi = Object.hasOwn(args, 'measurements');
  if (multi === Object.hasOwn(args, 'measurement')) invalid('Expected exactly one of measurement or measurements');
  if (!multi && !record(args.measurement)) invalid('Expected one measurement');
  if (multi && !validateNamedMeasurements(args.measurements).valid) invalid('Invalid named measurements');
  const named = multi ? args.measurements as { id: string; measurement: unknown }[] : [];
  if (new Set(named.map(m => m.id)).size !== named.length) invalid('Duplicate measurement id');
  if (!Array.isArray(args.corners) || !args.corners.length) invalid('corners must be a nonempty list');
  if (args.corners.length > MAX_CORNERS) throw {
    code: 'RESOURCE_LIMIT', message: 'Corner count cap exceeded', phase: 'validation', retryable: false,
    details: { limit: 'maxCorners', maximum: MAX_CORNERS, actual: args.corners.length },
  } satisfies SpiceApiErrorV1;
  const names = new Set<string>();
  for (const c of args.corners) {
    if (!record(c) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 128 || names.has(c.name)
      || Object.keys(c).some(k => !['name', 'params', 'temp', 'components', 'sources'].includes(k))
      || (c.temp !== undefined && (typeof c.temp !== 'number' || !Number.isFinite(c.temp) || c.temp <= -273.15))) invalid('Invalid or duplicate corner name or temperature');
    names.add(c.name);
  }
  if (request.input.format === 'spice' && typeof request.input.source !== 'string') invalid('Corners require SPICE text input');
  const result: CornersResult = { corners: [], summary: null };
  const multiResult: MultiCornersResult = { corners: [], summaries: named.map(({ id }) => ({ id, summary: null })) };
  const currentResult = () => multi ? multiResult : result;
  for (const corner of args.corners as Corner[]) {
    check(currentResult());
    let entry: CornerResult;
    let checkingLimits = false;
    try {
      let changed = overrideParameters(request, corner.params);
      if (corner.sources !== undefined) {
        if (originalFormat !== 'spice-ts' || changed.input.format !== 'spice-ts') invalid('Source overrides require native spice-ts JSON input');
        if (!record(corner.sources)) invalid('sources must be a record of finite numbers');
        const entries = Object.entries(corner.sources);
        const keys = entries.map(([name]) => name.toLowerCase());
        if (new Set(keys).size !== keys.length || entries.some(([name, value]) =>
          !/^[A-Za-z_][\w.:-]*$/.test(name) || typeof value !== 'number' || !Number.isFinite(value))) invalid('Invalid or duplicate source override');
        for (const [index, [name, value]] of entries.entries()) {
          if (index % 8 === 0) {
            await new Promise<void>(resolve => setImmediate(resolve));
            checkingLimits = true;
            check(currentResult());
            checkingLimits = false;
          }
          const input = changed.input;
          if (input.format !== 'spice-ts') invalid('Source overrides require native spice-ts JSON input');
          const components = input.document?.circuit?.components;
          if (!Array.isArray(components)) invalid('Expected native circuit components');
          const matches = components.filter(c => typeof c.name === 'string' && c.name.toLowerCase() === name.toLowerCase());
          const target = matches[0];
          if (matches.length !== 1 || typeof target.type !== 'string' || !['V', 'I'].includes(target.type.toUpperCase()) ||
            !record(target.params) || typeof target.params.dc !== 'number' || !Number.isFinite(target.params.dc) ||
            (target.params.waveform !== undefined && target.params.waveform !== 'dc') ||
            target.params.distortionF1 !== undefined || target.params.distortionF2 !== undefined) invalid('Expected exactly one top-level DC voltage or current source');
          changed = { ...changed, input: { ...input, document: { ...input.document, circuit: { ...input.document.circuit,
            components: components.map(c => c === target ? { ...c, params: { ...c.params, dc: value as number } } : c),
          } } } };
        }
      }
      if (corner.components !== undefined) {
        if (originalFormat === 'circuit-json') invalid('Component overrides require SPICE text or native spice-ts JSON input');
        if (!record(corner.components)) invalid('components must be a record of positive finite numbers');
        const entries = Object.entries(corner.components);
        const keys = entries.map(([name]) => name.toLowerCase());
        if (new Set(keys).size !== keys.length || entries.some(([name, value]) =>
          !/^[A-Za-z_][\w.:-]*$/.test(name) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
          invalid('Invalid or duplicate component override');
        }
        for (const [index, [name, value]] of entries.entries()) {
          if (index % 8 === 0) {
            // Allow abort timers and other requests to run between bounded batches.
            await new Promise<void>(resolve => setImmediate(resolve));
            checkingLimits = true;
            check(currentResult());
            checkingLimits = false;
          }
          changed = overrideComponent(changed, name, value as number);
        }
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
      const response = await execute(changed, multi ? named.map(m => m.measurement) : [args.measurement]);
      const content = response.structuredContent!;
      const measured = (content.measurements as ({ value: number; unit: string } | { error: unknown })[] | undefined)?.[0];
      if (multi && !response.isError) {
        const values = content.measurements;
        if (!Array.isArray(values) || values.length !== named.length) throw new Error('Missing measurement results');
        const results: NamedMeasurementResult[] = values.map((value, i) => {
          const id = named[i].id;
          if (!record(value) || 'error' in value || typeof value.value !== 'number' || !Number.isFinite(value.value) || typeof value.unit !== 'string') {
            return { id, error: record(value) && 'error' in value ? value.error : mapProtocolErrorV1(new Error('Invalid measurement result')) };
          }
          const summary = multiResult.summaries[i].summary;
          if (summary && summary.unit !== value.unit) return { id, error: mapProtocolErrorV1(new Error('Measurement unit changed between corners')) };
          const point = { name: corner.name, value: value.value };
          if (!summary) multiResult.summaries[i].summary = { min: point, max: point, spread: 0, unit: value.unit };
          else {
            if (value.value < summary.min.value) summary.min = point;
            if (value.value > summary.max.value) summary.max = point;
            summary.spread = summary.max.value - summary.min.value;
          }
          return { id, value: value.value, unit: value.unit };
        });
        multiResult.corners.push({ name: corner.name, status: 'complete', measurements: results });
        checkingLimits = true;
        check(currentResult());
        checkingLimits = false;
        continue;
      }
      if (response.isError) entry = { name: corner.name, status: 'failed', error: content.error };
      else if (!measured || 'error' in measured) entry = { name: corner.name, status: 'failed', error: measured && 'error' in measured ? measured.error : mapProtocolErrorV1(new Error('Missing measurement result')) };
      else entry = { name: corner.name, status: 'complete', ...measured };
    } catch (error) {
      if (checkingLimits) throw error;
      entry = { name: corner.name, status: 'failed', error: error instanceof ParameterOverrideError ? error.apiError : mapProtocolErrorV1(error) };
    }
    if (multi) {
      multiResult.corners.push(entry as MultiCornerResult);
      check(currentResult());
      continue;
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
    check(currentResult());
  }
  return currentResult();
}
