import type { TransferFunctionResult } from '@spice-ts/core';
import { paramsSchema } from './params.js';

export interface TfArgs { netlist: string; output: string; input_source: string; params?: unknown; loadResistanceOhm?: number }
export const tfInputSchema = {
  type: 'object', additionalProperties: false, required: ['netlist', 'output', 'input_source'],
  properties: {
    netlist: { type: 'string', minLength: 1 }, output: { type: 'string', minLength: 1, description: 'Output selector: v(node), differential v(positive,negative), or i(vsrc); differential terminals must be literal node names, not brace expressions.' },
    input_source: { type: 'string', minLength: 1 }, params: paramsSchema,
    loadResistanceOhm: { type: 'number', exclusiveMinimum: 0, description: 'Positive finite resistance across a voltage output, in ohms.' },
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
    loaded_transfer_function: { type: 'number' },
    units: { type: 'object', additionalProperties: false, required: Object.keys(quantities), properties: {
      transfer_function: { enum: ['V/V', 'V/A', 'A/V', 'A/A'] },
      loaded_transfer_function: { enum: ['V/V', 'V/A'] },
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
  if (Object.keys(a).some(k => !['netlist', 'output', 'input_source', 'params', 'loadResistanceOhm'].includes(k))
    || typeof a.netlist !== 'string' || !a.netlist.trim()
    || typeof a.output !== 'string'
    || !/^(?:v\([^\s(),]+(?:,[^\s(),]+)?\)|i\(v[^\s(),]*\))$/i.test(a.output)
    || (/^v\(/i.test(a.output) && a.output.includes(',') && /[{}]/.test(a.output))
    || typeof a.input_source !== 'string' || !/^[vi][^\s(),]*$/i.test(a.input_source)) {
    invalid('Expected netlist, output v(node), v(node,node) or i(vsrc), and independent input_source');
  }
  if (a.loadResistanceOhm !== undefined && (typeof a.loadResistanceOhm !== 'number' || !Number.isFinite(a.loadResistanceOhm)
    || a.loadResistanceOhm <= 0 || !/^v\(/i.test(a.output as string))) {
    invalid('loadResistanceOhm requires a positive finite resistance and a voltage output');
  }
  return a as unknown as TfArgs;
}
function loadedGain(transfer: number, resistance: number, load: number): number {
  const scale = Math.max(Math.abs(resistance), load);
  const sum = resistance + load;
  const denominator = Number.isFinite(sum) ? sum / scale : resistance / scale + load / scale;
  if (denominator === 0) invalid('Singular loaded transfer function');
  if (transfer === 0) return 0;
  const scaledLoad = load / scale;
  const ratio = scaledLoad / denominator;
  let gain = transfer * ratio;
  // Use logarithms only when an intermediate overflow or underflow hides a representable result.
  if (!Number.isFinite(gain) || gain === 0 || scaledLoad < 2.2250738585072014e-308
    || Math.abs(ratio) < 2.2250738585072014e-308 || !Number.isFinite(ratio)) {
    const magnitude = Math.exp(Math.log(Math.abs(transfer)) + Math.log(load) - Math.log(scale) - Math.log(Math.abs(denominator)));
    gain = Math.sign(transfer) * Math.sign(denominator) * magnitude;
  }
  if (!Number.isFinite(gain) || gain === 0) invalid('Loaded transfer function is not representable');
  return gain;
}
export function tfReport(result: TransferFunctionResult, args: TfArgs) {
  if (![result.transfer, result.inputResistance, result.outputResistance].every(Number.isFinite)) {
    invalid('Non-finite transfer-function result');
  }
  const unit = `${result.outputSource ? 'A' : 'V'}/${/^i/i.test(result.inputSource) ? 'A' : 'V'}`;
  const loaded = args.loadResistanceOhm === undefined ? undefined : loadedGain(result.transfer, result.outputResistance, args.loadResistanceOhm);
  return {
    output: args.output, input_source: args.input_source,
    transfer_function: result.transfer, input_resistance: result.inputResistance, output_resistance: result.outputResistance,
    ...(loaded === undefined ? {} : { loaded_transfer_function: loaded }),
    units: { transfer_function: unit, input_resistance: 'ohm', output_resistance: 'ohm',
      ...(loaded === undefined ? {} : { loaded_transfer_function: unit }) },
  };
}
