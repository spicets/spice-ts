import type { CompiledCircuit } from '../circuit.js';
import type { IntegrationMethod, ResolvedOptions } from '../types.js';
import type { MNAAssembler } from '../mna/assembler.js';
import type { DeviceModel } from '../devices/device.js';
import { buildCompanionSystem } from '../mna/companion.js';
import type { SparseSolver } from '../solver/sparse-solver.js';
import { SingularMatrixError } from '../errors.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';
import { Resistor } from '../devices/resistor.js';
import { Capacitor } from '../devices/capacitor.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { CurrentSource } from '../devices/current-source.js';
import { MOSFET } from '../devices/mosfet.js';

/**
 * When sign-flip oscillation is detected on any node, the per-iteration
 * voltage delta cap tightens to this value for the remainder of the attempt.
 * Empirically chosen to land the iterate in the valley between oscillating
 * candidate solutions (NR-classic adaptive damping; SPICE3 convention).
 */
const TIGHT_LIMIT = 0.5;

/**
 * Shared context for an NR step attempt. The assembler and solver are
 * long-lived — reused across retries so pattern analysis and typed-array
 * allocations amortize. `attemptStep` mutates `assembler` internally; the
 * driver wrapping it may additionally reset `assembler.solution` between
 * retries to restore from a previous snapshot.
 */
export interface StepContext {
  readonly compiled: CompiledCircuit;
  /** Shared assembler — reused across attempts to avoid re-allocation. */
  readonly assembler: MNAAssembler;
  readonly options: ResolvedOptions;
  readonly guard?: ProtocolExecutionGuard;
}

/**
 * Parameters for a single NR attempt at a single timestep.
 */
export interface StepAttempt {
  /** Requested timestep in seconds. */
  readonly dt: number;
  /** Target simulation time (= prev time + dt). */
  readonly time: number;
  /** Solution vector from the previous converged step. */
  readonly prevSolution: Float64Array;
  /** Trapezoidal history vector; interpretation is selected by `staticCurrentHistory`. */
  readonly prevB: Float64Array | undefined;
  /** GMIN to use for this attempt. */
  readonly gmin: number;
  /** Per-iteration node-voltage damping cap (volts). */
  readonly voltageLimit: number;
  /** Solution two steps back — x(n-1). Gear-2 only; undefined triggers BE bootstrap. */
  readonly prevPrevSolution?: Float64Array;
  /** Previous timestep dt(n-1). Gear-2 only. */
  readonly prevDt?: number;
  /** Per-run integration override used by convergence recovery. */
  readonly integrationMethod?: IntegrationMethod;
  /** `prevB` carries an accepted static-current residual instead of a raw RHS. */
  readonly staticCurrentHistory?: boolean;
}

export type StepResult =
  | {
      readonly ok: true;
      /** Converged solution (new Float64Array, safe to retain). */
      readonly solution: Float64Array;
      /** Number of NR iterations used. */
      readonly iterations: number;
      /** True if the damping loop detected NR sign-flip oscillation on any node. */
      readonly oscillated: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'nr-divergence';
      readonly iterations: number;
      readonly lastSolution: Float64Array;
      readonly prevIterSolution: Float64Array;
      readonly oscillated: boolean;
    };

/**
 * Attempt one transient timestep using Newton-Raphson. Caller supplies the
 * assembler and solver; the function builds the companion system, runs NR to
 * convergence (or gives up), and returns either the converged solution or a
 * diagnostic failure result.
 *
 * Leaves `ctx.assembler.solution` in an indeterminate state on failure —
 * callers that need to retry a different `dt` or `gmin` must restore it from
 * their own snapshot (`prevSolution`).
 */
