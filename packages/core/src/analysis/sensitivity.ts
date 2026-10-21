import type { CompiledCircuit } from '../circuit.js';
import { Capacitor } from '../devices/capacitor.js';
import { CCCS } from '../devices/cccs.js';
import { CCVS } from '../devices/ccvs.js';
import { CurrentSource } from '../devices/current-source.js';
import type { DeviceModel } from '../devices/device.js';
import { Inductor } from '../devices/inductor.js';
import { Resistor } from '../devices/resistor.js';
import { VCCS } from '../devices/vccs.js';
import { VCVS } from '../devices/vcvs.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { InvalidCircuitError } from '../errors.js';
import {
  SensitivityResult,
  type ComplexSensitivityValue,
  type SensitivityEntry,
} from '../results.js';
import type {
  ConvergenceTelemetry,
  ResolvedOptions,
  SensitivityAnalysis,
} from '../types.js';
import { buildACRHS, createLinearizedFrequencySystem } from './ac.js';
import { solveDCOperatingPoint } from './dc.js';
import { frequencyGrid } from './frequency-grid.js';

interface ParameterTarget {
  device: string;
  parameter: SensitivityEntry['parameter'];
  value: number;
  set(value: number): void;
}

/**
 * Solve the bounded `.sens` slice (primary device values plus the instance
 * multiplier and scale of R, C, L and current sources) by symmetric perturbation.
 * With zero AC excitation, nonlinear devices may participate in the source
 * transfer calculation; their model/instance parameter vectors are not exposed.
 */
export function solveSensitivity(
  compiled: CompiledCircuit,
  analysis: SensitivityAnalysis,
  options: ResolvedOptions,
  convergence?: ConvergenceTelemetry,
): SensitivityResult {
  const outputIndex = analysis.outputType === 'current'
    ? findCurrentOutputIndex(compiled, analysis.outputNode)
    : findOutputIndex(compiled, analysis.outputNode);
  const referenceIndex = analysis.outputReferenceNode === undefined
    ? -1 : findOutputIndex(compiled, analysis.outputReferenceNode);
  const targets = collectTargets(compiled, analysis.mode);

  if (analysis.mode === 'ac') assertSingleACExcitation(compiled);

  if (analysis.mode === 'dc') {
    const entries = targets.map(target => ({
      device: target.device,
      parameter: target.parameter,
      value: target.value,
      dc: differentiateScalar(target, value => {
        target.set(value);
        const solution = solveDCOperatingPoint(compiled, options, undefined, convergence)
          .assembler.solution;
        return voltageDifference(solution, outputIndex, referenceIndex);
      }),
    }));
    return new SensitivityResult(analysis.outputNode, 'dc', [], entries, analysis.outputReferenceNode, analysis.outputType);
  }

  // ngspice `.sens ac` steps its own grid (cktsens.c), not the stretched `.ac` grid.
  const frequencies = frequencyGrid(analysis, options.reltol, 'sens');
  const entries = targets.map(target => ({
    device: target.device,
    parameter: target.parameter,
    value: target.value,
    ac: differentiateComplex(target, value => {
      target.set(value);
      return solveACAtOutput(compiled, frequencies, options, outputIndex, referenceIndex, convergence);
    }),
  }));
  return new SensitivityResult(analysis.outputNode, 'ac', frequencies, entries, analysis.outputReferenceNode, analysis.outputType);
}

function assertSingleACExcitation(compiled: CompiledCircuit): void {
  const acSources = compiled.devices
    .filter((device): device is VoltageSource | CurrentSource =>
      (device instanceof VoltageSource || device instanceof CurrentSource)
      && (device.waveform.type === 'ac' || device.waveform.ac !== undefined));
  const excitations = acSources
    .filter(device => (device.waveform.type === 'ac'
      ? device.waveform.magnitude : device.waveform.ac!.magnitude) !== 0)
    .map(device => device.name)
    .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
  if (excitations.length > 1) {
    throw new InvalidCircuitError(
      `.sens AC supports at most one non-zero AC excitation; found ${excitations.join(', ')}`,
    );
  }
  if (acSources.length > 1) {
    const names = acSources
      .map(device => device.name)
      .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
    const sourceKind = acSources.every(device => device instanceof VoltageSource)
      ? 'voltage source'
      : 'independent source';
    throw new InvalidCircuitError(
      `.sens AC supports only one AC-form ${sourceKind}; found ${names.join(', ')}`,
    );
  }
}

