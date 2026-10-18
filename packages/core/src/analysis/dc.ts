import type { ConvergenceTelemetry, ResolvedOptions } from '../types.js';
import type { CompiledCircuit } from '../circuit.js';
import { createMatrixVariableIdentities, MNAAssembler } from '../mna/assembler.js';
import { newtonRaphson } from './newton-raphson.js';
import { DCResult } from '../results.js';
import { createConvergenceTelemetry, snapshotConvergenceTelemetry } from '../convergence-telemetry.js';
import { ConvergenceError, SingularMatrixError } from '../errors.js';
import { createNodeStateSolution, initialConditionHolds, nodeSetHolds } from './initial-state.js';

import { Capacitor } from '../devices/capacitor.js';
import { Resistor } from '../devices/resistor.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { CurrentSource } from '../devices/current-source.js';
import { MOS2 } from '../devices/mos2.js';
import { createDriverFromCompiled } from './transient-driver.js';
import {
  ProtocolExecutionError,
  type ProtocolExecutionGuard,
} from '../protocol/execution-guard.js';

type DCSourceMode = 'operating-point' | 'transient';

export function solveDCOperatingPoint(
  compiled: CompiledCircuit,
  options: ResolvedOptions,
  initialSolution?: Float64Array,
  convergence: ConvergenceTelemetry = createConvergenceTelemetry(),
  sourceMode: DCSourceMode = 'operating-point',
  guard?: ProtocolExecutionGuard,
): { result: DCResult; assembler: MNAAssembler; convergence: ConvergenceTelemetry } {
  const { nodeCount, branchCount, nodeNames, branchNames } = compiled;
  const devices = compiled.devices;
  for (const device of devices) device.setTransientRampTime?.(sourceMode === 'transient' ? options.rampTime : 0);
  const assembler = new MNAAssembler(nodeCount, branchCount, {
    deviceGmin: options.deviceGmin,
    variables: createMatrixVariableIdentities(nodeNames, branchNames),
    useDcSourceValue: sourceMode === 'operating-point',
  });
  // The transient operating point (ngspice MODETRANOP, never reached with
  // UIC) holds `.ic` nodes at their values; a plain `.op` does not (#531).
  if (sourceMode === 'transient' && compiled.initialConditions.length > 0) {
    assembler.nodeHolds = initialConditionHolds(compiled);
  }

  for (const device of devices) device.beginOperatingPoint?.();
  assembler.nodeSetHolds = nodeSetHolds(compiled);

  if (initialSolution) {
    assembler.solution.set(initialSolution);
  } else {
    assembler.solution.set(createNodeStateSolution(compiled, 'guess'));
  }

  // ngspice-47 CKTop order: plain Newton from the initial guess first; only
  // when that fails, gmin stepping, then source stepping. A circuit with more
  // than one DC solution (latches, ECL stages) settles on whichever solution
  // the first successful homotopy reaches, so ramping sources up front picks
  // a different operating point than ngspice (#622).
  const hasNonlinear = devices.some(d => d.isNonlinear);
  const initialGuess = new Float64Array(assembler.solution);
  const solveOperatingPoint = (): void => {
    // Models opt in once they implement the device-local INITJCT load.
    // Do not add a second convergence/stopping phase to unrelated models.
    assembler.operatingPointPhase = devices.some(device => device.initializesOperatingPoint)
      || assembler.nodeSetHolds.length > 0 ? 'junction' : undefined;
    try {
      newtonRaphson(assembler, devices, options, options.maxIterations, nodeNames, convergence.dc, guard);
    } catch (err) {
      if (err instanceof ProtocolExecutionError) throw err;
      // A bounded passive subset of ngspice-47's final OPtran fallback.
      // Do not turn arbitrary singular/nonfinite nonlinear stamps into a
      // transient solution, or override an explicitly supplied initial state.
      if (
        err instanceof SingularMatrixError && !hasNonlinear && !initialSolution
        && passiveTransientOperatingPoint(compiled, assembler, options, guard)
      ) return;
      // Fallbacks: gmin stepping homotopies (dynamic, then true gmin), then
      // source stepping, as ngspice-47 CKTop runs them.
      if (
        !hasNonlinear
        || !(
          gminSteppingHomotopy(assembler, devices, options, nodeNames, convergence, guard)
          || sourceStepping(assembler, devices, options, nodeNames, convergence, initialGuess, guard)
          || (err instanceof SingularMatrixError && !initialSolution
            && mos2TransientOperatingPoint(compiled, assembler, options, sourceMode, guard))
        )
      ) {
        if (err instanceof ConvergenceError) {
          convergence.dc.failure = err.kind;
          err.convergence = snapshotConvergenceTelemetry(convergence);
        }
        throw err;
      }
    }
  };

  const events = devices.find(device => device.eventDriven !== undefined)?.eventDriven;
  if (events) {
    // ngspice EVTop: CKTop first, then Newton from the last solution after
    // each event iteration, falling back to CKTop when that fails.
    events.operatingPoint(first => {
      if (first) {
        solveOperatingPoint();
        return;
      }
      const previous = new Float64Array(assembler.solution);
      try {
        newtonRaphson(assembler, devices, options, options.maxIterations, nodeNames, convergence.dc, guard);
      } catch (err) {
        if (err instanceof ProtocolExecutionError) throw err;
        assembler.solution.set(previous);
        solveOperatingPoint();
      }
    });
  } else {
    solveOperatingPoint();
  }
  // Do not leak DC load modes into the transient or small-signal restamp.
  assembler.operatingPointPhase = undefined;

  const voltageMap = new Map<string, number>();
  for (let i = 0; i < nodeNames.length; i++) {
    voltageMap.set(nodeNames[i], assembler.solution[i]);
  }

  const currentMap = new Map<string, number>();
  for (let i = 0; i < branchNames.length; i++) {
    currentMap.set(branchNames[i], assembler.solution[nodeCount + i]);
  }

  return {
    result: new DCResult(voltageMap, currentMap),
    assembler,
    convergence,
  };
}

