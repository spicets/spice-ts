import type { DeviceModel } from '../devices/device.js';
import type { MNAAssembler } from '../mna/assembler.js';
import type { DCConvergenceTelemetry, ResolvedOptions } from '../types.js';
import { ConvergenceError } from '../errors.js';
import { MOSFET } from '../devices/mosfet.js';
import { BehavioralSource } from '../devices/behavioral-source.js';
import { stampStaticDevices } from '../mna/linear-stamp.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';

/**
 * A device list's Newton step limiters: the plain MOS1 instances, whose limits
 * {@link MOSFET.batchNewtonStepScale} evaluates from contiguous arrays, and
 * every other device implementing `limitNewtonStep`.
 */
interface StepLimiters {
  readonly length: number;
  readonly mosfets: readonly MOSFET[];
  readonly others: readonly DeviceModel[];
}

const stepLimiters = new WeakMap<readonly DeviceModel[], StepLimiters>();

function stepLimitersFor(devices: readonly DeviceModel[]): StepLimiters {
  const cached = stepLimiters.get(devices);
  if (cached !== undefined && cached.length === devices.length) return cached;
  const mosfets: MOSFET[] = [];
  const others: DeviceModel[] = [];
  for (const device of devices) {
    if (!device.limitNewtonStep) continue;
    if (
      Object.getPrototypeOf(device) === MOSFET.prototype
      && !Object.hasOwn(device, 'limitNewtonStep')
    ) {
      mosfets.push(device as MOSFET);
    } else {
      others.push(device);
    }
  }
  const limiters = { length: devices.length, mosfets, others };
  stepLimiters.set(devices, limiters);
  return limiters;
}

/**
 * Scale the Newton step by the smallest device step limit. The Math.min of
 * the same per-device scales in any order, so grouping the MOS1 instances
 * into one batch leaves the result bit-identical.
 */
function applyDeviceStepLimits(
  devices: readonly DeviceModel[],
  previous: Float64Array,
  candidate: Float64Array,
): void {
  const { mosfets, others } = stepLimitersFor(devices);
  let scale = mosfets.length > 0 ? MOSFET.batchNewtonStepScale(mosfets, previous, candidate) : 1;
  for (let i = 0; i < others.length; i++) {
    scale = Math.min(scale, others[i].limitNewtonStep!(previous, candidate));
  }
  if (scale >= 1) return;
  for (let i = 0; i < candidate.length; i++) {
    candidate[i] = previous[i] + scale * (candidate[i] - previous[i]);
  }
}