export function attemptStep(ctx: StepContext, attempt: StepAttempt): StepResult {
  const { compiled, assembler, options } = ctx;
  const { devices, nodeCount } = compiled;
  const {
    dt, time, prevSolution, prevB, gmin, prevPrevSolution, prevDt, staticCurrentHistory,
  } = attempt;
  let voltageLimit = attempt.voltageLimit;
  const { watched: limitedNodes, damped: dampedNodes } = nonlinearTerminalNodes(compiled);
  const selfLimiting = selfLimitingDevices(compiled);

  assembler.setTime(time, dt);
  // ngspice dctran.c starts every timepoint, retries included, in MODEINITPRED.
  const predicting = predictingDevices(compiled);
  MOSFET.batchBeginTransientNewton(predicting.mosfets, dt, prevSolution);
  for (const device of predicting.others) device.beginTransientNewton!(dt, prevSolution);

  let prevIterSolution = new Float64Array(assembler.solution);
  let prevDelta: Float64Array | undefined;
  let oscillated = false;
  // At most two iterate/delta buffers per attempt, alternated between Newton
  // iterations: iteration k writes one pair while the other still holds
  // iteration k-1's values (prevIterSolution, prevDelta). Neither is written
  // after this attempt returns, so a returned prevIterSolution stays intact.
  const iterateBuffers: Float64Array<ArrayBuffer>[] = [];
  const deltaBuffers: Float64Array<ArrayBuffer>[] = [];

  for (let iter = 0; iter < options.maxTransientIterations; iter++) {
    ctx.guard?.checkpoint('solve:newton-iteration');
    buildCompanionSystem(
      assembler, devices, dt, attempt.integrationMethod ?? options.integrationMethod,
      prevSolution, prevB, gmin, prevPrevSolution, prevDt, staticCurrentHistory, options.xmu,
    );

    if (!assembler.isFastPath) assembler.lockTopology();
    const solver = assembler.getSparseSolver();
    const x = solveLinearized(solver, assembler);
    if (x === undefined) {
      // ngspice dctran treats any non-zero NIiter return, E_SINGULAR
      // included, as non-convergence and cuts the timestep. A singular or
      // non-finite linear solve mid-transient means this iterate diverged
      // (or dt is too large), not that the circuit topology is invalid: the
      // DC operating point already proved the matrix structurally solvable.
      return {
        ok: false,
        reason: 'nr-divergence',
        iterations: iter + 1,
        lastSolution: new Float64Array(assembler.solution),
        prevIterSolution,
        oscillated,
      };
    }

    const prev = iterateBuffers[iter & 1] ??= new Float64Array(assembler.solution.length);
    prev.set(assembler.solution);

    // Compute raw deltas before damping so oscillation detection sees the actual iterate
    const rawDelta = deltaBuffers[iter & 1] ??= new Float64Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) rawDelta[i] = x[i] - prev[i];

    if (prevDelta) {
      for (const i of limitedNodes) {
        if (rawDelta[i] * prevDelta[i] < 0 && Math.abs(rawDelta[i]) > options.vntol) {
          oscillated = true;
          if (voltageLimit > TIGHT_LIMIT) voltageLimit = TIGHT_LIMIT;
          break;
        }
      }
    }

    // Junction limiting follows the Newton solve itself; node damping below
    // only slows the node down and must not push the limited junction away.
    for (const device of selfLimiting) device.observeTransientNewton?.(x);

    // Damp only nodes a nonlinear device reads (issue #376); see nonlinearTerminalNodes.
    let damped = false;
    for (const i of dampedNodes) {
      const delta = rawDelta[i];
      if (Math.abs(delta) > voltageLimit) {
        x[i] = prev[i] + Math.sign(delta) * voltageLimit;
        damped = true;
      }
    }

    assembler.solution.set(x);

    // ngspice CKTnoncon: an iterate a device had to limit was linearised at a
    // junction voltage the solution does not have, so it cannot converge.
    // The same holds for a node the damping cap clipped: the clipped iterate
    // is not the linear solve's answer and can violate KVL across linear
    // branches (a 0 V source between a capped and an uncapped node, #650).
    // Above |v| = voltageLimit / reltol the cap is inside the relative
    // tolerance, so without this check such an iterate is accepted.
    const limited = damped
      || selfLimiting.some(device => device.limitedLastStamp?.() === true);
    if (
      !limited
      && isConvergedTransient(x, prev, nodeCount, options)
      && convergenceTestedDevices(compiled).every(device => device.convergenceTest!(x, options))
    ) {
      return {
        ok: true,
        solution: new Float64Array(x),
        iterations: iter + 1,
        oscillated,
      };
    }
    // Issue #710: when every device's stamp is independent of the Newton
    // iterate, the next iteration would rebuild exactly this system (same
    // time, dt, history and device state), skip the factorisation as an
    // unchanged input, and solve it to exactly this x. Its delta is then
    // zero, nothing is damped or limited, so it converges with this x and
    // `iter + 2` iterations. Return that result without the rebuild and
    // solve. The guard still sees the iteration's checkpoint.
    if (!limited && iter + 1 < options.maxTransientIterations && isIterationInvariant(compiled)) {
      ctx.guard?.checkpoint('solve:newton-iteration');
      return {
        ok: true,
        solution: new Float64Array(x),
        iterations: iter + 2,
        oscillated,
      };
    }
    prevIterSolution = prev;
    prevDelta = rawDelta;
  }

  return {
    ok: false,
    reason: 'nr-divergence',
    iterations: options.maxTransientIterations,
    lastSolution: new Float64Array(assembler.solution),
    prevIterSolution,
    oscillated,
  };
}