/**
 * ngspice-47 cpinit/OPtran defaults: 100 ns steps, 10 us horizon, no ramp.
 * This is a finite-time operating point, NOT a DC gauge constraint. In a
 * floating RC island, zero initial charge selects the common mode, and the
 * island can still carry decaying resistor current at the horizon.
 *
 * Only positive passive RC devices and constant independent sources are
 * admitted. Other models need their own MODEINITTRAN state semantics proved
 * before reusing this fallback. No ground shunt or relaxed tolerance is used.
 */
function passiveTransientOperatingPoint(
  compiled: CompiledCircuit,
  assembler: MNAAssembler,
  options: ResolvedOptions,
  guard?: ProtocolExecutionGuard,
): boolean {
  if (options.gmin !== 0 || compiled.initialConditions.length || compiled.nodeSets.length) return false;
  const { devices, nodeCount } = compiled;
  const parent = Int32Array.from({ length: nodeCount + 1 }, (_, i) => i);
  const root = (node: number): number => {
    let i = node < 0 ? nodeCount : node;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a: number, b: number): void => { parent[root(a)] = root(b); };
  let hasCapacitor = false;
  for (const device of devices) {
    if (Object.getPrototypeOf(device) === Capacitor.prototype) {
      const capacitor = device as Capacitor;
      if (!(capacitor.capacitance > 0) || !Number.isFinite(capacitor.capacitance) || capacitor.ic !== undefined) return false;
      hasCapacitor = true;
    } else if (Object.getPrototypeOf(device) === Resistor.prototype) {
      const resistor = device as Resistor;
      if (!(resistor.conductance > 0) || !Number.isFinite(resistor.conductance)) return false;
      join(device.nodes[0], device.nodes[1]);
    } else if (
      Object.getPrototypeOf(device) === VoltageSource.prototype
      || Object.getPrototypeOf(device) === CurrentSource.prototype
    ) {
      const source = device as VoltageSource | CurrentSource;
      if (source.waveform.type !== 'dc' && source.waveform.type !== 'ac') return false;
      if (device instanceof VoltageSource) {
        if (device.port) return false;
        join(device.nodes[0], device.nodes[1]);
      }
    } else {
      return false;
    }
  }
  if (!hasCapacitor) return false;

  // A net DC injection into an isolated component has no static solution.
  // OPtran could integrate it into a finite voltage at 10 us; do not mask
  // this truly inconsistent DC topology. Test exact balance, not a looser
  // current tolerance. The failed plain load is still in assembler.b.
  const injected = new Float64Array(nodeCount + 1);
  let floating = false;
  const ground = root(-1);
  for (let i = 0; i < nodeCount; i++) {
    const component = root(i);
    if (component !== ground) floating = true;
    injected[component] += assembler.b[i];
  }
  if (!floating || injected.some((value, i) => i !== ground && value !== 0)) return false;

  // Initial charge is zero for this restricted subset (no IC, no devices
  // with hidden charge state). The supplied zero vector also prevents a
  // recursive DC solve through the existing transient driver.
  let driver: ReturnType<typeof createDriverFromCompiled> | undefined;
  try {
    driver = createDriverFromCompiled(compiled, options, {
      stopTime: 1e-5,
      timestep: 1e-7,
      maxTimestep: 1e-7,
      initialSolution: new Float64Array(assembler.systemSize),
      guard,
    });
    for (let steps = 0; steps < 10000 && !driver.isDone; steps++) {
      guard?.checkpoint('solve:transient-step');
      driver.advanceSolution();
    }
    const solution = driver.currentSolution();
    if (!driver.isDone || !solution.every(Number.isFinite)) return false;
    assembler.solution.set(solution);
    return true;
  } catch (error) {
    if (error instanceof ProtocolExecutionError) throw error;
    return false;
  } finally {
    driver?.dispose();
  }
}


