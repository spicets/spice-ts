import type { CompiledCircuit } from './circuit.js';
import type { AnalysisDirective } from './types.js';
import type { SimulationResult } from './results.js';
import type { DeviceModel } from './devices/device.js';
import { Resistor } from './devices/resistor.js';
import { Diode } from './devices/diode.js';
import { CurrentSource } from './devices/current-source.js';
import { VoltageSource } from './devices/voltage-source.js';
import { BehavioralCurrentSource, BehavioralVoltageSource } from './devices/behavioral-source.js';
import { InvalidCircuitError } from './errors.js';

/** Expand `.option savecurrents` at analysis start, retaining explicit saves.
 * Fail rather than return a partial set when a device has no current readout.
 */
export function savedCurrentVectors(
  compiled: Pick<CompiledCircuit, 'devices' | 'simulationOptions'>,
  explicit: readonly string[] = [],
): string[] {
  const names = new Set(explicit.map(name => name.toLowerCase()));
  if (!compiled.simulationOptions.savecurrents) return [...names];
  for (const device of compiled.devices) {
    const parameter = device instanceof CurrentSource ? 'current'
      : device instanceof Diode ? 'id'
        : device instanceof Resistor || device instanceof VoltageSource
          || device instanceof BehavioralCurrentSource || device instanceof BehavioralVoltageSource ? 'i'
          : undefined;
    if (parameter === undefined) {
      throw new InvalidCircuitError(`Unsupported .option savecurrents current readout for device '${device.name}' (${device.constructor.name})`);
    }
    names.add(`@${device.name.toLowerCase()}[${parameter}]`);
  }
  return [...names];
}

/**
 * The circuit's present state after the last control-script analysis: the
 * compiled devices that analysis loaded and its last solution (ngspice
 * CKTrhsOld). Only analyses whose last solution is a real operating state
 * (`op`, `dc`, `tran`) leave one.
 */
export interface ControlOperatingState {
  readonly devices: readonly DeviceModel[];
  /** Last solution: node voltages then branch currents, in MNA order. */
  readonly solution: Float64Array;
  readonly nodeCount: number;
  readonly deviceGmin?: number;
}

/** The operating state left by one analysis, or undefined when it leaves none spice-ts can read. */
export function controlOperatingState(
  compiled: CompiledCircuit, directive: AnalysisDirective | { type: 'pz' }, result: SimulationResult,
): ControlOperatingState | undefined {
  const { nodeNames, branchNames, nodeCount } = compiled;
  const solution = new Float64Array(nodeCount + branchNames.length);
  const fill = (voltage: (name: string) => number | undefined, current: (name: string) => number | undefined): boolean => {
    for (let i = 0; i < nodeNames.length; i++) {
      const value = voltage(nodeNames[i]);
      if (value === undefined) return false;
      solution[i] = value;
    }
    for (let i = 0; i < branchNames.length; i++) {
      const value = current(branchNames[i]);
      if (value === undefined) return false;
      solution[nodeCount + i] = value;
    }
    return true;
  };
  let filled = false;
  if (directive.type === 'op' && result.dc) {
    const { voltages, currents } = result.dc;
    filled = fill(name => voltages.get(name), name => currents.get(name));
  } else if (directive.type === 'dc' && result.dcSweep) {
    const { voltages, currents } = result.dcSweep;
    filled = fill(name => voltages.get(name)?.at(-1), name => currents.get(name)?.at(-1));
  } else if (directive.type === 'tran' && result.transient) {
    const { voltages, currents } = result.transient;
    filled = fill(name => voltages.get(name)?.at(-1), name => currents.get(name)?.at(-1));
  }
  return filled ? { devices: compiled.devices, solution, nodeCount } : undefined;
}

/**
 * ngspice `@device[parameter]` readout of a device output quantity in the
 * circuit's present state, as a one-element vector, or undefined when spice-ts
 * does not read that quantity out. Follows ngspice-47:
 *
 * - R `i`: (V+ - V-) * RESconduct (res/resask.c RES_CURRENT);
 * - I `current`: ISRCcurrent, M * value at the last load (isrc/isrcload.c);
 * - B `i`: ASRCprev_value * M for I=, the branch current for V= (asrc/asrcask.c);
 * - V `i`: the branch current (vsrc/vsrcask.c VSRC_CURRENT).
 */
export function deviceOutputVector(
  state: ControlOperatingState | undefined, name: string, parameter: string,
): number[] | undefined {
  if (!state) return undefined;
  const wanted = name.toLowerCase();
  const device = state.devices.find(candidate => candidate.name.toLowerCase() === wanted);
  if (!device) return undefined;
  const key = parameter.toLowerCase();
  const { solution, nodeCount } = state;
  const voltage = (node: number): number => (node >= 0 ? solution[node] : 0);
  const branch = (index: number): number => solution[nodeCount + index];
  if (device instanceof Diode && (key === 'id' || key === 'i')) {
    return [device.noiseOperatingPoint(solution, state.deviceGmin).current];
  }
  if (device instanceof Resistor && key === 'i') {
    const [positive, negative] = device.nodes;
    return [device.branchIndex !== undefined
      ? branch(device.branchIndex)
      : (voltage(positive) - voltage(negative)) * device.conductance];
  }
  if (device instanceof CurrentSource && key === 'current') {
    return device.lastCurrent === undefined ? undefined : [device.lastCurrent];
  }
  if (device instanceof BehavioralCurrentSource && key === 'i') return [device.lastValue];
  if ((device instanceof BehavioralVoltageSource || device instanceof VoltageSource) && key === 'i') {
    return [branch(device.branches[0])];
  }
  return undefined;
}