/**
 * Factor and solve the linearised companion system. Returns `undefined` when
 * the matrix is numerically singular or the solution is not finite, so the
 * caller can fail the NR attempt and let the driver cut the timestep.
 */
function solveLinearized(solver: SparseSolver, assembler: MNAAssembler): Float64Array | undefined {
  let x: Float64Array;
  try {
    solver.factorize(assembler.getCscMatrix());
    x = solver.solve(new Float64Array(assembler.b));
  } catch (error) {
    if (error instanceof SingularMatrixError) return undefined;
    throw error;
  }
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) return undefined;
  }
  return x;
}

interface TerminalNodes {
  /** Nodes read by any nonlinear device: watched for sign-flip oscillation. */
  readonly watched: Int32Array;
  /** Watched nodes that also take the per-iteration voltage cap. */
  readonly damped: Int32Array;
}

const nonlinearTerminalCache = new WeakMap<CompiledCircuit, TerminalNodes>();
const selfLimitingCache = new WeakMap<CompiledCircuit, readonly DeviceModel[]>();

function selfLimitingDevices(compiled: CompiledCircuit): readonly DeviceModel[] {
  let devices = selfLimitingCache.get(compiled);
  if (devices === undefined) {
    devices = compiled.devices.filter(device => device.limitsOwnJunctions === true);
    selfLimitingCache.set(compiled, devices);
  }
  return devices;
}

/**
 * Devices with a first-iterate (MODEINITPRED) hook, self-limiting or not:
 * plain level-1 MOSFETs, started together by
 * {@link MOSFET.batchBeginTransientNewton}, and every other one.
 */
interface PredictingDevices {
  readonly mosfets: readonly MOSFET[];
  readonly others: readonly DeviceModel[];
}

const predictingCache = new WeakMap<CompiledCircuit, PredictingDevices>();

function predictingDevices(compiled: CompiledCircuit): PredictingDevices {
  let devices = predictingCache.get(compiled);
  if (devices === undefined) {
    const mosfets: MOSFET[] = [];
    const others: DeviceModel[] = [];
    for (const device of compiled.devices) {
      if (device.beginTransientNewton === undefined) continue;
      if (Object.getPrototypeOf(device) === MOSFET.prototype && !Object.hasOwn(device, 'beginTransientNewton')) {
        mosfets.push(device as MOSFET);
      } else {
        others.push(device);
      }
    }
    devices = { mosfets, others };
    predictingCache.set(compiled, devices);
  }
  return devices;
}

const convergenceTestedCache = new WeakMap<CompiledCircuit, readonly DeviceModel[]>();
const iterationInvariantCache = new WeakMap<CompiledCircuit, boolean>();

/** Exactly an instance of `type`: no subclass and no own `stamp` override. */
function isPlainInstance(device: DeviceModel, type: { prototype: object }): boolean {
  return Object.getPrototypeOf(device) === type.prototype
    && !Object.hasOwn(device, 'stamp')
    && !Object.hasOwn(device, 'stampDynamic');
}

/**
 * True when no device's transient stamp depends on the Newton iterate, so two
 * companion builds within one step attempt give bit-identical systems (issue
 * #710). Only device classes whose `stamp`/`stampDynamic` read nothing but
 * their own parameters and the stamp time qualify: plain resistors,
 * capacitors, and independent sources other than TRNOISE/TRRANDOM. Any other
 * device, subclass or instance override disables the shortcut.
 */