/**
 * Final CKTop OPtran fallback for RC/MOS2 circuits. MOS2's last-load terminal
 * and charge handoff is explicit; do not opt other nonlinear models in until
 * their MODEINITTRAN semantics are proved. This is the native finite 10 us
 * horizon, not an artificial DC shunt or a relaxed convergence tolerance.
 */
function mos2TransientOperatingPoint(
  compiled: CompiledCircuit,
  assembler: MNAAssembler,
  options: ResolvedOptions,
  sourceMode: DCSourceMode,
  guard?: ProtocolExecutionGuard,
): boolean {
  if (options.gmin !== 0 || compiled.initialConditions.length || compiled.nodeSets.length) return false;
  if (!compiled.devices.some(device => device instanceof MOS2)) return false;
  if (!compiled.devices.every(device =>
    Object.getPrototypeOf(device) === MOS2.prototype
    || (Object.getPrototypeOf(device) === Capacitor.prototype
      && (device as Capacitor).capacitance > 0 && Number.isFinite((device as Capacitor).capacitance)
      && (device as Capacitor).ic === undefined)
    || (Object.getPrototypeOf(device) === Resistor.prototype
      && (device as Resistor).conductance > 0 && Number.isFinite((device as Resistor).conductance))
    || (Object.getPrototypeOf(device) === VoltageSource.prototype && !(device as VoltageSource).port)
    || Object.getPrototypeOf(device) === CurrentSource.prototype,
  )) return false;
  let driver: ReturnType<typeof createDriverFromCompiled> | undefined;
  try {
    driver = createDriverFromCompiled(compiled, options, {
      stopTime: 1e-5, timestep: 1e-7, maxTimestep: 1e-7,
      initialSolution: new Float64Array(assembler.solution),
      operatingPoint: { useDcSourceValue: sourceMode === 'operating-point' },
      guard,
    });
    for (let steps = 0; steps < 10000 && !driver.isDone; steps++) {
      guard?.checkpoint('solve:transient-step');
      driver.advanceSolution();
    }
    const solution = driver.currentSolution();
    if (!driver.isDone || !solution.every(Number.isFinite)) return false;
    assembler.solution.set(solution);
    return true;
  } catch (error) {
    if (error instanceof ProtocolExecutionError) throw error;
    return false;
  } finally {
    driver?.dispose();
    // The real transient starts at physical t=0 with an OP seed, not the
    // artificial integration history of this fallback.
    for (const device of compiled.devices) device.resetTransient?.();
  }
}