function collectTargets(compiled: CompiledCircuit, mode: 'dc' | 'ac'): ParameterTarget[] {
  const targets: ParameterTarget[] = [];
  const zeroACResponse = mode === 'ac' && compiled.devices.every(device => {
    if (!(device instanceof VoltageSource || device instanceof CurrentSource)) return true;
    const excitation = device.waveform.type === 'ac' ? device.waveform : device.waveform.ac;
    return (excitation?.magnitude ?? 0) === 0;
  });
  for (const device of compiled.devices) {
    const target = parameterTarget(device, mode, zeroACResponse);
    if (target && (target.value !== 0 || target.parameter === 'acMagnitude')) targets.push(target);
    targets.push(...scalingTargets(device));
  }
  // Stable sort: within a device the primary value precedes `m` and `scale`.
  return targets.sort((left, right) =>
    left.device.localeCompare(right.device, 'en', { sensitivity: 'base' }),
  );
}

/**
 * Instance multiplier (`<dev>_m`) and `scale` (`<dev>_scale`) of R, C, L and
 * current sources, which ngspice-47 cktsens.c lists for every such instance,
 * also when the derivative is zero (C and L in DC). Each is perturbed directly,
 * as ngspice does: R = R_nom * scale / m, C = C_unit * m, L = L_unit / m,
 * I = m * I_value. Voltage sources have no instance m in ngspice-47.
 */
function scalingTargets(device: DeviceModel): ParameterTarget[] {
  if (device instanceof Resistor) {
    return [
      mutable(device, 'multiplier', device.multiplier, value => device.setMultiplier(value)),
      mutable(device, 'scale', device.scale, value => device.setScale(value)),
    ];
  }
  if (device instanceof Capacitor) {
    const capacitance = device.capacitance;
    const { multiplier, scale } = device;
    return [
      mutable(device, 'multiplier', multiplier, value => device.setParameter(
        rescaled(capacitance, value, multiplier),
      )),
      mutable(device, 'scale', scale, value => device.setParameter(rescaled(capacitance, value, scale))),
    ];
  }
  if (device instanceof Inductor) {
    const inductance = device.inductance;
    const { multiplier, scale } = device;
    return [
      mutable(device, 'multiplier', multiplier, value => device.setParameter(
        rescaled(inductance, multiplier, value),
      )),
      mutable(device, 'scale', scale, value => device.setParameter(rescaled(inductance, value, scale))),
    ];
  }
  if (device instanceof CurrentSource) {
    return [mutable(device, 'multiplier', device.multiplier, value => {
      device.multiplier = value;
    })];
  }
  return [];
}

/** `base * numerator / denominator`, exactly `base` when the ratio is one. */
function rescaled(base: number, numerator: number, denominator: number): number {
  return numerator === denominator ? base : base * numerator / denominator;
}

function parameterTarget(device: DeviceModel, mode: 'dc' | 'ac', zeroACResponse: boolean): ParameterTarget | null {
  if (device instanceof Resistor) {
    if (mode === 'ac' && device.hasAcResistance) {
      throw unsupported(device, 'AC sensitivity of a resistor with an ac= resistance is not supported');
    }
    return mutable(device, 'resistance', device.getParameter(), value => device.setParameter(value));
  }
  if (device instanceof Capacitor) {
    if (mode === 'dc') return null;
    return mutable(device, 'capacitance', device.capacitance, value => device.setParameter(value));
  }
  if (device instanceof Inductor) {
    if (mode === 'dc') return null;
    return mutable(device, 'inductance', device.inductance, value => device.setParameter(value));
  }
  if (device instanceof VoltageSource || device instanceof CurrentSource) {
    const waveform = device.waveform;
    if (mode === 'ac') {
      const excitation = waveform.type === 'ac' ? waveform : waveform.ac;
      if (!excitation) {
        // Absent AC means zero, not an unavailable source parameter. Perturb only
        // small-signal magnitude; preserve the original DC/transient waveform.
        return mutable(device, 'acMagnitude', 0, value => {
          if (value === 0) delete waveform.ac;
          else waveform.ac = { magnitude: value, phase: 0 };
        });
      }
      return mutable(
        device, 'acMagnitude', excitation.magnitude,
        value => { excitation.magnitude = value; },
      );
    }
    if (waveform.type === 'ac' || (waveform.type !== 'dc' && waveform.dc !== undefined)) {
      // Perturb the operating-point value, never the transient waveform's initial value.
      return mutable(
        device, 'dc', waveform.dc ?? 0,
        value => { waveform.dc = value; },
      );
    }
    if (waveform.type !== 'dc') {
      const reason = device instanceof VoltageSource
        ? 'DC sensitivity requires a DC-capable voltage source'
        : 'DC current-source sensitivity requires a DC waveform';
      throw unsupported(device, reason);
    }
    return mutable(
      device, 'dc', waveform.value,
      value => { waveform.value = value; },
    );
  }
  if (
    device instanceof VCCS || device instanceof VCVS
    || device instanceof CCCS || device instanceof CCVS
  ) {
    const controlled = device as typeof device & { gain?: number; gm?: number };
    const key = device instanceof VCCS ? 'gm' : 'gain';
    const value = controlled[key];
    if (value === undefined) throw unsupported(device, 'controlled-source gain is unavailable');
    return mutable(device, 'gain', value, next => {
      controlled[key] = next;
    });
  }
  // With a zero RHS, device/model parameter derivatives are identically zero:
  // d(A^-1 b)/dp = -A^-1 (dA/dp) A^-1 b = 0. The bounded result still
  // exposes only its documented parameter slice, but nonlinear devices may
  // participate in the linearized source-magnitude transfer calculation.
  if (zeroACResponse) return null;
  throw unsupported(device, `device type ${device.constructor.name} is outside the bounded slice`);
}

