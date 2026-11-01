import { parseTitleless } from '@spice-ts/core';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

export interface PowerMetricsArgs {
  netlist: string;
  elements?: string[];
  window?: [number, number];
  input?: string[];
  output?: string[];
  includeCurrentCrestFactor?: boolean;
  includePowerFactor?: boolean;
}
interface ElementProbe { name: string; positive: string; negative: string; branch: string }
export interface PowerPlan { netlist: string; probes: ElementProbe[]; args: PowerMetricsArgs }
export interface PowerReport {
  window: [number, number];
  elements: { name: string; averagePowerW: number; energyJ: number; rmsCurrentA: number; peakPowerW: number; peakTimeS: number; peakAbsCurrentA?: number; currentCrestFactor?: number | null; rmsVoltageV?: number; apparentPowerVA?: number; powerFactor?: number | null; powerFactorReason?: 'zero_apparent_power' }[];
  efficiency: number | null;
}
export const powerMetricsProperties = {
  netlist: { type: 'string', minLength: 1 },
  elements: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  input: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  output: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  window: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
  includeCurrentCrestFactor: { type: 'boolean' },
  includePowerFactor: { type: 'boolean' },
};
export const powerMetricsOutputSchema = {
  type: 'object', required: ['window', 'elements', 'efficiency'], additionalProperties: false,
  properties: {
    window: powerMetricsProperties.window,
    efficiency: { type: ['number', 'null'] },
    elements: { type: 'array', items: {
      type: 'object', required: ['name', 'averagePowerW', 'energyJ', 'rmsCurrentA', 'peakPowerW', 'peakTimeS'], additionalProperties: false,
      properties: { name: { type: 'string' }, ...Object.fromEntries(['averagePowerW', 'energyJ', 'rmsCurrentA', 'peakPowerW', 'peakTimeS', 'peakAbsCurrentA', 'rmsVoltageV', 'apparentPowerVA'].map(k => [k, { type: 'number' }])), currentCrestFactor: { type: ['number', 'null'] }, powerFactor: { type: ['number', 'null'] }, powerFactorReason: { enum: ['zero_apparent_power'] } },
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
  if (a.includeCurrentCrestFactor !== undefined && typeof a.includeCurrentCrestFactor !== 'boolean') invalid('Expected includeCurrentCrestFactor to be a boolean');
  if (a.includePowerFactor !== undefined && typeof a.includePowerFactor !== 'boolean') invalid('Expected includePowerFactor to be a boolean');
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
    if (c.ports.length !== 2 || !['R', 'C', 'L', 'V', 'I', 'D', 'H', 'F'].includes(c.type)) invalid(`Element ${name} is not a supported two-terminal device`);
    const [positive, negative] = c.ports.map(p => p.net);
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
    let energy = 0; let rmsScale = 0; let rmsNormalized = 0; let voltageScale = 0; let voltageNormalized = 0; let peakPowerW = -Infinity; let peakTimeS = start;
    for (let k = 1; k < times.length; k++) {
      const left = Math.max(start, times[k - 1]); const right = Math.min(stop, times[k]);
      if (right <= left) continue;
      // Clip the linear input waveforms before integrating their quadratic products.
      const at = (values: number[], t: number) => values[k - 1] + (values[k] - values[k - 1]) * ((t - times[k - 1]) / (times[k] - times[k - 1]));
      const vl = at(vp, left) - at(vn, left); const vr = at(vp, right) - at(vn, right);
      const il = at(current, left); const ir = at(current, right);
      const dv = vr - vl; const di = ir - il; const duration = right - left;
      const a = dv * di; const b = vl * di + il * dv; const c = vl * il;
      energy += duration * (c + b / 2 + a / 3);
      // Normalize before squaring, and combine segment RMS values without squaring their scale.
      const scale = Math.max(Math.abs(il), Math.abs(ir));
      if (scale > 0) {
        const l = il / scale; const r = ir / scale;
        const nextScale = Math.max(rmsScale, scale);
        const segmentRms = Math.sqrt((l * l + l * r + r * r) / 3);
        const weight = Math.sqrt(duration) / Math.sqrt(stop - start);
        rmsNormalized = Math.hypot(rmsNormalized * (rmsScale / nextScale), (scale / nextScale) * segmentRms * weight);
        rmsScale = nextScale;
      }
      if (plan.args.includePowerFactor) {
        const scaleV = Math.max(Math.abs(vl), Math.abs(vr));
        if (scaleV > 0) {
          const l = vl / scaleV; const r = vr / scaleV;
          const nextScale = Math.max(voltageScale, scaleV);
          const segmentRms = Math.sqrt((l * l + l * r + r * r) / 3);
          const weight = Math.sqrt(duration) / Math.sqrt(stop - start);
          voltageNormalized = Math.hypot(voltageNormalized * (voltageScale / nextScale), (scaleV / nextScale) * segmentRms * weight);
          voltageScale = nextScale;
        }
      }
      const consider = (power: number, time: number) => {
        if (power > peakPowerW) { peakPowerW = power; peakTimeS = time; }
      };
      consider(c, left);
      const vertex = -b / (2 * a);
      if (a < 0 && vertex > 0 && vertex < 1) consider((vl + dv * vertex) * (il + di * vertex), left + duration * vertex);
      consider(vr * ir, right);
    }
    // An RMS cannot exceed the largest endpoint magnitude; clamp roundoff in the norm.
    const normalized = Math.min(1, rmsNormalized);
    const rmsVoltageV = voltageScale * Math.min(1, voltageNormalized);
    const apparentPowerVA = rmsVoltageV * (rmsScale * normalized);
    return { name: probe.name, averagePowerW: energy / (stop - start), energyJ: energy, rmsCurrentA: rmsScale * normalized, peakPowerW, peakTimeS,
      ...(plan.args.includeCurrentCrestFactor ? { peakAbsCurrentA: rmsScale, currentCrestFactor: rmsScale === 0 ? null : 1 / normalized } : {}),
      ...(plan.args.includePowerFactor ? { rmsVoltageV, apparentPowerVA, powerFactor: apparentPowerVA === 0 ? null : (energy / (stop - start)) / apparentPowerVA,
        ...(apparentPowerVA === 0 ? { powerFactorReason: 'zero_apparent_power' as const } : {}) } : {}) };
  });
  const sum = (names: string[]) => elements.filter(e => names.some(n => n.toLowerCase() === e.name.toLowerCase())).reduce((s, e) => s + e.averagePowerW, 0);
  const pin = plan.args.input ? -sum(plan.args.input) : 0;
  const efficiency = plan.args.output && pin > 0 ? sum(plan.args.output) / pin : null;
  const report: PowerReport = { window: [start, stop], elements, efficiency };
  if (elements.some(e => Object.values(e).some(v => typeof v === 'number' && !Number.isFinite(v))) || (efficiency !== null && !Number.isFinite(efficiency))) invalid('Non-finite power metrics');
  return report;
}