/**
 * ngspice-47 CKTop gmin homotopies after a failed plain Newton solve: dynamic
 * gmin stepping, then true gmin stepping. Returns whether the final solve at
 * the nominal gmin converged; the solution is then left in `assembler`.
 */
export function gminSteppingHomotopy(
  assembler: MNAAssembler,
  devices: CompiledCircuit['devices'],
  options: ResolvedOptions,
  nodeNames: string[],
  convergence: ConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
): boolean {
  return dynamicGminStepping(assembler, devices, options, nodeNames, convergence, guard)
    || trueGminStepping(assembler, devices, options, nodeNames, convergence, guard);
}

/** Source scales of the source-stepping fallback, ending at full sources. */
const SOURCE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

/**
 * Source stepping, the last CKTop fallback (ngspice runs it only after both
 * gmin homotopies fail). Restarts from the initial guess and ramps every
 * independent source up through {@link SOURCE_STEPS}, handing each iterate to
 * the next scale; a failed step falls back to the last good iterate. Returns
 * whether the final solve at full sources converged.
 */
function sourceStepping(
  assembler: MNAAssembler,
  devices: CompiledCircuit['devices'],
  options: ResolvedOptions,
  nodeNames: string[],
  convergence: ConvergenceTelemetry,
  initialGuess: Float64Array,
  guard?: ProtocolExecutionGuard,
): boolean {
  assembler.solution.set(initialGuess);
  if (assembler.operatingPointPhase) assembler.operatingPointPhase = 'junction';
  try {
    for (const scale of SOURCE_STEPS) {
      convergence.dc.sourceStepAttempts++;
      const lastGood = new Float64Array(assembler.solution);
      assembler.sourceScale = scale;
      try {
        newtonRaphson(assembler, devices, options, options.maxIterations, nodeNames, convergence.dc, guard);
      } catch (error) {
        if (error instanceof ProtocolExecutionError) throw error;
        convergence.dc.sourceStepFailures++;
        assembler.solution.set(lastGood);
      }
    }
  } finally {
    assembler.sourceScale = 1;
  }
  return finalGminSolve(assembler, devices, options, nodeNames, convergence, guard);
}

/** ngspice defaults: `itl2` (CKTdcTrcvMaxIter), `gminfactor` (CKTgminFactor). */
const DC_TRCV_MAX_ITER = 50;
const GMIN_FACTOR = 10;
/** ngspice-47 NIiter raises any iteration limit below 100 to 100 ("some convergence issues get resolved by increasing max iter"). */
const NIITER_MIN_ITER = 100;
const HOMOTOPY_STEP_MAX_ITER = Math.max(DC_TRCV_MAX_ITER, NIITER_MIN_ITER);

/**
 * Dynamic GMIN stepping, ported from ngspice `dynamic_gmin` (cktop.c, Alan
 * Gillespie). Steps a diagonal shunt on every node from 1e-3 S down to the
 * user-configured `gmin` (ngspice `CKTgshunt`), which the final solve uses.
 *
 * GMIN stepping is a *DC-OP* technique — never a transient-step technique.
 * Committing GMIN-distorted solutions as real transient output samples
 * breaks LC tanks and switching converters (issues #42, #43, #45).
 */
function dynamicGminStepping(
  assembler: MNAAssembler,
  devices: CompiledCircuit['devices'],
  options: ResolvedOptions,
  nodeNames: string[],
  convergence: ConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
): boolean {
  const reachedTarget = stepGmin(
    assembler, Math.max(options.deviceGmin, options.gmin), 1.00005, convergence,
    diagGmin => newtonRaphson(
      assembler, devices, { ...options, gmin: diagGmin }, HOMOTOPY_STEP_MAX_ITER, nodeNames, convergence.dc, guard,
    ),
  );
  return reachedTarget && finalGminSolve(assembler, devices, options, nodeNames, convergence, guard);
}

