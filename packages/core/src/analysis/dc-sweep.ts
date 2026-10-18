import type {
  ConvergenceTelemetry, DCSweepAnalysis, DCSweepDimension, ResolvedOptions,
} from '../types.js';
import type { CompiledCircuit } from '../circuit.js';
import { createMatrixVariableIdentities, MNAAssembler } from '../mna/assembler.js';
import { newtonRaphson } from './newton-raphson.js';
import { gminSteppingHomotopy } from './dc.js';
import { DCSweepResult } from '../results.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { CurrentSource } from '../devices/current-source.js';
import { ClassicBsimMosfet } from '../devices/bsim12-load.js';
import { Resistor } from '../devices/resistor.js';
import { NOMINAL_TEMPERATURE_C } from '../devices/junction-temperature.js';
import { ConvergenceError, InvalidCircuitError, UnsupportedTemperatureError } from '../errors.js';
import {
  createConvergenceTelemetry, snapshotConvergenceTelemetry,
} from '../convergence-telemetry.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';
import { accumulatedLinearGrid } from './directed-linear-grid.js';
import { temperatureExpressionTarget } from './temperature-expressions.js';
import { deviceOutputVector } from '../control-device-output.js';

interface SweepTarget {
  set(value: number): void;
  restore(): void;
}

export function solveDCSweep(
  compiled: CompiledCircuit,
  analysis: DCSweepAnalysis,
  options: ResolvedOptions,
  convergence: ConvergenceTelemetry = createConvergenceTelemetry(),
  guard?: ProtocolExecutionGuard,
  savedDeviceVectors: readonly string[] = [],
): DCSweepResult {
  const { devices, nodeCount, branchCount, nodeNames, branchNames } = compiled;

  assertDCSweepDimension(analysis);
  if (analysis.secondary !== undefined) assertDCSweepDimension(analysis.secondary);
  if (analysis.secondary?.source.toUpperCase() === analysis.source.toUpperCase()) {
    throw new InvalidCircuitError(`DC sweep source '${analysis.secondary!.source}' is repeated`);
  }

  // ngspice-47 dctrcurv.c accumulates each level by `+= step` and resets inner levels to start,
  // so every outer value reuses the same accumulated inner grid.
  const primaryGrid = sweepGrid(analysis);
  const secondaryGrid = analysis.secondary === undefined ? [undefined] : sweepGrid(analysis.secondary);
  const sourceNames = [analysis.source, ...(analysis.secondary ? [analysis.secondary.source] : [])];
  const source = resolveSweepTarget(compiled, analysis, primaryGrid, sourceNames);
  const secondarySource = analysis.secondary === undefined
    ? undefined
    : resolveSweepTarget(compiled, analysis.secondary, secondaryGrid as number[], sourceNames);
  const primaryPoints = primaryGrid.length;
  const secondaryPoints = secondaryGrid.length;
  const numPoints = primaryPoints * secondaryPoints;

  // Pre-allocate result arrays
  const sweepValues = new Float64Array(numPoints);
  const voltageArrays = new Map<string, Float64Array>();
  const currentArrays = new Map<string, Float64Array>();
  for (const name of nodeNames) voltageArrays.set(name, new Float64Array(numPoints));
  for (const name of branchNames) currentArrays.set(name, new Float64Array(numPoints));
  const deviceVectors = new Map<string, Float64Array>();

  const assembler = new MNAAssembler(nodeCount, branchCount, {
    deviceGmin: options.deviceGmin,
    variables: createMatrixVariableIdentities(nodeNames, branchNames),
  });
  // ngspice dctrcurv.c solves the first point in MODEINITJCT.
  for (const device of devices) device.beginOperatingPoint?.();
  const secondarySweepValues = analysis.secondary === undefined
    ? undefined
    : new Float64Array(numPoints);
  const bsim1 = devices.filter((device): device is ClassicBsimMosfet =>
    device instanceof ClassicBsimMosfet && device.setup.kind === 'BSIM1');

  try {
    for (let outer = 0; outer < secondaryPoints; outer++) {
      const secondarySweepValue = secondaryGrid[outer];
      if (secondarySource !== undefined && secondarySweepValue !== undefined) {
        secondarySource.set(secondarySweepValue);
      }
      for (let inner = 0; inner < primaryPoints; inner++) {
        guard?.recordResultPoint();
        const i = outer * primaryPoints + inner;
        const sweepValue = primaryGrid[inner]!;
        sweepValues[i] = sweepValue;
        if (secondarySweepValues !== undefined) {
          secondarySweepValues[i] = secondarySweepValue!;
        }

        source.set(sweepValue);

        solveSweepPoint(assembler, compiled.devices, options, nodeNames, convergence, guard);
        if (i === 0) {
          for (const device of bsim1) device.bindDCSweepStamp({
            ctx: assembler.getStampContext(), values: assembler.gValues,
            rhs: assembler.b, index: assembler.stampIndex,
          });
        }

        // Sample while device state (temperature, last load, swept sources) still
        // belongs to this point, not by replaying the final compiled devices.
        for (const name of savedDeviceVectors) {
          const match = /^@([^[]+)\[([^\]]+)\]$/.exec(name);
          const values = match && deviceOutputVector({ devices: compiled.devices,
            solution: assembler.solution, nodeCount, deviceGmin: options.deviceGmin }, match[1], match[2]);
          if (!values) continue;
          if (!deviceVectors.has(name)) deviceVectors.set(name, new Float64Array(numPoints));
          deviceVectors.get(name)![i] = values[0];
        }

        // Record solution
        for (let n = 0; n < nodeNames.length; n++) {
          voltageArrays.get(nodeNames[n])![i] = assembler.solution[n];
        }
        for (let b = 0; b < branchNames.length; b++) {
          currentArrays.get(branchNames[b])![i] = assembler.solution[nodeCount + b];
        }
      }
    }
  } catch (error) {
    if (error instanceof ConvergenceError) {
      convergence.dc.failure = error.kind;
      error.convergence = snapshotConvergenceTelemetry(convergence);
    }
    throw error;
  } finally {
    for (const device of bsim1) device.bindDCSweepStamp();
    source.restore();
    secondarySource?.restore();
  }

  return new DCSweepResult(sweepValues, voltageArrays, currentArrays, secondarySweepValues, deviceVectors);
}

