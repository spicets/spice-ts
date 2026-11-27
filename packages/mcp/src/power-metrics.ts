import { parseTitleless } from '@spice-ts/core';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

export interface PowerMetricsArgs {
  netlist: string;
  elements?: string[];
  window?: [number, number];
  windows?: [number, number][];
  input?: string[];
  output?: string[];
  includeCurrentRipple?: boolean;
  includeCurrentExtrema?: boolean;
  includeVoltageRipple?: boolean;
  includeCurrentCrestFactor?: boolean;
  includeVoltageCrestFactor?: boolean;
  includePowerFactor?: boolean;
  includeEnergyFlow?: boolean;
  includeReturnedPowerPeak?: boolean;
  includeCharge?: boolean;
  includeChargeFlow?: boolean;
  includePowerRms?: boolean;
}
interface ElementProbe { name: string; positive: string; negative: string; branch: string }
export interface PowerPlan { netlist: string; probes: ElementProbe[]; args: PowerMetricsArgs }
export interface PowerReport {
  window: [number, number];
  elements: { name: string; averagePowerW: number; energyJ: number; absorbedEnergyJ?: number; returnedEnergyJ?: number; chargeC?: number; positiveChargeC?: number; negativeChargeC?: number; averageCurrentA?: number; minimumCurrentA?: number; minimumCurrentTimeS?: number; maximumCurrentA?: number; maximumCurrentTimeS?: number; rmsCurrentA: number; rmsPowerW?: number; rmsAcCurrentA?: number; rmsAcVoltageV?: number; peakPowerW: number; peakTimeS: number; peakReturnedPowerW?: number; peakReturnedPowerTimeS?: number | null; peakAbsCurrentA?: number; currentCrestFactor?: number | null; voltageCrestFactor?: number | null; rmsVoltageV?: number; apparentPowerVA?: number; powerFactor?: number | null; powerFactorReason?: 'zero_apparent_power' }[];
  efficiency: number | null;
  windowResults?: PowerReport[];
}
export const powerMetricsProperties = {
  netlist: { type: 'string', minLength: 1 },
  elements: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  input: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  output: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  window: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
  windows: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } } },
  includeCurrentRipple: { type: 'boolean' },
  includeCurrentExtrema: { type: 'boolean' },
  includeVoltageRipple: { type: 'boolean' },
  includeCurrentCrestFactor: { type: 'boolean' },
  includeVoltageCrestFactor: { type: 'boolean' },
  includePowerFactor: { type: 'boolean' },
  includeEnergyFlow: { type: 'boolean' },
  includeReturnedPowerPeak: { type: 'boolean' },
  includeCharge: { type: 'boolean' },
  includeChargeFlow: { type: 'boolean' },
  includePowerRms: { type: 'boolean' },
};
const singlePowerReportSchema = {
  type: 'object', required: ['window', 'elements', 'efficiency'], additionalProperties: false,
  properties: {
    window: powerMetricsProperties.window,
    efficiency: { type: ['number', 'null'] },
    elements: { type: 'array', items: {
      type: 'object', required: ['name', 'averagePowerW', 'energyJ', 'rmsCurrentA', 'peakPowerW', 'peakTimeS'], additionalProperties: false,
      properties: { name: { type: 'string' }, ...Object.fromEntries(['averagePowerW', 'energyJ', 'absorbedEnergyJ', 'returnedEnergyJ', 'chargeC', 'positiveChargeC', 'negativeChargeC', 'averageCurrentA', 'minimumCurrentA', 'minimumCurrentTimeS', 'maximumCurrentA', 'maximumCurrentTimeS', 'rmsCurrentA', 'rmsPowerW', 'rmsAcCurrentA', 'rmsAcVoltageV', 'peakPowerW', 'peakTimeS', 'peakReturnedPowerW', 'peakAbsCurrentA', 'rmsVoltageV', 'apparentPowerVA'].map(k => [k, { type: 'number' }])), peakReturnedPowerTimeS: { type: ['number', 'null'] }, currentCrestFactor: { type: ['number', 'null'] }, voltageCrestFactor: { type: ['number', 'null'] }, powerFactor: { type: ['number', 'null'] }, powerFactorReason: { enum: ['zero_apparent_power'] } },
    } },
  },
};
export const powerMetricsOutputSchema = {
  ...singlePowerReportSchema,
  properties: { ...singlePowerReportSchema.properties, windowResults: { type: 'array', minItems: 1, maxItems: 16, items: singlePowerReportSchema } },
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
  if (a.includeVoltageRipple !== undefined && typeof a.includeVoltageRipple !== 'boolean') invalid('Expected includeVoltageRipple to be a boolean');
  if (a.includeCurrentRipple !== undefined && typeof a.includeCurrentRipple !== 'boolean') invalid('Expected includeCurrentRipple to be a boolean');
  if (a.includeCurrentExtrema !== undefined && typeof a.includeCurrentExtrema !== 'boolean') invalid('Expected includeCurrentExtrema to be a boolean');
  if (a.includeCurrentCrestFactor !== undefined && typeof a.includeCurrentCrestFactor !== 'boolean') invalid('Expected includeCurrentCrestFactor to be a boolean');
  if (a.includeVoltageCrestFactor !== undefined && typeof a.includeVoltageCrestFactor !== 'boolean') invalid('Expected includeVoltageCrestFactor to be a boolean');
  if (a.includePowerFactor !== undefined && typeof a.includePowerFactor !== 'boolean') invalid('Expected includePowerFactor to be a boolean');
  if (a.includeEnergyFlow !== undefined && typeof a.includeEnergyFlow !== 'boolean') invalid('Expected includeEnergyFlow to be a boolean');
  if (a.includeReturnedPowerPeak !== undefined && typeof a.includeReturnedPowerPeak !== 'boolean') invalid('Expected includeReturnedPowerPeak to be a boolean');
  if (a.includePowerRms !== undefined && typeof a.includePowerRms !== 'boolean') invalid('Expected includePowerRms to be a boolean');
  if (a.includeCharge !== undefined && typeof a.includeCharge !== 'boolean') invalid('Expected includeCharge to be a boolean');
  if (a.includeChargeFlow !== undefined && typeof a.includeChargeFlow !== 'boolean') invalid('Expected includeChargeFlow to be a boolean');
  if (a.window !== undefined && (!Array.isArray(a.window) || a.window.length !== 2
    || a.window.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0)
    || a.window[0] >= a.window[1])) invalid('Expected window [tStart,tStop] with 0 <= tStart < tStop');
  if (a.windows !== undefined && (!Array.isArray(a.windows) || a.windows.length < 1 || a.windows.length > 16
    || a.windows.some(w => !Array.isArray(w) || w.length !== 2
      || w.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0) || w[0] >= w[1]))) invalid('Expected 1 to 16 windows [tStart,tStop] with 0 <= tStart < tStop');
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
      const line = new RegExp(`^([ \\t]*${escaped}[ \\t(,]+)[^\\s(),]+`, 'im');
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
    // Remove each terminal's constant offset before interpolation, preserving
    // small differential changes that would round away at clipped boundaries.
    const centered = (values: number[]) => {
      let min = Infinity; let max = -Infinity;
      for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
      const first = Math.max(0, times.findIndex((time, index) => index > 0 && time > start) - 1);
      const candidate = values[first];
      const reference = values.every(value => Number.isFinite(value - candidate)) ? candidate : min / 2 + max / 2;
      return values.map(value => value - reference);
    };
    const rippleVp = plan.args.includeVoltageRipple ? centered(vp) : vp;
    const rippleVn = plan.args.includeVoltageRipple ? centered(vn) : vn;
    let energy = 0; let absorbedEnergyJ = 0; let returnedEnergyJ = 0; let rmsScale = 0; let rmsNormalized = 0; let voltageScale = 0; let voltageNormalized = 0; let peakPowerW = -Infinity; let peakTimeS = start;
    let powerScale = 0; let powerNormalized = 0;
    let minimumCurrentA = Infinity; let minimumCurrentTimeS = start; let maximumCurrentA = -Infinity; let maximumCurrentTimeS = start;
    let peakReturnedPowerW = 0; let peakReturnedPowerTimeS: number | null = null; let chargeC = 0; let positiveChargeC = 0; let negativeChargeC = 0;
    const rippleSegments: [number, number, number][] = [];
    const voltageRippleSegments: [number, number, number][] = [];
    for (let k = 1; k < times.length; k++) {
      const left = Math.max(start, times[k - 1]); const right = Math.min(stop, times[k]);
      if (right <= left) continue;
      // Clip the linear input waveforms before integrating their quadratic products.
      const at = (values: number[], t: number) => values[k - 1] + (values[k] - values[k - 1]) * ((t - times[k - 1]) / (times[k] - times[k - 1]));
      const vl = at(vp, left) - at(vn, left); const vr = at(vp, right) - at(vn, right);
      const il = at(current, left); const ir = at(current, right);
      if (plan.args.includeCurrentExtrema) {
        // A linear segment reaches its extrema at its endpoints. Strict comparison preserves the earliest tie.
        for (const [value, time] of [[il, left], [ir, right]]) {
          if (value < minimumCurrentA) { minimumCurrentA = value; minimumCurrentTimeS = time; }
          if (value > maximumCurrentA) { maximumCurrentA = value; maximumCurrentTimeS = time; }
        }
      }
      const dv = vr - vl; const di = ir - il; const duration = right - left;
      if (plan.args.includeCurrentRipple) rippleSegments.push([il, ir, duration]);
      if (plan.args.includeVoltageRipple) voltageRippleSegments.push([at(rippleVp, left) - at(rippleVn, left), at(rippleVp, right) - at(rippleVn, right), duration]);
      if (plan.args.includeCharge) chargeC += duration * (il / 2 + ir / 2);
      if (plan.args.includeChargeFlow) {
        if ((il < 0 && ir > 0) || (il > 0 && ir < 0)) {
          const scale = Math.max(Math.abs(il), Math.abs(ir));
          const leftWeight = Math.abs(il) / scale; const rightWeight = Math.abs(ir) / scale;
          const leftArea = duration * (leftWeight / (leftWeight + rightWeight)) * (Math.abs(il) / 2);
          const rightArea = duration * (rightWeight / (leftWeight + rightWeight)) * (Math.abs(ir) / 2);
          if (il > 0) { positiveChargeC += leftArea; negativeChargeC += rightArea; }
          else { negativeChargeC += leftArea; positiveChargeC += rightArea; }
        } else if (il >= 0 && ir >= 0) positiveChargeC += duration * (il / 2 + ir / 2);
        else negativeChargeC += duration * (-il / 2 - ir / 2);
      }
      const a = dv * di; const b = vl * di + il * dv; const c = vl * il;
      energy += duration * (c + b / 2 + a / 3);
      if (plan.args.includeEnergyFlow) {
        const cuts = [0, 1];
        for (const [l, r] of [[vl, vr], [il, ir]]) {
          if ((l < 0 && r > 0) || (l > 0 && r < 0)) {
            const scale = Math.max(Math.abs(l), Math.abs(r));
            cuts.push((Math.abs(l) / scale) / (Math.abs(l) / scale + Math.abs(r) / scale));
          }
        }
        cuts.sort((x, y) => x - y);
        // Simpson's rule is exact for the quadratic product on each sign-constant interval.
        for (let j = 1; j < cuts.length; j++) {
          const x = cuts[j - 1]; const y = cuts[j]; const mid = (x + y) / 2;
          const product = (t: number) => (vl + dv * t) * (il + di * t);
          const part = duration * (y - x) * (product(x) / 6 + product(mid) * (2 / 3) + product(y) / 6);
          if (part > 0) absorbedEnergyJ += part;
          else returnedEnergyJ -= part;
        }
      }
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
      if (plan.args.includePowerFactor || plan.args.includeVoltageCrestFactor) {
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
      if (plan.args.includePowerRms) {
        const sv = Math.max(Math.abs(vl), Math.abs(vr));
        const si = Math.max(Math.abs(il), Math.abs(ir));
        if (sv > 0 && si > 0) {
          const segmentScale = sv * si;
          if (!Number.isFinite(segmentScale)) invalid('Non-finite power metrics');
          if (segmentScale > 0) {
            // Orthogonal polynomial coefficients of v(x)i(x), x in [-1, 1].
            const vm = (vl / sv + vr / sv) / 2; const vd = (vr / sv - vl / sv) / 2;
            const im = (il / si + ir / si) / 2; const id = (ir / si - il / si) / 2;
            const a = vm * im; const b = vm * id + vd * im; const c = vd * id;
            const segmentRms = Math.hypot(a + c / 3, b / Math.sqrt(3), 2 * c / Math.sqrt(45));
            const nextScale = Math.max(powerScale, segmentScale);
            const weight = Math.sqrt(duration) / Math.sqrt(stop - start);
            powerNormalized = Math.hypot(powerNormalized * (powerScale / nextScale), (segmentScale / nextScale) * segmentRms * weight);
            powerScale = nextScale;
          }
        }
      }
      const considerReturned = (power: number, time: number) => {
        if (plan.args.includeReturnedPowerPeak && -power > peakReturnedPowerW) { peakReturnedPowerW = -power; peakReturnedPowerTimeS = time; }
      };
      const consider = (power: number, time: number) => {
        if (power > peakPowerW) { peakPowerW = power; peakTimeS = time; }
        considerReturned(power, time);
      };
      consider(c, left);
      const vertex = (-b / a) / 2;
      if (a < 0 && vertex > 0 && vertex < 1) consider((vl + dv * vertex) * (il + di * vertex), left + duration * vertex);
      if (plan.args.includeReturnedPowerPeak && a > 0 && vertex > 0 && vertex < 1) considerReturned((vl + dv * vertex) * (il + di * vertex), left + duration * vertex);
      consider(vr * ir, right);
    }
    // An RMS cannot exceed the largest endpoint magnitude; clamp roundoff in the norm.
    const normalized = Math.min(1, rmsNormalized);
    const rmsVoltageV = voltageScale * Math.min(1, voltageNormalized);
    const apparentPowerVA = rmsVoltageV * (rmsScale * normalized);
    const rippleRms = (segments: [number, number, number][]): number => {
      // Center before scaling and squaring: a large DC offset must not erase ripple.
      let min = Infinity; let max = -Infinity;
      for (const [left, right] of segments) {
        min = Math.min(min, left, right); max = Math.max(max, left, right);
      }
      // Halving before addition avoids overflow for opposite extremes.
      const reference = min / 2 + max / 2;
      let scale = 0;
      for (const [left, right] of segments) scale = Math.max(scale, Math.abs(left - reference), Math.abs(right - reference));
      if (!Number.isFinite(scale)) invalid('Non-finite power metrics');
      if (scale > 0) {
        let mean = 0;
        for (const [left, right, duration] of segments) {
          mean += ((left - reference) / scale / 2 + (right - reference) / scale / 2) * (duration / (stop - start));
        }
        let norm = 0;
        for (const [left, right, duration] of segments) {
          const l = (left - reference) / scale - mean; const r = (right - reference) / scale - mean;
          norm = Math.hypot(norm, Math.sqrt((l * l + l * r + r * r) / 3) * (Math.sqrt(duration) / Math.sqrt(stop - start)));
        }
        return scale * norm;
      }
      return 0;
    };
    return { name: probe.name, averagePowerW: energy / (stop - start), energyJ: energy, rmsCurrentA: rmsScale * normalized, peakPowerW, peakTimeS,
      ...(plan.args.includeCurrentExtrema ? { minimumCurrentA, minimumCurrentTimeS, maximumCurrentA, maximumCurrentTimeS } : {}),
      ...(plan.args.includePowerRms ? { rmsPowerW: powerScale * powerNormalized } : {}),
      ...(plan.args.includeCurrentRipple ? { rmsAcCurrentA: rippleRms(rippleSegments) } : {}),
      ...(plan.args.includeVoltageRipple ? { rmsAcVoltageV: rippleRms(voltageRippleSegments) } : {}),
      ...(plan.args.includeEnergyFlow ? { absorbedEnergyJ, returnedEnergyJ } : {}),
      ...(plan.args.includeCharge ? { chargeC, averageCurrentA: chargeC / (stop - start) } : {}),
      ...(plan.args.includeChargeFlow ? { positiveChargeC, negativeChargeC } : {}),
      ...(plan.args.includeReturnedPowerPeak ? { peakReturnedPowerW, peakReturnedPowerTimeS } : {}),
      ...(plan.args.includeCurrentCrestFactor ? { peakAbsCurrentA: rmsScale, currentCrestFactor: rmsScale === 0 ? null : 1 / normalized } : {}),
      ...(plan.args.includeVoltageCrestFactor ? { voltageCrestFactor: voltageScale === 0 ? null : 1 / Math.min(1, voltageNormalized) } : {}),
      ...(plan.args.includePowerFactor ? { rmsVoltageV, apparentPowerVA, powerFactor: apparentPowerVA === 0 ? null : (energy / (stop - start)) / apparentPowerVA,
        ...(apparentPowerVA === 0 ? { powerFactorReason: 'zero_apparent_power' as const } : {}) } : {}) };
  });
  const sum = (names: string[]) => elements.filter(e => names.some(n => n.toLowerCase() === e.name.toLowerCase())).reduce((s, e) => s + e.averagePowerW, 0);
  const pin = plan.args.input ? -sum(plan.args.input) : 0;
  const efficiency = plan.args.output && pin > 0 ? sum(plan.args.output) / pin : null;
  const report: PowerReport = { window: [start, stop], elements, efficiency };
  if (elements.some(e => Object.values(e).some(v => typeof v === 'number' && !Number.isFinite(v))) || (efficiency !== null && !Number.isFinite(efficiency))) invalid('Non-finite power metrics');
  if (plan.args.windows) {
    const { windows, ...args } = plan.args;
    report.windowResults = windows.map(window => powerMetrics(result, { ...plan, args: { ...args, window } }));
  }
  return report;
}
