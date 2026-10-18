import type { SensitivityResult } from '@spice-ts/core';

export interface SensitivityArgs { netlist: string; output: string; analysis: 'dc'; top?: number }
const entryProperties = {
  device: { type: 'string' }, parameter: { type: 'string' }, value: { type: 'number' },
  absolute: { type: 'number' }, normalised: { type: 'number' },
  parameterUnit: { type: 'string' }, absoluteUnit: { type: 'string' },
};
export const sensitivityInputSchema = {
  type: 'object', additionalProperties: false, required: ['netlist', 'output'],
  properties: {
    netlist: { type: 'string', minLength: 1 }, output: { type: 'string', minLength: 1 },
    analysis: { const: 'dc' }, top: { type: 'integer', minimum: 1, maximum: 10000 },
  },
};
export const sensitivityOutputSchema = {
  type: 'object', additionalProperties: false, required: ['output', 'analysis', 'outputUnit', 'entries'],
  properties: {
    output: { type: 'string' }, analysis: { const: 'dc' }, outputUnit: { enum: ['V', 'A'] },
    entries: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: Object.keys(entryProperties), properties: entryProperties,
    } },
  },
};

function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} };
}
export function sensitivityArgs(args: unknown): SensitivityArgs {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Expected sensitivity arguments');
  const a = args as Record<string, unknown>;
  if (Object.keys(a).some(k => !['netlist', 'output', 'analysis', 'top'].includes(k))
    || typeof a.netlist !== 'string' || !a.netlist.trim()
    || typeof a.output !== 'string'
    || !/^(?:v\([^\s(),]+(?:\s*,\s*[^\s(),]+)?\)|i\(v[^\s(),]*\))$/i.test(a.output)
    || (a.analysis !== undefined && a.analysis !== 'dc')
    || (a.top !== undefined && (!Number.isInteger(a.top) || (a.top as number) < 1 || (a.top as number) > 10000))) {
    invalid('Expected netlist, output v(node), v(a,b) or i(vsrc), optional analysis dc and top (1–10000)');
  }
  return { netlist: a.netlist as string, output: a.output as string, analysis: 'dc', top: a.top as number | undefined };
}

export function sensitivityReport(result: SensitivityResult, args: SensitivityArgs) {
  const outputUnit = result.outputType === 'current' ? 'A' : 'V';
  const entries = result.entries.map(entry => {
    const parameterUnit = entry.parameter === 'resistance' ? 'ohm'
      : entry.parameter === 'capacitance' ? 'F'
      : entry.parameter === 'inductance' ? 'H'
      : entry.parameter === 'dc' || entry.parameter === 'acMagnitude' ? (/^v/i.test(entry.device) ? 'V' : 'A')
      : entry.parameter === 'gain' ? (/^g/i.test(entry.device) ? 'S' : /^h/i.test(entry.device) ? 'ohm' : '1') : '1';
    const absolute = entry.dc!;
    const normalised = entry.value * absolute;
    if (![entry.value, absolute, normalised].every(Number.isFinite)) invalid('Non-finite sensitivity result');
    return { device: entry.device, parameter: entry.parameter, value: entry.value,
      absolute, normalised, parameterUnit, absoluteUnit: `${outputUnit}/${parameterUnit}` };
  }).sort((a, b) => Math.abs(b.normalised) - Math.abs(a.normalised)
    || (a.device < b.device ? -1 : a.device > b.device ? 1 : a.parameter < b.parameter ? -1 : a.parameter > b.parameter ? 1 : 0));
  return { output: args.output, analysis: args.analysis, outputUnit, entries: entries.slice(0, args.top) };
}
