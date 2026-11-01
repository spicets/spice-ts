import { parseTitleless } from '@spice-ts/core';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

export interface PowerMetricsArgs {
  netlist: string;
  elements?: string[];
  window?: [number, number];
  input?: string[];
  output?: string[];
}
interface ElementProbe { name: string; positive: string; negative: string; branch: string }
export interface PowerPlan { netlist: string; probes: ElementProbe[]; args: PowerMetricsArgs }
export interface PowerReport {
  window: [number, number];
  elements: { name: string; averagePowerW: number; rmsCurrentA: number; peakPowerW: number; peakTimeS: number }[];
  efficiency: number | null;
}
export const powerMetricsProperties = {
  netlist: { type: 'string', minLength: 1 },
  elements: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  input: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  output: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  window: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
};
export const powerMetricsOutputSchema = {
  type: 'object', required: ['window', 'elements', 'efficiency'], additionalProperties: false,
  properties: {
    window: powerMetricsProperties.window,
    efficiency: { type: ['number', 'null'] },
    elements: { type: 'array', items: {
      type: 'object', required: ['name', 'averagePowerW', 'rmsCurrentA', 'peakPowerW', 'peakTimeS'], additionalProperties: false,
      properties: { name: { type: 'string' }, ...Object.fromEntries(['averagePowerW', 'rmsCurrentA', 'peakPowerW', 'peakTimeS'].map(k => [k, { type: 'number' }])) },
    } },
  },
};
export const powerMetricsErrorSchema = {
  type: 'object', required: ['error'], additionalProperties: false,
  properties: { error: {
    type: 'object', required: ['code', 'message'], additionalProperties: false,
    properties: { code: { enum: ['NOT_TRANSIENT'] }, message: { type: 'string' } },
  } },
};
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} };
}
export function powerMetricsArgs(raw: unknown): PowerMetricsArgs {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || Array.isArray(a)
    || Object.keys(a).some(k => !Object.hasOwn(powerMetricsProperties, k))
    || typeof a.netlist !== 'string' || !a.netlist.trim()) invalid('Expected netlist and optional elements, window, input/output lists');
  for (const key of ['elements', 'input', 'output']) {
    const list = a[key];
    if (list !== undefined && (!Array.isArray(list) || !list.length || list.length > 128
      || list.some(v => typeof v !== 'string' || !v.trim())
      || new Set(list.map(v => v.toLowerCase())).size !== list.length)) invalid(`Invalid ${key} list`);
  }
  if ((a.input === undefined) !== (a.output === undefined)) invalid('Provide both input and output designations');
  if (a.window !== undefined && (!Array.isArray(a.window) || a.window.length !== 2
    || a.window.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0)
    || a.window[0] >= a.window[1])) invalid('Expected window [tStart,tStop] with 0 <= tStart < tStop');
  return a as unknown as PowerMetricsArgs;
}

/** Zero-volt series probes expose accepted-timepoint device currents, not differentiated voltages. */
export function powerPlan(args: PowerMetricsArgs): PowerPlan | { error: { code: 'NOT_TRANSIENT'; message: string } } {
  if (/^\s*\.(?:step|control|subckt|include|inc|lib)\b/im.test(args.netlist)) invalid('Power metrics require a flat, unstepped netlist without includes or control blocks');
  const circuit = parseTitleless(args.netlist);
  if (!circuit.analyses.some(a => a.type === 'tran')) return { error: { code: 'NOT_TRANSIENT', message: 'Power metrics require one transient analysis' } };
  if (circuit.analyses.length !== 1 || circuit.analyses[0].type !== 'tran') invalid('Power metrics require exactly one transient analysis');
  const components = circuit.toIR().components;
  const names = args.elements ?? components.map(c => c.name);
  if (names.length > 128) invalid('Select at most 128 elements');
  const selected = new Set(names.map(n => n.toLowerCase()));
  for (const name of [...(args.input ?? []), ...(args.output ?? [])]) {
    if (!selected.has(name.toLowerCase())) invalid(`Designation must be selected in elements: ${name}`);
  }
  if (args.input?.some(n => args.output!.some(o => o.toLowerCase() === n.toLowerCase()))) invalid('Input and output designations must be disjoint');
  let netlist = args.netlist;
  const probes: ElementProbe[] = [];
  for (const name of names) {
    const c = components.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!c) invalid(`Unknown element: ${name}`);
    const controlled = c.type === 'E' || c.type === 'G';
    if (controlled ? c.ports.length !== 4 : c.ports.length !== 2 || !['R', 'C', 'L', 'V', 'I', 'D', 'H', 'F'].includes(c.type)) invalid(`Element ${name} is not a supported two-terminal device`);
    // E/G IR ports are control-first, unlike the output-first SPICE card.
    const positive = controlled ? c.ports.find(p => p.name === 'outP')?.net : c.ports[0].net;
    const negative = controlled ? c.ports.find(p => p.name === 'outN')?.net : c.ports[1].net;
    if (positive === undefined || negative === undefined) invalid(`Missing output terminals: ${name}`);
    let branch = c.name;
    if (c.type !== 'V' && c.type !== 'L') {
      let suffix = probes.length;
      while (new RegExp(`\\b__power_${suffix}\\b`, 'i').test(netlist) || new RegExp(`\\bV__power_${suffix}\\b`, 'i').test(netlist)) suffix++;
      const node = `__power_${suffix}`;
      branch = `V__power_${suffix}`;
      const escaped = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const line = new RegExp(`^(\\s*${escaped}\\s+)\\S+`, 'im');
      if (!line.test(netlist)) invalid(`Cannot probe element: ${name}`);
      netlist = `${branch} ${positive} ${node} 0\n${netlist.replace(line, `$1${node}`)}`;
    }
    probes.push({ name: c.name, positive, negative, branch });
  }
  return { netlist, probes, args };
}

