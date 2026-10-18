import { XspiceEventNetwork } from '../devices/xspice/event-network.js';
import type {
  ConvergenceTelemetry, ResolvedOptions, SimulationOptions, TransientAnalysis,
} from '../types.js';
import type { CompiledCircuit } from '../circuit.js';
import { TransientResult } from '../results.js';
import { deviceOutputVector } from '../control-device-output.js';
import { InvalidCircuitError } from '../errors.js';
import { createDriverFromCompiled } from './transient-driver.js';
import { transientStepCap } from './max-timestep.js';

export { runnableTransient } from './max-timestep.js';
import { ColumnRecorder } from './transient-columns.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';

/**
 * Whether an accepted timepoint is part of the `.tran` output. Integration
 * always starts at t = 0; like ngspice dctran.c (`CKTtime >= CKTinitTime`),
 * only points at or after TSTART are saved.
 *
 * Under `uic` the t = 0 point is the UIC seed, not a solution: it holds only
 * the .ic / IC= values, so source-driven nodes read 0 V (#856). ngspice-47
 * never dumps it (dctran.c: `MODEUIC && CKTtime > 0 && CKTtime >=
 * CKTinitTime`); its first output point is the first accepted step.
 */
export function isSavedTransientPoint(analysis: TransientAnalysis, time: number): boolean {
  if (analysis.useInitialConditions && time <= 0) return false;
  return time >= (analysis.startTime ?? 0);
}

/**
 * One-shot transient analysis. Consumes a {@link TransientSim} internally
 * and accumulates every saved timestep (t >= TSTART) into a
 * {@link TransientResult}.
 */
export function solveTransient(
  compiled: CompiledCircuit,
  analysis: TransientAnalysis,
  options: ResolvedOptions,
  initialSolution?: Float64Array,
  convergence?: ConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
  stopWhen?: (result: TransientResult) => boolean,
  savedDeviceVectors: readonly string[] = [],
): TransientResult {
  const { nodeNames, branchNames } = compiled;
  const saved = savedDeviceVectors;
  const deviceArrays = new Map(saved.map(name => [name, [] as number[]]));
  const driver = createDriverFromCompiled(compiled, options, {
    stopTime: analysis.stopTime,
    timestep: analysis.timestep,
    maxTimestep: transientStepCap(analysis),
    initialSolution,
    useInitialConditions: analysis.useInitialConditions,
    convergence,
    guard,
  });

  const timePoints: number[] = [];
  const voltageArrays = new Map<string, number[]>();
  const currentArrays = new Map<string, number[]>();
  for (const name of nodeNames) voltageArrays.set(name, []);
  for (const name of branchNames) currentArrays.set(name, []);

  // Record each saved point straight from the solution vector (#548). The
  // driver's TransientStep Maps (`advance()`) cost two Map inserts per
  // variable per step; on large linear decks that was the top self-time
  // frame. The column plan below reproduces those Maps' semantics exactly:
  // one column per distinct name, in first-occurrence order, holding the
  // solution entry of the name's last occurrence (Map.set overwrites).
  const nodeSlots = new Map<string, number>();
  for (const name of nodeNames) nodeSlots.set(name, compiled.nodeIndexMap.get(name)!);
  const branchSlots = new Map<string, number>();
  branchNames.forEach((name, i) => branchSlots.set(name, compiled.nodeCount + i));
  const columns: number[][] = [];
  const slots: number[] = [];
  for (const [name, slot] of nodeSlots) { columns.push(voltageArrays.get(name)!); slots.push(slot); }
  for (const [name, slot] of branchSlots) { columns.push(currentArrays.get(name)!); slots.push(slot); }
  // Points are buffered in a typed chunk and appended a column at a time
  // (#609); the columns are complete once `flush()` runs below.
  const recorder = new ColumnRecorder(columns, slots);
  const save = (time: number, solution: Float64Array): boolean => {
    guard?.recordResultPoint();
    timePoints.push(time);
    recorder.record(solution);
    for (const name of saved) {
      const match = /^@([^\s[\]]+)\[([^\s[\]]+)\]$/.exec(name);
      const values = match && deviceOutputVector({
        devices: compiled.devices, solution, nodeCount: compiled.nodeCount, deviceGmin: options.gmin,
      }, match[1], match[2]);
      if (!values) throw new InvalidCircuitError(`Unsupported saved device vector '${name}'`);
      deviceArrays.get(name)!.push(values[0]);
    }
    if (!stopWhen) return false;
    // ngspice-47 dctran.c:430-435 checks autostop after an accepted point.
    // Flush buffered columns before exposing the saved prefix; do not change
    // the driver's stop time or timestep trajectory to reach measurements.
    recorder.flush();
    return stopWhen(new TransientResult(timePoints, voltageArrays, currentArrays));
  };

  try {
    // Seed with the DC operating point at t=0
    let stopped = isSavedTransientPoint(analysis, driver.simTime)
      && save(driver.simTime, driver.currentSolution());
    while (!driver.isDone && !stopped) {
      guard?.checkpoint('solve:transient-step');
      const solution = driver.advanceSolution();
      if (isSavedTransientPoint(analysis, driver.simTime)) stopped = save(driver.simTime, solution);
    }
  } finally {
    driver.dispose();
  }
  recorder.flush();

  const events = compiled.devices.find(device => device instanceof XspiceEventNetwork) as XspiceEventNetwork | undefined;
  return new TransientResult(timePoints, voltageArrays, currentArrays, events?.nodeHistories(),
    new Map([...deviceArrays].map(([name, values]) => [name, Float64Array.from(values)])));
}