/**
 * One DC transfer-curve point, as ngspice-47 dctrcurv.c: Newton from the
 * previous point's solution, and on failure the full CKTop operating-point
 * homotopy (here dynamic, then true gmin stepping). A sweep that drives the
 * circuit through a fold (e.g. latch-up) needs it: the previous branch no
 * longer exists, and plain Newton from it need not converge.
 */
function solveSweepPoint(
  assembler: MNAAssembler,
  devices: CompiledCircuit['devices'],
  options: ResolvedOptions,
  nodeNames: string[],
  convergence: ConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
): void {
  try {
    newtonRaphson(
      assembler, devices, options, options.maxIterations, nodeNames, convergence.dc, guard,
    );
  } catch (error) {
    if (!(error instanceof ConvergenceError) || !devices.some(device => device.isNonlinear)) throw error;
    const savedSolution = new Float64Array(assembler.solution);
    if (!gminSteppingHomotopy(assembler, devices, options, nodeNames, convergence, guard)) {
      assembler.solution.set(savedSolution);
      throw error;
    }
  }
}

function resolveSweepTarget(
  compiled: CompiledCircuit,
  sweep: DCSweepDimension,
  grid: readonly number[],
  sourceNames: string[],
): SweepTarget {
  const { devices } = compiled;
  // SPICE identifiers are case-insensitive, but retain declaration spelling in
  // result maps and diagnostics.
  const normalizedSourceName = sweep.source.toUpperCase();
  if (normalizedSourceName === 'TEMP') {
    const fixed = devices.find(device => device.isNonlinear && !device.setTemperature);
    const offNominal = grid.find(value => value !== NOMINAL_TEMPERATURE_C);
    if (fixed && offNominal !== undefined) throw new UnsupportedTemperatureError(fixed.name, offNominal);
    const expressions = temperatureExpressionTarget(compiled, sourceNames);
    if (expressions) return expressions;
    const thermalDevices = devices.filter(device => device.setTemperature && device.getTemperature);
    // Resistor getTemperature includes instance TEMP/DTEMP. Restore CKTtemp,
    // not the effective instance temperature, to avoid applying DTEMP twice.
    const original = thermalDevices.map(device => device instanceof Resistor
      ? device.getCircuitTemperature() : device.getTemperature!());
    return {
      set: value => thermalDevices.forEach(device => device.setTemperature!(value)),
      restore: () => thermalDevices.forEach((device, index) => device.setTemperature!(original[index])),
    };
  }
  const matchingSources = devices.filter(
    (device): device is VoltageSource | CurrentSource | Resistor =>
      (device instanceof VoltageSource || device instanceof CurrentSource || device instanceof Resistor)
      && device.name.toUpperCase() === normalizedSourceName,
  );
  if (matchingSources.length === 0) {
    throw new InvalidCircuitError(`DC sweep source '${sweep.source}' not found`);
  }
  if (matchingSources.length > 1) {
    const names = matchingSources.map(device => `'${device.name}'`).join(', ');
    throw new InvalidCircuitError(
      `DC sweep source '${sweep.source}' is ambiguous; matches: ${names}`,
    );
  }
  const source = matchingSources[0]!;
  if (source instanceof Resistor) {
    // Sweep the nominal instance value, retaining temperature, SCALE and M.
    const resistance = source.getParameter();
    return {
      set: value => source.setParameter(value),
      restore: () => source.setParameter(resistance),
    };
  }
  const waveform = source.waveform;
  const sourceIndex = devices.indexOf(source);
  const currentSource = () => compiled.devices[sourceIndex] as VoltageSource | CurrentSource;
  return {
    set: value => { currentSource().waveform = { type: 'dc', value }; },
    restore: () => { currentSource().waveform = waveform; },
  };
}

function sweepGrid(sweep: DCSweepDimension): number[] {
  return accumulatedLinearGrid(sweep.start, sweep.stop, sweep.step);
}

function assertDCSweepDimension(sweep: DCSweepDimension): void {
  const { start, stop, step } = sweep;
  if (sweep.source.length === 0 || ![start, stop, step].every(Number.isFinite) || step === 0
      || (stop > start && step < 0) || (stop < start && step > 0)) {
    throw new InvalidCircuitError('DC sweep grid must be finite with a nonzero step toward stop');
  }
}