export function isIterationInvariant(compiled: CompiledCircuit): boolean {
  let invariant = iterationInvariantCache.get(compiled);
  if (invariant === undefined) {
    invariant = compiled.devices.every(device => {
      if (isPlainInstance(device, Resistor) || isPlainInstance(device, Capacitor)) return true;
      if (isPlainInstance(device, VoltageSource) || isPlainInstance(device, CurrentSource)) {
        const { type } = (device as VoltageSource | CurrentSource).waveform;
        return type !== 'trnoise' && type !== 'trrandom';
      }
      return false;
    });
    iterationInvariantCache.set(compiled, invariant);
  }
  return invariant;
}

/** Devices with their own ngspice DEVconvTest (e.g. B sources). */
function convergenceTestedDevices(compiled: CompiledCircuit): readonly DeviceModel[] {
  let devices = convergenceTestedCache.get(compiled);
  if (devices === undefined) {
    devices = compiled.devices.filter(device => device.convergenceTest !== undefined);
    convergenceTestedCache.set(compiled, devices);
  }
  return devices;
}

/**
 * Node indices read by at least one nonlinear device, ascending, and the
 * subset that takes the per-iteration voltage cap.
 *
 * Every other node is read by linear stamps alone, so it never feeds the next
 * linearisation: capping it cannot help Newton and only stalls convergence of
 * large linear jumps (issue #376, e.g. V = L di/dt across an inductor).
 *
 * Nodes of devices that limit their own junctions against the previous
 * iterate (ngspice DEVpnjlim) are not capped either. ngspice never damps node
 * voltages; with a capped node the solution cannot follow the limited
 * junction, the junction keeps stepping away from the node, and Newton
 * ratchets to the timestep floor (the boost converter in
 * transient-driver-integration.test.ts).
 *
 * Nodes of devices ngspice neither limits nor damps (`undampedNodes`, the
 * ASRC `B` sources) are not capped either: a capped B-source node cannot take
 * the first-step jump from a UIC seed, e.g. 0 V to a 7 kV capacitor IC
 * across a 0 V source (issue #649).
 */
function nonlinearTerminalNodes(compiled: CompiledCircuit): TerminalNodes {
  let nodes = nonlinearTerminalCache.get(compiled);
  if (nodes === undefined) {
    const marked = new Uint8Array(compiled.nodeCount);
    const needsDamping = new Uint8Array(compiled.nodeCount);
    for (const device of compiled.devices) {
      if (!device.isNonlinear) continue;
      for (const node of device.nodes) {
        if (node < 0 || node >= compiled.nodeCount) continue;
        marked[node] = 1;
        if (!device.limitsOwnJunctions && !device.undampedNodes) needsDamping[node] = 1;
      }
    }
    const watched: number[] = [];
    const damped: number[] = [];
    for (let i = 0; i < marked.length; i++) {
      if (!marked[i]) continue;
      watched.push(i);
      if (needsDamping[i]) damped.push(i);
    }
    nodes = { watched: Int32Array.from(watched), damped: Int32Array.from(damped) };
    nonlinearTerminalCache.set(compiled, nodes);
  }
  return nodes;
}

function isConvergedTransient(
  current: Float64Array,
  previous: Float64Array,
  numNodes: number,
  options: ResolvedOptions,
): boolean {
  // ngspice-47 NIconvTest: every unknown, node voltages against RELTOL*max +
  // VNTOL and branch currents against RELTOL*max + ABSTOL, with max the
  // larger magnitude of the two iterates. Skipping the branch currents
  // accepted iterates ngspice still refines (#818): the extra iteration moves
  // the accepted point by microvolts, which a regenerative circuit amplifies
  // into a different Newton outcome on its switching step.
  for (let i = 0; i < current.length; i++) {
    const diff = Math.abs(current[i] - previous[i]);
    const scale = Math.max(Math.abs(current[i]), Math.abs(previous[i]));
    const tol = options.reltol * scale + (i < numNodes ? options.vntol : options.abstol);
    if (diff > tol) return false;
  }
  return true;
}