function mutable(
  device: DeviceModel,
  parameter: SensitivityEntry['parameter'],
  value: number,
  set: (value: number) => void,
): ParameterTarget {
  if (!Number.isFinite(value)) throw unsupported(device, `${parameter} must be finite`);
  return { device: device.name, parameter, value, set };
}

function unsupported(device: DeviceModel, detail: string): InvalidCircuitError {
  return new InvalidCircuitError(`.sens does not support '${device.name}': ${detail}`);
}

function differentiateScalar(
  target: ParameterTarget,
  evaluate: (value: number) => number,
): number {
  const step = perturbation(target.value);
  try {
    const high = evaluate(target.value + step);
    const low = evaluate(target.value - step);
    return (high - low) / (2 * step);
  } finally {
    target.set(target.value);
  }
}

function differentiateComplex(
  target: ParameterTarget,
  evaluate: (value: number) => ComplexSensitivityValue[],
): ComplexSensitivityValue[] {
  const step = perturbation(target.value);
  try {
    const high = evaluate(target.value + step);
    const low = evaluate(target.value - step);
    return high.map((value, index) => ({
      real: (value.real - low[index].real) / (2 * step),
      imaginary: (value.imaginary - low[index].imaginary) / (2 * step),
    }));
  } finally {
    target.set(target.value);
  }
}

function perturbation(value: number): number {
  return Math.max(Math.abs(value) * 1e-5, 1e-12);
}

function solveACAtOutput(
  compiled: CompiledCircuit,
  frequencies: readonly number[],
  options: ResolvedOptions,
  outputIndex: number,
  referenceIndex: number,
  convergence?: ConvergenceTelemetry,
): ComplexSensitivityValue[] {
  const dc = solveDCOperatingPoint(compiled, options, undefined, convergence).assembler.solution;
  const system = createLinearizedFrequencySystem(compiled, options, dc);
  const rhs = buildACRHS(compiled);
  return frequencies.map(frequency => {
    const { real, imaginary } = system.solve(2 * Math.PI * frequency, rhs);
    return {
      real: voltageDifference(real, outputIndex, referenceIndex),
      imaginary: voltageDifference(imaginary, outputIndex, referenceIndex),
    };
  });
}

function voltageDifference(solution: Float64Array, positive: number, negative: number): number {
  return (positive < 0 ? 0 : solution[positive]) - (negative < 0 ? 0 : solution[negative]);
}

function findOutputIndex(compiled: CompiledCircuit, name: string): number {
  if (name === '0' || name.toLowerCase() === 'gnd') return -1;
  for (const [nodeName, index] of compiled.nodeIndexMap) {
    if (nodeName.toLowerCase() === name.toLowerCase() && index >= 0) return index;
  }
  throw new InvalidCircuitError(`.sens output node '${name}' does not exist`);
}

function findCurrentOutputIndex(compiled: CompiledCircuit, name: string): number {
  const source = compiled.devices.find(device => device.name.toLowerCase() === name.toLowerCase());
  if (!(source instanceof VoltageSource)) {
    throw new InvalidCircuitError(`.sens current output '${name}' must name an independent voltage source`);
  }
  return compiled.nodeCount + source.branchIndex;
}