export function powerMetrics(result: SimulationResultV1, plan: PowerPlan): PowerReport {
  const traces = result.analyses.filter(a => a.type === 'tran');
  if (traces.length !== 1 || traces[0].type !== 'tran') invalid('Expected one complete transient result');
  const trace = traces[0];
  const times = trace.timeS;
  if (times.length < 2 || times.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= times[i - 1]))) invalid('Invalid transient timepoints');
  const [start, stop] = plan.args.window ?? [times[0], times[times.length - 1]];
  if (start < times[0] || stop > times[times.length - 1]) invalid('Window must lie within accepted transient timepoints');
  const vector = (record: Record<string, number[]>, name: string): number[] => {
    if (/^(0|gnd)$/i.test(name)) return times.map(() => 0);
    const values = Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (!values || values.length !== times.length || values.some(v => !Number.isFinite(v))) invalid(`Missing or invalid waveform: ${name}`);
    return values;
  };
  const elements = plan.probes.map(probe => {
    const current = vector(trace.currentsA, probe.branch);
    const vp = vector(trace.voltagesV, probe.positive);
    const vn = vector(trace.voltagesV, probe.negative);
    const power = current.map((i, k) => (vp[k] - vn[k]) * i);
    const square = current.map(i => i * i);
    let energy = 0; let squareIntegral = 0; let peakPowerW = -Infinity; let peakTimeS = start;
    for (let k = 1; k < times.length; k++) {
      const left = Math.max(start, times[k - 1]); const right = Math.min(stop, times[k]);
      if (right <= left) continue;
      // Integrate piecewise-linear power and i^2, clipping segments at window edges.
      const at = (values: number[], t: number) => values[k - 1] + (values[k] - values[k - 1]) * ((t - times[k - 1]) / (times[k] - times[k - 1]));
      const pl = at(power, left); const pr = at(power, right);
      energy += (pl + pr) * (right - left) / 2;
      squareIntegral += (at(square, left) + at(square, right)) * (right - left) / 2;
      if (pl > peakPowerW) { peakPowerW = pl; peakTimeS = left; }
      if (pr > peakPowerW) { peakPowerW = pr; peakTimeS = right; }
    }
    return { name: probe.name, averagePowerW: energy / (stop - start), rmsCurrentA: Math.sqrt(squareIntegral / (stop - start)), peakPowerW, peakTimeS };
  });
  const sum = (names: string[]) => elements.filter(e => names.some(n => n.toLowerCase() === e.name.toLowerCase())).reduce((s, e) => s + e.averagePowerW, 0);
  const pin = plan.args.input ? -sum(plan.args.input) : 0;
  const efficiency = plan.args.output && pin > 0 ? sum(plan.args.output) / pin : null;
  const report: PowerReport = { window: [start, stop], elements, efficiency };
  if (elements.some(e => Object.values(e).some(v => typeof v === 'number' && !Number.isFinite(v))) || (efficiency !== null && !Number.isFinite(efficiency))) invalid('Non-finite power metrics');
  return report;
}
