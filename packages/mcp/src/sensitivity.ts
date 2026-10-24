import type { SensitivityResult } from '@spice-ts/core';

interface SensitivitySweep { type: 'dec' | 'oct' | 'lin'; points: number; fstart: number; fstop: number }
export interface SensitivityArgs { netlist: string; output: string; analysis: 'dc' | 'ac'; top?: number; sweep?: SensitivitySweep }
const entryProperties = {
  device: { type: 'string' }, parameter: { type: 'string' }, value: { type: 'number' },
  absolute: { type: 'number' }, normalised: { type: 'number' },
  parameterUnit: { type: 'string' }, absoluteUnit: { type: 'string' },
};
const sweepSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'points', 'fstart', 'fstop'],
  properties: {
    type: { enum: ['dec', 'oct', 'lin'] }, points: { type: 'integer', minimum: 1, maximum: 10000 },
    fstart: { type: 'number', exclusiveMinimum: 0 }, fstop: { type: 'number', exclusiveMinimum: 0 },
  },
};
export const sensitivityInputSchema = {
  type: 'object', additionalProperties: false, required: ['netlist', 'output'],
  properties: {
    netlist: { type: 'string', minLength: 1 }, output: { type: 'string', minLength: 1 },
    analysis: { enum: ['dc', 'ac'] }, top: { type: 'integer', minimum: 1, maximum: 10000 }, sweep: sweepSchema,
  },
  oneOf: [
    { required: ['analysis', 'sweep'], properties: { analysis: { const: 'ac' } } },
    { properties: { analysis: { const: 'dc' } }, not: { required: ['sweep'] } },
  ],
};
const dcOutputSchema = {
  type: 'object', additionalProperties: false, required: ['output', 'analysis', 'outputUnit', 'entries'],
  properties: {
    output: { type: 'string' }, analysis: { const: 'dc' }, outputUnit: { enum: ['V', 'A'] },
    entries: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: Object.keys(entryProperties), properties: entryProperties,
    } },
  },
};
const complexSchema = {
  type: 'object', additionalProperties: false, required: ['real', 'imaginary'],
  properties: { real: { type: 'number' }, imaginary: { type: 'number' } },
};
const acOutputSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'output', 'analysis', 'outputUnit', 'points'],
  properties: {
    schemaVersion: { const: '1' }, output: { type: 'string' }, analysis: { const: 'ac' }, outputUnit: { enum: ['V', 'A'] },
    points: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['frequency', 'entries'],
      properties: {
        frequency: { type: 'number' }, entries: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: Object.keys(entryProperties),
          properties: { ...entryProperties, absolute: complexSchema, normalised: complexSchema },
        } },
      },
    } },
  },
};
export const sensitivityOutputSchema = { oneOf: [dcOutputSchema, acOutputSchema] };