/**
 * True GMIN stepping, ported from ngspice-47 `new_gmin` (cktop.c), which
 * CKTop runs when dynamic gmin stepping fails. Same adaptive schedule, but it
 * steps the device gmin (`CKTgmin`) that models add across their pn
 * junctions instead of a node-to-ground shunt, and an expensive step keeps a
 * reduction factor of at least 3. For a CMOS stage the junction gmin ties the
 * output to both rails, rather than pulling every node to ground.
 *
 * The final target and restored baseline are the configured junction gmin.
 */
function trueGminStepping(
  assembler: MNAAssembler,
  devices: CompiledCircuit['devices'],
  options: ResolvedOptions,
  nodeNames: string[],
  convergence: ConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
): boolean {
  let reachedTarget: boolean;
  try {
    reachedTarget = stepGmin(
      assembler, options.deviceGmin, 3, convergence,
      deviceGmin => {
        assembler.deviceGmin = deviceGmin;
        return newtonRaphson(
          assembler, devices, options, HOMOTOPY_STEP_MAX_ITER, nodeNames, convergence.dc, guard,
        );
      },
    );
  } finally {
    assembler.deviceGmin = options.deviceGmin;
  }
  return reachedTarget && finalGminSolve(assembler, devices, options, nodeNames, convergence, guard);
}

/**
 * Adaptive gmin schedule shared by ngspice `dynamic_gmin` and `new_gmin`.
 * Restarts from an all-zero node vector and lowers gmin from 1e-3 S towards
 * `gtarget`: the reduction factor grows after cheap steps, shrinks to at
 * least `slowStepFactorFloor` after expensive ones, and a failed step retreats
 * to the last converged iterate with a smaller factor. Returns whether the
 * step at `gtarget` converged.
 */
function stepGmin(
  assembler: MNAAssembler,
  gtarget: number,
  slowStepFactorFloor: number,
  convergence: ConvergenceTelemetry,
  solveAt: (gmin: number) => number,
): boolean {
  assembler.solution.fill(0, 0, assembler.numNodes);
  if (assembler.operatingPointPhase) assembler.operatingPointPhase = 'junction';
  const lastGood = new Float64Array(assembler.solution);
  let factor = GMIN_FACTOR;
  let oldGmin = 1e-2;
  let gmin = oldGmin / factor;

  for (;;) {
    convergence.dc.gminStepAttempts++;
    let iters: number;
    try {
      iters = solveAt(gmin);
    } catch (error) {
      if (error instanceof ProtocolExecutionError) throw error;
      convergence.dc.gminStepFailures++;
      if (factor < 1.00005) return false;
      factor = Math.sqrt(Math.sqrt(factor));
      gmin = oldGmin / factor;
      assembler.solution.set(lastGood);
      continue;
    }
    if (gmin <= gtarget) return true;
    lastGood.set(assembler.solution);
    if (iters <= DC_TRCV_MAX_ITER / 4) factor = Math.min(factor * Math.sqrt(factor), GMIN_FACTOR);
    if (iters > (3 * DC_TRCV_MAX_ITER) / 4) factor = Math.max(Math.sqrt(factor), slowStepFactorFloor);
    oldGmin = gmin;
    if (gmin < factor * gtarget) {
      factor = gmin / gtarget;
      gmin = gtarget;
    } else {
      gmin /= factor;
    }
  }
}

/** Final solve at the nominal gmin after a homotopy — this is the committed answer. */
function finalGminSolve(
  assembler: MNAAssembler,
  devices: CompiledCircuit['devices'],
  options: ResolvedOptions,
  nodeNames: string[],
  convergence: ConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
): boolean {
  convergence.dc.gminStepAttempts++;
  try {
    newtonRaphson(assembler, devices, options, options.maxIterations, nodeNames, convergence.dc, guard);
    return true;
  } catch (error) {
    if (error instanceof ProtocolExecutionError) throw error;
    convergence.dc.gminStepFailures++;
    return false;
  }
}
