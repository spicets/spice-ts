import type { TransferFunctionResult } from '@spice-ts/core';
import { paramsSchema } from './params.js';

export interface TfArgs { netlist: string; output: string; input_source: string; params?: unknown }
export const tfInputSchema = {
  type: 'object', additionalProperties: false, required: ['netlist', 'output', 'input_source'],
  properties: {
    netlist: { type: 'string', minLength: 1 }, output: { type: 'string', minLength: 1, description: 'Output selector: v(node), differential v(positive,negative), or i(vsrc); differential terminals must be literal node names, not brace expressions.' },
    input_source: { type: 'string', minLength: 1 }, params: paramsSchema,
  },
};
const quantities = {
  transfer_function: { type: 'number' }, input_resistance: { type: 'number' }, output_resistance: { type: 'number' },
};
export const tfOutputSchema = {
  type: 'object', additionalProperties: false,
  required: ['output', 'input_source', ...Object.keys(quantities), 'units'],
  properties: {
    output: { type: 'string' }, input_source: { type: 'string' }, ...quantities,
    units: { type: 'object', additionalProperties: false, required: Object.keys(quantities), properties: {
      transfer_function: { enum: ['V/V', 'V/A', 'A/V', 'A/A'] },
      input_resistance: { const: 'ohm' }, output_resistance: { const: 'ohm' },
    } },
  },
};
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} };
}
export function tfArgs(args: unknown): TfArgs {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Expected transfer-function arguments');
  const a = args as Record<string, unknown>;
  if (Object.keys(a).some(k => !['netlist', 'output', 'input_source', 'params'].includes(k))
    || typeof a.netlist !== 'string' || !a.netlist.trim()
    || typeof a.output !== 'string'
    || !/^(?:v\([^\s(),]+(?:,[^\s(),]+)?\)|i\(v[^\s(),]*\))$/i.test(a.output)
    || (/^v\(/i.test(a.output) && a.output.includes(',') && /[{}]/.test(a.output))
    || typeof a.input_source !== 'string' || !/^[vi][^\s(),]*$/i.test(a.input_source)) {
    invalid('Expected netlist, output v(node), v(node,node) or i(vsrc), and independent input_source');
  }
  return a as unknown as TfArgs;
}
export function tfReport(result: TransferFunctionResult, args: TfArgs) {
  if (![result.transfer, result.inputResistance, result.outputResistance].every(Number.isFinite)) {
    invalid('Non-finite transfer-function result');
  }
  return {
    output: args.output, input_source: args.input_source,
    transfer_function: result.transfer, input_resistance: result.inputResistance, output_resistance: result.outputResistance,
    units: { transfer_function: `${result.outputSource ? 'A' : 'V'}/${/^i/i.test(result.inputSource) ? 'A' : 'V'}`,
      input_resistance: 'ohm', output_resistance: 'ohm' },
  };
}