function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} };
}
export function sensitivityArgs(args: unknown): SensitivityArgs {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Expected sensitivity arguments');
  const a = args as Record<string, unknown>;
  if (Object.keys(a).some(k => !['netlist', 'output', 'analysis', 'top', 'sweep'].includes(k))
    || typeof a.netlist !== 'string' || !a.netlist.trim()
    || typeof a.output !== 'string'
    || !/^(?:v\([^\s(),]+(?:\s*,\s*[^\s(),]+)?\)|i\(v[^\s(),]*\))$/i.test(a.output)
    || (a.analysis !== undefined && a.analysis !== 'dc' && a.analysis !== 'ac')
    || (a.top !== undefined && (!Number.isInteger(a.top) || (a.top as number) < 1 || (a.top as number) > 10000))) {
    invalid('Expected netlist, output v(node), v(a,b) or i(vsrc), optional analysis dc/ac and top (1–10000)');
  }
  const analysis = a.analysis === 'ac' ? 'ac' : 'dc';
  let sweep: SensitivitySweep | undefined;
  if (analysis === 'ac') {
    if (!a.sweep || typeof a.sweep !== 'object' || Array.isArray(a.sweep)) invalid('AC sensitivity requires a sweep');
    const s = a.sweep as Record<string, unknown>;
    if (Object.keys(s).some(k => !['type', 'points', 'fstart', 'fstop'].includes(k))
      || !['dec', 'oct', 'lin'].includes(s.type as string)
      || !Number.isInteger(s.points) || (s.points as number) < 1 || (s.points as number) > 10000
      || typeof s.fstart !== 'number' || !Number.isFinite(s.fstart) || s.fstart <= 0
      || typeof s.fstop !== 'number' || !Number.isFinite(s.fstop) || s.fstop < s.fstart) {
      invalid('Expected sweep type dec/oct/lin, points (1–10000), finite fstart > 0 and fstop >= fstart');
    }
    sweep = { type: s.type as SensitivitySweep['type'], points: s.points as number, fstart: s.fstart as number, fstop: s.fstop as number };
  } else if ('sweep' in a) invalid('Sweep is only valid for AC sensitivity');
  return { netlist: a.netlist as string, output: a.output as string, analysis, top: a.top as number | undefined, sweep };
}

function lexical(a: { device: string; parameter: string }, b: { device: string; parameter: string }) {
  return a.device < b.device ? -1 : a.device > b.device ? 1 : a.parameter < b.parameter ? -1 : a.parameter > b.parameter ? 1 : 0;
}
export function sensitivityReport(result: SensitivityResult, args: SensitivityArgs) {
  const outputUnit = result.outputType === 'current' ? 'A' : 'V';
  const metadata = (entry: SensitivityResult['entries'][number]) => {
    const parameterUnit = entry.parameter === 'resistance' ? 'ohm'
      : entry.parameter === 'capacitance' ? 'F'
      : entry.parameter === 'inductance' ? 'H'
      : entry.parameter === 'dc' || entry.parameter === 'acMagnitude' ? (/^v/i.test(entry.device) ? 'V' : 'A')
      : entry.parameter === 'gain' ? (/^g/i.test(entry.device) ? 'S' : /^h/i.test(entry.device) ? 'ohm' : '1') : '1';
    return { device: entry.device, parameter: entry.parameter, value: entry.value,
      parameterUnit, absoluteUnit: `${outputUnit}/${parameterUnit}` };
  };
  if (args.analysis === 'ac') {
    const points = (result.frequencies ?? []).map((frequency, i) => {
      if (!Number.isFinite(frequency)) invalid('Non-finite sensitivity result');
      const entries = result.entries.map(entry => {
        const absolute = entry.ac?.[i];
        if (!absolute) invalid('Missing AC sensitivity result');
        const normalised = { real: entry.value * absolute.real, imaginary: entry.value * absolute.imaginary };
        if (![entry.value, absolute.real, absolute.imaginary, normalised.real, normalised.imaginary].every(Number.isFinite)) invalid('Non-finite sensitivity result');
        return { ...metadata(entry), absolute, normalised };
      }).sort((a, b) => Math.hypot(b.normalised.real, b.normalised.imaginary) - Math.hypot(a.normalised.real, a.normalised.imaginary) || lexical(a, b));
      return { frequency, entries: entries.slice(0, args.top) };
    });
    return { schemaVersion: '1', output: args.output, analysis: 'ac', outputUnit, points };
  }
  const entries = result.entries.map(entry => {
    const absolute = entry.dc!;
    const normalised = entry.value * absolute;
    if (![entry.value, absolute, normalised].every(Number.isFinite)) invalid('Non-finite sensitivity result');
    return { ...metadata(entry), absolute, normalised };
  }).sort((a, b) => Math.abs(b.normalised) - Math.abs(a.normalised) || lexical(a, b));
  return { output: args.output, analysis: args.analysis, outputUnit, entries: entries.slice(0, args.top) };
}
