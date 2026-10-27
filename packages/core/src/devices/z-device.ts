import type { ModelParams } from '../types.js';
import type { DeviceModel } from './device.js';
import { HFET1 } from './hfet1.js';
import { resolveHFET1Instance, resolveHFET1Model, type HFET1Model } from './hfet1-model.js';
import { MES } from './mes.js';
import { mesSeriesResistances, resolveMESInstance, resolveMESModel, type MESModel } from './mes-model.js';
import { MESA } from './mesa.js';
import {
  MESA_JUNCTION_GMIN, mesaSeriesResistances, resolveMESAInstance, resolveMESAModel, type MESAModel,
} from './mesa-model.js';

/**
 * Z-card model families, selected by LEVEL as ngspice-47 `INPdomodel` does
 * for `nmf`/`nhfet` cards: LEVEL 0/1 (the default) is MES, 2-4 MESA,
 * 5 HFET1 (HFETA), 6 HFET2.
 */
export type ResolvedZModel =
  | { kind: 'hfet'; model: HFET1Model }
  | { kind: 'mesa'; model: MESAModel }
  | { kind: 'mes'; model: MESModel };

export function resolveZModel(model: ModelParams): ResolvedZModel {
  if (model.type !== 'NHFET' && model.type !== 'NMF') {
    throw new Error(`Unsupported Z-card model type: '${model.type}'`);
  }
  // ngspice INPfindLev: an absent LEVEL is 1; the value is rounded to an integer.
  const level = Math.floor((model.params.LEVEL ?? 1) + 0.5);
  if (level <= 1) return { kind: 'mes', model: resolveMESModel(model) };
  if (level <= 4) return { kind: 'mesa', model: resolveMESAModel(model) };
  if (level === 5) return { kind: 'hfet', model: resolveHFET1Model(model) };
  throw new Error(`Unsupported ${model.type} model level: ${level}`);
}

export interface ZDeviceExpansion {
  /** Series resistors to add, between the given external/internal node names. */
  resistors: { name: string; nodes: [string, string]; value: number }[];
  /** Node names of the intrinsic device, in the order its constructor expects. */
  nodes: string[];
}

/**
 * Expand a Z-card's parasitic resistances to explicit resistors and internal
 * nodes, as ngspice's setup routines create drain'/source'/gate' (and MESA's
 * RI/RF nodes source''/drain'') only when the resistance is nonzero.
 */
export function expandZDevice(
  name: string,
  [drain, gate, source]: readonly [string, string, string],
  resolved: ResolvedZModel,
  instanceParams: Record<string, number> | undefined,
  internalNode: (suffix: string) => string,
): ZDeviceExpansion {
  const resistors: ZDeviceExpansion['resistors'] = [];
  const series = (from: string, suffix: string, value: number): string => {
    if (!(value > 0)) return from;
    const to = internalNode(suffix);
    resistors.push({ name: `${name}.${suffix.toUpperCase()}`, nodes: [from, to], value });
    return to;
  };
  if (resolved.kind === 'hfet') {
    resolveHFET1Instance(instanceParams);
    const drainPrime = series(drain, 'rd', resolved.model.RD);
    const sourcePrime = series(source, 'rs', resolved.model.RS);
    return { resistors, nodes: [drainPrime, gate, sourcePrime] };
  }
  if (resolved.kind === 'mes') {
    const values = mesSeriesResistances(resolved.model, resolveMESInstance(instanceParams));
    const drainPrime = series(drain, 'rd', values.RD);
    const sourcePrime = series(source, 'rs', values.RS);
    return { resistors, nodes: [drainPrime, gate, sourcePrime] };
  }
  const values = mesaSeriesResistances(resolved.model, resolveMESAInstance(instanceParams));
  const drainPrime = series(drain, 'rd', values.RD);
  const sourcePrime = series(source, 'rs', values.RS);
  const gatePrime = series(gate, 'rg', values.RG);
  const sourceCharge = series(sourcePrime, 'ri', values.RI);
  const drainCharge = series(drainPrime, 'rf', values.RF);
  return { resistors, nodes: [drainPrime, gatePrime, sourcePrime, sourceCharge, drainCharge] };
}

/** Build the intrinsic Z-card device on the nodes {@link expandZDevice} returned. */
export function createZDevice(
  name: string,
  nodes: number[],
  resolved: ResolvedZModel,
  instanceParams: Record<string, number> | undefined,
  gmin: number = MESA_JUNCTION_GMIN,
  circuitTemperature = 27,
): DeviceModel {
  switch (resolved.kind) {
    case 'hfet':
      return new HFET1(name, nodes, resolved.model, resolveHFET1Instance(instanceParams), circuitTemperature);
    case 'mes':
      return new MES(name, nodes, resolved.model, resolveMESInstance(instanceParams), gmin);
    case 'mesa':
      return new MESA(name, nodes, resolved.model, resolveMESAInstance(instanceParams), gmin);
  }
}