export function newtonRaphson(
  assembler: MNAAssembler,
  devices: DeviceModel[],
  options: ResolvedOptions,
  maxIter: number,
  nodeNames: string[],
  telemetry?: DCConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
): number {
  // Pre-classify devices for batch stamping (built lazily after first iteration)
  let mosfets: MOSFET[] | null = null;
  let otherDevices: DeviceModel[] | null = null;
  const selfLimiting = devices.filter(device => device.limitedLastStamp !== undefined);
  const convergenceTested = devices.filter(device => device.convergenceTest !== undefined);
  const behavioral = devices.filter((device): device is BehavioralSource => device instanceof BehavioralSource);
  let certifiedOverflow = false;
  const acceptOverflow = behavioral.length > 0
    ? (candidate: Float64Array) => {
      certifiedOverflow = behavioral.some(device => device.hasInfiniteValueAtFiniteControls(candidate));
      return certifiedOverflow;
    }
    : undefined;
  // The iterate two solves back, to recognise a rounding-floor two-cycle.
  const twoBack = convergenceTested.length > 0 ? new Float64Array(assembler.solution.length) : undefined;
  let releasedNodeset = false;

  for (let iter = 0; iter < maxIter; iter++) {
    guard?.checkpoint('solve:newton-iteration');
    twoBack?.set(assembler.prevSolution);
    assembler.saveSolution();
    assembler.clear();

    const ctx = assembler.getStampContext();

    if (assembler.isFastPath && mosfets !== null && mosfets.length > 0) {
      // Fast path: batch-stamp MOSFETs with direct array writes
      MOSFET.batchStamp(
        mosfets, assembler.gValues, assembler.b, assembler.solution,
        assembler.stampIndex, assembler.deviceGmin,
      );
      stampStaticDevices(assembler, otherDevices!, ctx);
    } else {
      stampStaticDevices(assembler, devices, ctx);
    }

    // ngspice cktload.c forces held node rows after the device load.
    if (assembler.operatingPointPhase === 'junction' || assembler.operatingPointPhase === 'fixed') {
      assembler.applyNodeHolds(assembler.nodeSetHolds, false);
    }
    assembler.applyNodeHolds();

    if (!assembler.isFastPath) {
      // First iteration: Map-based stamp completed. Add GMIN via Map, then lock topology.
      for (let i = 0; i < assembler.numNodes; i++) {
        assembler.G.add(i, i, options.gmin);
      }
      assembler.lockTopology();
      // Classify devices for batch stamping now that fast path is active
      mosfets = [];
      otherDevices = [];
      for (const d of devices) {
        if (d instanceof MOSFET) mosfets.push(d);
        else otherDevices.push(d);
      }
    } else {
      // Fast path: GMIN via direct array write
      const gv = assembler.gValues;
      const diag = assembler.diagIdx;
      for (let i = 0; i < assembler.numNodes; i++) {
        gv[diag[i]] += options.gmin;
      }
    }

    const solver = assembler.getSparseSolver();
    solver.factorize(assembler.getCscMatrix());
    const previousOverflow = certifiedOverflow;
    certifiedOverflow = false;
    const x = solver.solve(new Float64Array(assembler.b), acceptOverflow);
    applyDeviceStepLimits(devices, assembler.prevSolution, x);
    assembler.solution.set(x);

    // ngspice CKTnoncon: an iterate a device had to limit was linearised at a
    // junction voltage the solution does not have, so it is not converged.
    const converged = (
      // ngspice-47 niiter.c:287-290 forces CKTnoncon on the first load/solve,
      // even when the initial guess already satisfies the tolerances.
      iter > 0 && isConverged(assembler.solution, assembler.prevSolution, assembler.numNodes, options)
      && !selfLimiting.some(device => device.limitedLastStamp!())
      && (
        convergenceTested.every(device => device.convergenceTest!(assembler.solution, options))
        || (iter >= 2 && isRoundingFloorCycle(assembler.solution, assembler.prevSolution, twoBack!, assembler.numNodes))
      )
    );
    if (assembler.operatingPointPhase === 'junction') {
      assembler.operatingPointPhase = 'fixed';
      continue;
    }
    if (assembler.operatingPointPhase === 'fixed') {
      if (converged) {
        assembler.operatingPointPhase = 'floating';
        releasedNodeset = assembler.nodeSetHolds.length > 0;
      }
      continue;
    }
    if (releasedNodeset) {
      releasedNodeset = false;
      continue;
    }
    if (converged) {
      // A certified infinite expression yields inf - inf in the next affine
      // stamp. ngspice reports CKTrhsOld (the linearisation point), not that
      // NaN solve (#847). Keep that certified point only on this exceptional
      // path; finite solves retain the project's converged-solve convention.
      if (previousOverflow) assembler.solution.set(assembler.prevSolution);
      if (telemetry) {
        telemetry.newtonIterations += iter + 1;
        telemetry.acceptedSolves++;
      }
      return iter + 1;
    }
  }

  const oscillating = findOscillatingNodes(
    assembler.solution, assembler.prevSolution,
    assembler.numNodes, nodeNames, options,
  );

  if (telemetry) {
    telemetry.newtonIterations += maxIter;
    telemetry.rejectedSolves++;
  }

  throw new ConvergenceError(
    `Did not converge in ${maxIter} iterations`,
    undefined, oscillating,
    new Float64Array(assembler.solution),
    new Float64Array(assembler.prevSolution),
  );
}

function isConverged(
  current: Float64Array, previous: Float64Array,
  numNodes: number, options: ResolvedOptions,
): boolean {
  for (let i = 0; i < current.length; i++) {
    const diff = Math.abs(current[i] - previous[i]);
    const tol = i < numNodes
      ? options.vntol + options.reltol * Math.abs(current[i])
      : options.abstol + options.reltol * Math.abs(current[i]);
    if (diff > tol) return false;
  }
  return true;
}

/**
 * Newton has reached the floating-point floor: the solve returned exactly the
 * iterate two solves back, and every node voltage moved by about one double
 * spacing. Linearised at either iterate, the stamped system's exact solution
 * is the same fixed point (the one ngspice-47 lands on), but LU rounding
 * returns its neighbour, so further iterations repeat the pair forever. With
 * a tiny ABSTOL a device convergence test (mos2conv.c) cannot pass on such a
 * pair, since one ulp of a node voltage times a triode gds already exceeds
 * ABSTOL. Only reached once the node test has passed and no junction was
 * limited; a cycle wider than one ulp still fails.
 */
function isRoundingFloorCycle(
  current: Float64Array, previous: Float64Array, twoBack: Float64Array, numNodes: number,
): boolean {
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== twoBack[i]) return false;
  }
  for (let i = 0; i < numNodes; i++) {
    const spacing = Number.EPSILON * Math.max(Math.abs(current[i]), Math.abs(previous[i]));
    if (Math.abs(current[i] - previous[i]) > spacing) return false;
  }
  return true;
}

function findOscillatingNodes(
  current: Float64Array, previous: Float64Array,
  numNodes: number, nodeNames: string[], options: ResolvedOptions,
): string[] {
  const result: string[] = [];
  for (let i = 0; i < numNodes; i++) {
    const diff = Math.abs(current[i] - previous[i]);
    const tol = options.vntol + options.reltol * Math.abs(current[i]);
    if (diff > tol) result.push(nodeNames[i] ?? `node_${i}`);
  }
  return result;
}
