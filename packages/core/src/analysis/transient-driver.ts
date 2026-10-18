import type { Circuit, CompiledCircuit } from '../circuit.js';
import type {
  ConvergenceTelemetry, IntegrationMethod, SimulationOptions, ResolvedOptions, TransientStep,
} from '../types.js';
import { resolveOptions, withNetlistOptions } from '../types.js';
import { parse, parseAsync } from '../parser/index.js';
import { createMatrixVariableIdentities, MNAAssembler } from '../mna/assembler.js';
import { stampStaticDevices } from '../mna/linear-stamp.js';
import { solveDCOperatingPoint } from './dc.js';
import { attemptStep } from './transient-step.js';
import { ConvergenceError, TimestepTooSmallError, InvalidCircuitError } from '../errors.js';
import { BreakpointQueue } from './breakpoint-queue.js';
import { TransientProgressMonitor } from './transient-progress.js';
import { computeUICInitialSolution } from './uic.js';
import {
  createConvergenceTelemetry, resetConvergenceTelemetry, snapshotConvergenceTelemetry,
} from '../convergence-telemetry.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';
import { Inductor } from '../devices/inductor.js';
import { MOS2 } from '../devices/mos2.js';
import { maxTimestepOption, runnableTransient, transientStepCap } from './max-timestep.js';
import { chargeTruncatedNodes } from './transient-node-truncation.js';
import { LinearReactiveTruncation } from './transient-reactive-truncation.js';
import type {
  ChargeIntegration, DeviceModel, EventDrivenNetwork, TransientBreakpointSink,
} from '../devices/device.js';

/**
 * Smallest allowed timestep (femtosecond). Must be small enough that LTE can
 * shrink dt to satisfy accuracy at fast switching edges (rise/fall ~100 ns).
 * Raising this above ~1e-13 causes the LTE bypass to trigger pathologically
 * often on hard-switching circuits like the buck, inflating timepoint counts
 * by 10–15× — keep at 1e-15.
 */
const MIN_TIMESTEP = 1e-15;
/**
 * Below this floor, voltage-predictor LTE estimates are dominated by the
 * conditioning of reactive companion matrices rather than useful truncation
 * error information. Let converged steps grow out of that numerical regime.
 */
const MIN_LTE_TIMESTEP = 100 * MIN_TIMESTEP;
const NR_VOLTAGE_LIMIT = 3.5;
/**
 * After this many consecutive LTE rejections, stop LTE-checking to avoid
 * pathological shrink loops on stiff problems. SPICE-convention heuristic.
 */
const MAX_LTE_REJECTS_BEFORE_BYPASS = 10;

/**
 * On NR failure, divide dt by this factor and retry. ngspice `dctran.c` uses 8.
 * GMIN stepping is NOT applied per-step here — it's a DC-OP technique and
 * committing GMIN-distorted solutions as real output samples breaks LC tanks,
 * boost converters, and other reactive circuits (see issues #42, #43, #45).
 */
const DT_CUT_FACTOR = 8;

/**
 * "Indistinguishably close" threshold for a step landing on a breakpoint.
 * ngspice calls this CKTminBreak; we use 10× MIN_TIMESTEP so the snap is
 * always well above floating-point noise but far below any real timestep.
 */
const MIN_BREAK = 1e-14;

/** The first timepoint of the run is cut by this after the t=0 breakpoint limit (ngspice dctran.c). */
const POST_BREAK_DT_CUT = 10;

/**
 * The step after a breakpoint spans at most this fraction of MIN(CKTsaveDelta,
 * gap to the next breakpoint) (ngspice dctran.c).
 */
const START_BREAK_GAP_FRACTION = 0.1;

/**
 * ngspice dctran.c equalises the last two steps before a breakpoint when
 * `CKTtime + 1.9 * CKTdelta > CKTbreaks[0]`, instead of leaving a short tail.
 */
const BREAK_EQUALISE_FACTOR = 1.9;

/** ngspice AlmostEqualUlps(CKTtime + CKTdelta, CKTfinalTime, 100) tolerance in ulps. */
const FINAL_TIME_ULPS = 100;

/** ngspice dctran.c initial delta: MIN(TSTOP / 100, TSTEP) / 10. */
const INITIAL_STEP_STOP_DIVISOR = 100;
const INITIAL_STEP_DIVISOR = 10;

/** ngspice dctran.c initial CKTsaveDelta: TSTOP / 50. */
const SAVE_DELTA_STOP_DIVISOR = 50;

/** ngspice dctran.c CKTdelmin = 1e-11 x CKTmaxStep; a breakpoint step stays above 2 x delmin. */
const DELMIN_FRACTION = 1e-11;

/** Keep implicit-breakpoint recovery local while still crossing a vanished branch. */
const IMPLICIT_BREAK_DT_CUT = 5;

/**
 * A trial step whose charge truncation bound falls below this fraction of the
 * step is rejected (ngspice dctran.c: `newdelta > .9 * CKTdelta` accepts).
 */
const CHARGE_LTE_ACCEPT_FRACTION = 0.9;

/**
 * ngspice dctran.c raises the order after an order-1 step only when the
 * order-2 truncation bound exceeds this multiple of the step.
 */
const RAISE_ORDER_FRACTION = 1.05;

/** Assembler stamp-pass kind of the trapezoidal history restamp (stampPrevB). */
const HISTORY_STAMP_PASS = 1;

/** Switch away from trapezoidal integration after a sustained NR retry cycle. */
const MAX_TRAP_NR_RETRIES = 1_024;

/**
 * Resumable transient simulation driver.
 *
 * Call {@link createTransientSim} to obtain one. Use {@link advance} or
 * {@link advanceUntil} to step the simulation forward, {@link reset} to
 * restart at t=0, and {@link dispose} when done.
 */
export interface TransientSim {
  readonly simTime: number;
  readonly stopTime: number | undefined;
  readonly isDone: boolean;
  /** Immutable snapshot of convergence counters accumulated so far. */
  readonly convergence: ConvergenceTelemetry;

  /** Advance one converged timestep. Throws {@link ConvergenceError} on failure. */
  advance(): TransientStep;
  /** Convenience: loop {@link advance} until `simTime >= targetTime`. */
  advanceUntil(targetTime: number): TransientStep[];
  /** Re-run DC operating point, clear history, reset simTime to 0. */
  reset(): void;
  /** Release solver memory. Subsequent calls throw. */
  dispose(): void;
}

/** Debug-only rejected trial. Both LTE tests can fail on the same trial. */
export interface TransientRejection {
  reason: 'voltage-lte' | 'charge-lte' | 'voltage-and-charge-lte' | 'newton' | 'breakpoint';
  /** Trial endpoint, not the last accepted time. */
  time: number;
  timestep: number;
  nextTimestep: number;
  voltageRatio?: number;
  chargeBound?: number;
}

export interface TransientSimOptions extends SimulationOptions {
  stopTime?: number;
  timestep?: number;
  maxTimestep?: number;
  /** Opt-in synchronous debug observer. No event is allocated when absent. */
  onReject?: (rejection: TransientRejection) => void;
}

export async function createTransientSim(
  input: string | Circuit,
  options?: TransientSimOptions,
): Promise<TransientSim> {
  let circuit: Circuit;
  if (typeof input === 'string') {
    circuit = options?.resolveInclude
      ? await parseAsync(input, options.resolveInclude)
      : parse(input);
  } else {
    circuit = input;
  }
  const compiled = circuit.compile();
  const effectiveOptions = withNetlistOptions<TransientSimOptions>(compiled.simulationOptions, options);

  const found = compiled.analyses.find(a => a.type === 'tran');
  const tranAnalysis = found?.type === 'tran' ? found : undefined;
  let stopTime: number | undefined;
  let timestep: number;
  let maxTimestep: number;
  if (tranAnalysis) {
    // Same step grid as simulate() (#678): `.tran` TMAX wins over the
    // maxTimestep option, which replaces the min(TSTEP, TSTOP/50) default;
    // a zero TSTEP runs at that cap. stopTime/timestep options override the
    // card's TSTOP/TSTEP before the cap is derived.
    const runnable = runnableTransient({
      ...tranAnalysis,
      stopTime: effectiveOptions.stopTime ?? tranAnalysis.stopTime,
      timestep: effectiveOptions.timestep ?? tranAnalysis.timestep,
    }, effectiveOptions);
    ({ stopTime, timestep } = runnable);
    maxTimestep = transientStepCap(runnable);
  } else {
    stopTime = effectiveOptions.stopTime;
    timestep = effectiveOptions.timestep ?? (stopTime ? stopTime / 50 : 1e-6);
    maxTimestep = maxTimestepOption(effectiveOptions.maxTimestep)
      ?? (stopTime ? Math.min(timestep, stopTime / 50) : timestep * 10);
  }

  const resolved = resolveOptions(effectiveOptions, stopTime);

  return new TransientSimImpl(compiled, resolved, {
    stopTime, timestep, maxTimestep, onReject: options?.onReject,
    initialSolution: tranAnalysis?.useInitialConditions
      ? computeUICInitialSolution(compiled)
      : undefined,
    useInitialConditions: tranAnalysis?.useInitialConditions === true,
  });
}

interface InternalTransientConfig {
  onReject?: (rejection: TransientRejection) => void;
  stopTime: number | undefined;
  timestep: number;
  maxTimestep: number;
  /** Optional pre-computed DC solution. When provided, skips internal DC op point. */
  initialSolution?: Float64Array;
  /**
   * `.tran ... uic`: {@link initialSolution} is the UIC seed, not a solution
   * of the circuit equations (#560). It sets capacitor voltages and inductor
   * currents from their ICs but leaves algebraic nodes at an arbitrary value.
   */
  useInitialConditions?: boolean;
  /** Local OPtran integration clock; device/source physical time stays zero. */
  operatingPoint?: { useDcSourceValue: boolean };
  /** Shared aggregate used by one-shot simulations. */
  convergence?: ConvergenceTelemetry;
  /** Cooperative guard used by bounded protocol executions. */
  guard?: ProtocolExecutionGuard;
}

class TransientSimImpl implements TransientSim {
  private assembler: MNAAssembler;
  private options: ResolvedOptions;
  private config: InternalTransientConfig;
  private compiled: CompiledCircuit;
  private convergenceTelemetry: ConvergenceTelemetry;
  private readonly useStaticCurrentHistory: boolean;
  private readonly useDampedInductiveRecovery: boolean;
  /** Devices with an ngspice DEVtrunc charge truncation-error hook. */
  private readonly truncatingDevices: readonly DeviceModel[];
  /** Devices with an `acceptTransientStep` hook, in netlist order. */
  private readonly acceptingDevices: readonly DeviceModel[];
  /** Charge-integrating devices with an accepted charge current, in netlist order. */
  private readonly chargeCurrentDevices: readonly DeviceModel[];
  /** Nodes a device sets algebraically (no truncation error in ngspice); skipped by the node LTE. */
  private readonly lteExemptNodes: Uint8Array;
  /** ngspice CAPtrunc/INDtrunc for the linear C, L and K elements (#621). */
  private readonly reactiveTruncation: LinearReactiveTruncation;

  private time = 0;
  private dt: number;
  private prevB: Float64Array | undefined;
  private historyWorkspace: Float64Array | undefined;
  private secondPrevSol: Float64Array | undefined;
  private prevDt: number;
  /** Accepted step before {@link prevDt} (ngspice CKTdeltaOld[2]). */
  private prevPrevDt: number;
  private integrationMethod: IntegrationMethod;
  private trapNrRetries = 0;
  private lteRejectCount = 0;
  private disposed = false;
  private breakpoints: BreakpointQueue;
  /** Accepted time of the {@link acceptTransientStep} pass in progress. */
  private acceptingTime = 0;
  /** Device-created breakpoints (ngspice CKTsetBreak from DEVaccept). */
  private readonly breakpointSink: TransientBreakpointSink = {
    schedule: time => {
      // Absent only while the constructor accepts t=0, where no history exists yet.
      this.breakpoints?.insert(time, this.acceptingTime);
    },
    replaceTemporary: (owner, times) => {
      this.breakpoints?.replaceTemporary(owner, times, this.acceptingTime);
    },
  };
  private justCrossedBreakpoint = false;
  /**
   * ngspice CKTsaveDelta: the step size before it was cut to land on, or
   * halved to equalise the approach to, the next breakpoint. The step after
   * that breakpoint is limited by it rather than by the snapped step (#608).
   */
  private saveDelta = Infinity;
  /**
   * Take the next step at order 1 (Backward Euler) without higher-order
   * history. Set when a device reports a breakpoint at t=0: the DC operating
   * point carries no derivative information, so a trapezoidal first step
   * across that kink treats the new source slope as if it had always existed
   * and leaves an undamped +/- ringing in algebraic reactive voltages
   * (ngspice dctran.c integrates the first step at order 1). The progress
   * monitor requests the same restart when that ringing appears behind a
   * slope discontinuity no device reports as a breakpoint.
   */
  private orderOnePending = false;
  /**
   * The next accepted point is the first of the run (ngspice dctran.c
   * `firsttime`). ngspice accepts it without CKTtrunc: CKTdelta is kept for
   * the second step and the order stays 1 (#742, #561).
   */
  private firstStepPending = false;
  /**
   * The previous accepted point is the UIC seed (#560). Its algebraic node
   * voltages violate KCL, so it is neither trapezoidal history nor a point
   * of the node-voltage LTE predictor. ngspice-47 keeps only device states
   * from it: MODEINITTRAN loads capacitor and inductor states from their ICs
   * and CKTterr truncates on device charges, not node voltages.
   */
  private startsFromUICSeed = false;
  private progress: TransientProgressMonitor;
  /** The XSPICE event-driven network, when the circuit has digital code models. */
  private readonly events: EventDrivenNetwork | undefined;

  constructor(compiled: CompiledCircuit, options: ResolvedOptions, config: InternalTransientConfig) {
    this.compiled = compiled;
    this.options = options;
    this.config = config;
    this.convergenceTelemetry = config.convergence ?? createConvergenceTelemetry();
    for (const device of compiled.devices) {
      device.setTransientTimestep?.(config.timestep, config.stopTime);
      device.setTransientRampTime?.(options.rampTime);
    }
    // Voltage-dependent capacitances stamped as C(v) need charge state, which
    // the C-matrix companion does not keep. Preserve their established
    // companion history while using the exact static residual for constant-C
    // circuits. Devices that integrate their own charge keep that state.
    // A nonlinear device that stores no charge (e.g. a diode without CJO, CJSW
    // or TT) is static: the raw-RHS history would pair the new Newton
    // conductance with the old operating point and misintegrate its current.
    // Source breakpoints do not change this (#482): ngspice NIintegrate keeps
    // the accepted capacitor current across PULSE/PWL corners too, and the
    // first step after a breakpoint drops the history (Backward Euler) anyway.
    this.useStaticCurrentHistory = !compiled.devices.some(device => (
      (device.isNonlinear && device.stampDynamic !== undefined
        && device.storesCharge !== false && !device.integratesTransientCharge)
    ));
    this.useDampedInductiveRecovery = compiled.devices.some(device => device instanceof Inductor)
      && compiled.devices.some(device => device.isNonlinear);
    this.truncatingDevices = compiled.devices.filter(device => device.truncateTransientStep !== undefined);
    this.acceptingDevices = compiled.devices.filter(device => device.acceptTransientStep !== undefined);
    this.chargeCurrentDevices = compiled.devices.filter(device => (
      device.integratesTransientCharge && device.stampAcceptedChargeCurrent !== undefined
    ));
    // ngspice-47 has no node-voltage LTE, only CKTtrunc (#638, #621): the
    // node check remains only on nodes of devices without a DEVtrunc port.
    this.reactiveTruncation = new LinearReactiveTruncation(compiled.devices, compiled.nodeCount);
    this.lteExemptNodes = chargeTruncatedNodes(compiled.nodeCount, compiled.devices);
    for (const device of compiled.devices) {
      for (const node of device.algebraicNodes ?? []) this.lteExemptNodes[node] = 1;
    }
    this.dt = Math.min(config.timestep, config.maxTimestep);
    this.prevDt = this.dt;
    this.prevPrevDt = this.dt;
    this.integrationMethod = options.integrationMethod;
    this.events = compiled.devices.find(device => device.eventDriven !== undefined)?.eventDriven;

    this.assembler = this.createAssembler();

    if (config.initialSolution) {
      // Caller already computed DC — skip internal DC and seed directly.
      this.assembler.solution.set(config.initialSolution);
    } else {
      this.initDC();
    }
    this.acceptInitialPoint();

    this.breakpoints = this.collectBreakpoints();
    this.progress = new TransientProgressMonitor(config.maxTimestep);
  }

  get simTime(): number { return this.time; }
  get stopTime(): number | undefined { return this.config.stopTime; }
  get isDone(): boolean {
    return this.config.stopTime !== undefined && this.time >= this.config.stopTime - MIN_TIMESTEP;
  }
  get convergence(): ConvergenceTelemetry {
    return snapshotConvergenceTelemetry(this.convergenceTelemetry);
  }

  advance(): TransientStep {
    return this.buildStep(this.advanceSolution());
  }

  /**
   * Advance one accepted timepoint and return its solution vector without
   * building the name-keyed {@link TransientStep} Maps. Internal fast path for
   * `solveTransient`; the returned array is only valid until the next call.
   */
  advanceSolution(): Float64Array {
    if (this.disposed) throw new InvalidCircuitError('TransientSim has been disposed');

    const prevSol = new Float64Array(this.assembler.solution);
    let discontinuityRecoveryAttempted = false;
    this.selectStep();
    this.processEvents();

    while (true) {
      // Guard against dt=0 when caller advance()s past a done simulation.
      // stopTime clamping below can drive dt to 0 exactly at the boundary;
      // once past stopTime we just continue at the configured timestep.
      if (this.dt <= 0) {
        this.dt = Math.min(this.config.timestep, this.config.maxTimestep);
      }

      let nextTime = this.time + this.dt;
      if (this.config.stopTime !== undefined && this.time < this.config.stopTime) {
        nextTime = Math.min(nextTime, this.config.stopTime);
      }
      const nextBreak = this.breakpoints.peek();
      if (nextBreak !== undefined && nextTime >= nextBreak - MIN_BREAK) {
        // Snap to the breakpoint — either we'd cross it, or we're within
        // tolerance and would leave a microscopic leftover step on the
        // other side.
        nextTime = nextBreak;
      }
      // ngspice dctran.c integrates with CKTdelta and advances CKTtime by it.
      // `(time + dt) - time` is not always `dt` in floating point; using the
      // difference drifts accepted times by ulps from ngspice's, which moves
      // TXL/CPL `(int)(CKTtime * 1e12)` history points by 1 ps (#708). Only a
      // stop-time clamp or breakpoint snap integrates the actual gap.
      const actualDt = nextTime === this.time + this.dt ? this.dt : nextTime - this.time;
      // ngspice EVTbackup: a retried step drops the events processed past its end.
      this.events?.backup(nextTime);

      this.assembler.solution.set(prevSol);
      const result = attemptStep(
        {
          compiled: this.compiled, assembler: this.assembler, options: this.options,
          guard: this.config.guard,
        },
        {
          dt: actualDt,
          time: this.config.operatingPoint ? 0 : nextTime,
          prevSolution: prevSol,
          prevB: this.orderOnePending ? undefined : this.prevB,
          gmin: this.options.gmin,
          voltageLimit: NR_VOLTAGE_LIMIT,
          prevPrevSolution: this.secondPrevSol,
          prevDt: this.secondPrevSol ? this.prevDt : undefined,
          integrationMethod: this.integrationMethod,
          staticCurrentHistory: this.useStaticCurrentHistory,
        },
      );

      this.convergenceTelemetry.transient.newtonIterations += result.iterations;

      if (!result.ok) {
        // ngspice dctran.c convention: aggressive dt cut, no per-step GMIN
        // stepping. Committing GMIN-distorted solutions breaks reactive
        // circuits (LC tank, boost, rectifier — see issues #42, #43, #45).
        this.convergenceTelemetry.transient.rejectedSteps++;
        this.convergenceTelemetry.transient.nrRetries++;
        if (
          this.integrationMethod === 'trapezoidal'
          && ++this.trapNrRetries === (this.useDampedInductiveRecovery ? 1 : MAX_TRAP_NR_RETRIES)
        ) {
          // A trap/Newton grow-fail-cut cycle can hold dt near the numerical
          // floor indefinitely while one-shot result arrays keep growing.
          // Nonlinear inductive systems can enter that cycle on the first trap
          // failure, so move them immediately to damped Backward Euler. Other
          // systems retain the established sustained-retry Gear-2 fallback.
          // Drop history and retry this timepoint without a timestep cut.
          // This is a global convergence safeguard, not output decimation.
          this.integrationMethod = this.useDampedInductiveRecovery ? 'euler' : 'gear2';
          this.prevB = undefined;
          this.secondPrevSol = undefined;
          this.assembler.solution.set(prevSol);
          this.config.onReject?.({ reason: 'newton', time: nextTime, timestep: actualDt, nextTimestep: this.dt });
          continue;
        }
        this.dt = this.dt / DT_CUT_FACTOR;
        // ngspice dctran.c: a non-converged step is retried at CKTorder = 1.
        this.orderOnePending = true;
        if (this.dt < MIN_TIMESTEP) {
          if (result.oscillated && !discontinuityRecoveryAttempted) {
            // A regenerative transition can create an implicit breakpoint
            // that no independent source reports. Shrinking dt follows the
            // disappearing branch into the femtosecond floor. Drop higher-
            // order history as at an explicit breakpoint, but keep the first
            // Backward-Euler recovery step local to the last accepted point.
            // Subsequent steps retain history and resume LTE-controlled growth.
            this.prevB = undefined;
            this.secondPrevSol = undefined;
            const recoveryCeiling = Math.min(this.config.timestep, this.config.maxTimestep);
            this.dt = Math.max(recoveryCeiling / IMPLICIT_BREAK_DT_CUT, MIN_TIMESTEP);
            discontinuityRecoveryAttempted = true;
            this.config.onReject?.({ reason: 'newton', time: nextTime, timestep: actualDt, nextTimestep: this.dt });
            continue;
          }
          this.convergenceTelemetry.transient.failure = 'dt-floor';
          this.config.onReject?.({ reason: 'newton', time: nextTime, timestep: actualDt, nextTimestep: this.dt });
          throw new TimestepTooSmallError(
            this.time, this.dt, snapshotConvergenceTelemetry(this.convergenceTelemetry),
          );
        }
        this.assembler.solution.set(prevSol);
        this.config.onReject?.({ reason: 'newton', time: nextTime, timestep: actualDt, nextTimestep: this.dt });
        continue;
      }

      const sol = result.solution;
      const integration = this.stepIntegration(actualDt);
      const lteVerified = this.lteChecked(actualDt);
      const lteRatio = this.checkLTE(sol, prevSol, actualDt);
      const chargeBound = this.chargeTruncationTimestep(actualDt, integration);
      if (lteRatio > 1 || chargeBound < CHARGE_LTE_ACCEPT_FRACTION * actualDt) {
        const factor = lteRatio > 1 ? Math.max(0.25, 0.9 / Math.sqrt(lteRatio)) : 1;
        this.dt = Math.max(Math.min(actualDt * factor, chargeBound), MIN_TIMESTEP);
        this.assembler.solution.set(prevSol);
        this.lteRejectCount++;
        this.progress.lteRejected();
        this.convergenceTelemetry.transient.rejectedSteps++;
        this.convergenceTelemetry.transient.lteRetries++;
        this.config.onReject?.({
          reason: lteRatio > 1
            ? (chargeBound < CHARGE_LTE_ACCEPT_FRACTION * actualDt ? 'voltage-and-charge-lte' : 'voltage-lte')
            : 'charge-lte',
          time: nextTime, timestep: actualDt, nextTimestep: this.dt,
          voltageRatio: lteRatio, chargeBound,
        });
        continue;
      }
      this.lteRejectCount = 0;
      const firstStep = this.firstStepPending;

      // Device-owned histories must observe only committed solutions. In
      // particular, NR/LTE retries and the stampPrevB restamp below are not
      // accepted timepoints and must remain side-effect free.
      // dctran.c: EVTcall_hybrids after the truncation check (not on the
      // first step, which skips it), then EVTaccept.
      if (this.events) {
        this.acceptingTime = nextTime;
        const ctx = this.assembler.getStampContext();
        for (const device of this.acceptingDevices) device.prepareTransientStep?.(ctx);
      }
      const retry = this.events?.prepareStep(nextTime, !firstStep);
      if (retry !== undefined) {
        this.dt = retry - this.time;
        this.assembler.solution.set(prevSol);
        this.convergenceTelemetry.transient.rejectedSteps++;
        this.processEvents();
        this.config.onReject?.({ reason: 'breakpoint', time: nextTime, timestep: actualDt, nextTimestep: this.dt });
        continue;
      }
      const next = this.orderAfterAcceptedStep(actualDt, integration, chargeBound);
      this.acceptTransientStep(nextTime, integration);
      this.events?.acceptStep(nextTime, !firstStep);
      // Update trapezoidal history.
      if (this.integrationMethod === 'trapezoidal') {
        this.stampPrevB();
      }
      // A UIC seed is no predictor point: the next step gets no LTE check and,
      // under Gear-2, integrates at order 1, as after a breakpoint.
      this.secondPrevSol = this.startsFromUICSeed ? undefined : prevSol;
      this.startsFromUICSeed = false;
      this.prevPrevDt = this.prevDt;
      this.prevDt = actualDt;
      this.time = nextTime;
      this.orderOnePending = next.orderOne;
      this.convergenceTelemetry.transient.acceptedSteps++;
      const minimum = this.convergenceTelemetry.transient.minimumAcceptedTimestep;
      this.convergenceTelemetry.transient.minimumAcceptedTimestep = minimum === null
        ? actualDt
        : Math.min(minimum, actualDt);

      if (this.breakpoints.isNear(this.time)) {
        this.breakpoints.pop();
        this.justCrossedBreakpoint = true;
      }

      const progress = this.progress.accept(this.time, actualDt, lteVerified);
      if (progress === 'stalled') {
        this.convergenceTelemetry.transient.failure = 'lte-cascade';
        const error = new ConvergenceError(
          `Transient step loop stopped advancing: dt=${actualDt}`
            + ' after a window of accepted steps without timestep growth',
          this.time, [], sol, prevSol, 'lte-cascade', actualDt, this.options.gmin,
        );
        error.convergence = snapshotConvergenceTelemetry(this.convergenceTelemetry);
        throw error;
      }
      if (progress === 'reduce-order') {
        // LTE could not be satisfied at any dt down to the floor. Restart
        // integration at order 1 from this accepted point, exactly as after
        // an explicit breakpoint but without cutting dt.
        this.orderOnePending = true;
        this.secondPrevSol = undefined;
      }

      const growFactor = lteRatio > 0.001 ? Math.min(2.0, 0.9 / Math.sqrt(lteRatio)) : 2.0;
      // Guard against `stopTime - this.time === 0` at the boundary: that would
      // set dt=0, which causes division-by-zero in companion stamps if the
      // caller keeps calling advance() past isDone=true.
      const remaining = this.config.stopTime !== undefined && this.config.stopTime > this.time
        ? this.config.stopTime - this.time
        : Infinity;
      // ngspice CKTtrunc: the next step is at most the charge truncation bound.
      // After a breakpoint the grown step is limited by CKTsaveDelta in
      // selectStep (#608), not cut from the snapped step.
      const dtBase = Math.min(actualDt * growFactor, next.bound);
      this.dt = Math.min(dtBase, this.config.maxTimestep, remaining);

      return sol;
    }
  }

  /**
   * ngspice dctran.c step selection at `resume:` (XSPICE build, as ngspice-47
   * is shipped), applied once per accepted point; NR and truncation retries
   * only shrink the selected step.
   *
   * At a breakpoint: order 1 and `delta = MIN(delta, .1 * MIN(CKTsaveDelta,
   * next breakpoint - this one))`. Then, towards the next breakpoint (the
   * final time is one in ngspice): cut the step to land on it, or halve the
   * remaining gap when `CKTtime + 1.9 * CKTdelta` would cross it, saving the
   * step before either cut as CKTsaveDelta.
   */
  private selectStep(): void {
    this.dt = Math.min(this.dt, this.config.maxTimestep);
    if (this.justCrossedBreakpoint) {
      // Drop 2nd-order history: both prevB (trap) and secondPrevSol (gear2)
      // undefined makes the companion fall back to BE for one step.
      this.secondPrevSol = undefined;
      this.prevB = undefined;
      this.lteRejectCount = 0;
      const gap = this.nextBreakTarget() - this.time;
      this.dt = Math.max(Math.min(this.dt, START_BREAK_GAP_FRACTION * Math.min(this.saveDelta, gap)), MIN_TIMESTEP);
      this.justCrossedBreakpoint = false;
    }
    const target = this.nextBreakTarget();
    if (!Number.isFinite(target) || target <= this.time) return;
    const stop = this.config.stopTime;
    if (this.time + this.dt > target) {
      this.saveDelta = this.dt;
      this.dt = target - this.time;
    } else if (
      !(stop !== undefined && almostEqualUlps(this.time + this.dt, stop, FINAL_TIME_ULPS))
      && this.time + BREAK_EQUALISE_FACTOR * this.dt > target
    ) {
      this.saveDelta = this.dt;
      this.dt = (target - this.time) / 2;
    }
  }

  /**
   * dctran.c event solution before a step: process every event due at or
   * before the step's end; when an instance set a breakpoint inside the
   * step (a dac_bridge input change), cut the step to it, and process only
   * the events up to the new end.
   */
  private processEvents(): void {
    const events = this.events;
    if (!events) return;
    for (;;) {
      const eventTime = events.nextEventTime();
      if (!(eventTime <= this.time + this.dt)) return;
      events.processEvents(eventTime, this.time);
      const breakpoint = this.nextBreakTarget();
      if (
        breakpoint < this.time + this.dt
        && breakpoint > this.time + MIN_BREAK
        && breakpoint >= eventTime
      ) {
        this.saveDelta = this.dt;
        this.dt = breakpoint - this.time;
      }
    }
  }

  /** ngspice CKTbreaks[0] after the passed ones are cleared: next breakpoint or the final time. */
  private nextBreakTarget(): number {
    const next = this.breakpoints.peek() ?? Infinity;
    const stop = this.config.stopTime;
    return stop !== undefined && stop > this.time ? Math.min(next, stop) : next;
  }

  advanceUntil(targetTime: number): TransientStep[] {
    const steps: TransientStep[] = [];
    while (this.time < targetTime) {
      steps.push(this.advance());
      if (this.isDone) break;
    }
    return steps;
  }

  reset(): void {
    if (this.disposed) throw new InvalidCircuitError('TransientSim has been disposed');
    for (const device of this.compiled.devices) device.resetTransient?.();
    this.reactiveTruncation.reset();
    this.assembler = this.createAssembler();
    this.time = 0;
    this.dt = Math.min(this.config.timestep, this.config.maxTimestep);
    this.prevDt = this.dt;
    this.prevPrevDt = this.dt;
    this.integrationMethod = this.options.integrationMethod;
    this.trapNrRetries = 0;
    this.prevB = undefined;
    this.secondPrevSol = undefined;
    this.lteRejectCount = 0;
    this.justCrossedBreakpoint = false;
    this.progress.reset();
    resetConvergenceTelemetry(this.convergenceTelemetry);
    if (this.config.initialSolution) {
      this.assembler.solution.set(this.config.initialSolution);
    } else {
      this.initDC();
    }
    this.acceptInitialPoint();
    this.breakpoints = this.collectBreakpoints();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Returns the current state at t=0 (or whatever the current simTime is) as a TransientStep. */
  peekInitialStep(): TransientStep {
    return this.buildStep(this.assembler.solution);
  }

  /** The solution vector at the current simTime (valid until the next advance). */
  currentSolution(): Float64Array {
    return this.assembler.solution;
  }

  /** Test-only accessor; returns the remaining breakpoints in order. */
  breakpointTimes(): readonly number[] {
    return this.breakpoints.remaining();
  }

  /**
   * Collect breakpoints after t=0 and size the first step. As in ngspice
   * dctran.c, t=0 is always a breakpoint (#532): the first step starts at
   * MIN(TSTOP/100, TSTEP)/10 capped by TMAX, is limited to 0.1 x MIN(TSTOP/50,
   * gap to the next breakpoint), is cut by POST_BREAK_DT_CUT for the initial
   * timepoint and integrates at order 1, so it cannot skip a large part of a
   * source period and its first-order error stays local.
   */
  private collectBreakpoints(): BreakpointQueue {
    const stop = this.config.stopTime;
    this.orderOnePending = false;
    this.firstStepPending = false;
    // ngspice dctran.c: CKTsaveDelta = CKTfinalTime / 50 before the first step.
    this.saveDelta = stop === undefined ? Infinity : stop / SAVE_DELTA_STOP_DIVISOR;
    const times: number[] = [];
    // ngspice-47 dctran.c inserts RAMPTIME even in non-XSPICE_EXP builds,
    // where independent V/I sources are not ramped. capacitoric/inductoric
    // use the ramp factor for their initial conditions.
    if (this.options.rampTime > 0 && (stop === undefined || this.options.rampTime <= stop)) {
      times.push(this.options.rampTime);
    }
    if (stop === undefined) return new BreakpointQueue(times, MIN_BREAK);
    for (const d of this.compiled.devices) {
      if (!this.config.operatingPoint && d.getBreakpoints) times.push(...d.getBreakpoints(stop));
    }
    const queue = new BreakpointQueue(times, MIN_BREAK);
    this.orderOnePending = true;
    this.firstStepPending = true;
    const { timestep, maxTimestep } = this.config;
    const firstGap = queue.peek() ?? stop;
    const initial = Math.min(Math.min(stop / INITIAL_STEP_STOP_DIVISOR, timestep) / INITIAL_STEP_DIVISOR, maxTimestep);
    const limited = Math.min(initial, START_BREAK_GAP_FRACTION * Math.min(this.saveDelta, firstGap));
    // No femtosecond floor here: ngspice-47 (XSPICE build) takes this step as
    // computed. Clamped to MIN_TIMESTEP, a sub-1e-13 TSTEP took Backward
    // Euler steps 10x ngspice's, each damping an LC tank (#742).
    this.dt = Math.max(limited / POST_BREAK_DT_CUT, 2 * DELMIN_FRACTION * maxTimestep);
    // ngspice dctran.c, at the first timepoint with UIC: "set a breakpoint to
    // reduce ringing of current in devices" at TSTEP, after the first step
    // was limited by the next breakpoint (#742).
    if (this.config.useInitialConditions) queue.insert(timestep, 0);
    return queue;
  }

  private createAssembler(): MNAAssembler {
    return new MNAAssembler(this.compiled.nodeCount, this.compiled.branchCount, {
      deviceGmin: this.options.deviceGmin,
      useDcSourceValue: this.config.operatingPoint?.useDcSourceValue,
      variables: createMatrixVariableIdentities(
        this.compiled.nodeNames,
        this.compiled.branchNames,
      ),
    });
  }

  /**
   * Commit the t=0 point. A DC operating point is a solution, so it seeds the
   * trapezoidal history; a UIC seed is not (#560): its KCL residual would
   * enter that history as a reactive current (1000 A through the 1 nF
   * capacitor of the #560 deck, +4897 V after one 10 ns trapezoidal step),
   * so the first step integrates at order 1 without it.
   */
  private acceptInitialPoint(): void {
    if (this.events && this.config.useInitialConditions) {
      // ngspice-47 dctran.c:223-234 still calls EVTop with MODEUIC.
      // evtop.c:104-157 alternates event initialization and analog loads;
      // niiter.c:41-46 loads the UIC seed once, without a Newton solve.
      // Initialize afresh even on reset or after an earlier .op analysis.
      this.events.operatingPoint(() => {
        // This is a load of the supplied initial state, not a Newton
        // iteration: do not limit inputs against a previous run's solution.
        this.acceptTransientStep(this.time);
      });
    }
    if (this.config.operatingPoint) {
      // OPtran copies the last DC load's state0 into state1 before INITTRAN.
      const ctx = this.assembler.getStampContext();
      for (const device of this.acceptingDevices) {
        if (device instanceof MOS2) device.initializeTransientOperatingPoint(ctx, !this.config.operatingPoint.useDcSourceValue);
        else device.acceptTransientStep!(ctx, this.breakpointSink);
      }
      this.reactiveTruncation.accept(this.assembler.solution, undefined);
    } else {
      this.acceptTransientStep(this.time);
    }
    if (this.events) {
      this.events.beginTransient(time => this.breakpoints?.insert(time, this.time), MIN_BREAK);
    }
    this.startsFromUICSeed = this.config.useInitialConditions === true;
    if (this.startsFromUICSeed) this.prevB = undefined;
    else this.stampPrevB();
  }

  private stampPrevB(): void {
    if (this.integrationMethod !== 'trapezoidal') return;
    this.assembler.clear();
    // A separate stamp-pass kind: this restamp's device sequence differs from
    // the companion build's, so they keep separate slot caches.
    const ctx = this.assembler.getStampContext(HISTORY_STAMP_PASS);
    stampStaticDevices(this.assembler, this.compiled.devices, ctx);
    // Charge currents accepted at x(n) belong to the static side of the KCL
    // that defines the trapezoidal history of the linear reactive elements.
    for (const d of this.chargeCurrentDevices) d.stampAcceptedChargeCurrent!(ctx);
    const current = this.historyWorkspace ??= new Float64Array(this.assembler.systemSize);
    if (!this.useStaticCurrentHistory) {
      current.set(this.assembler.b);
      this.prevB = current;
      return;
    }
    current.fill(0);
    if (this.assembler.isFastPath) {
      const { colPtr, rowIdx, gValues } = this.assembler;
      for (let column = 0; column < this.assembler.systemSize; column++) {
        const voltage = this.assembler.solution[column];
        if (voltage === 0) continue;
        for (let position = colPtr[column]; position < colPtr[column + 1]; position++) {
          current[rowIdx[position]] += gValues[position] * voltage;
        }
      }
    } else {
      for (let row = 0; row < this.assembler.systemSize; row++) {
        for (const [column, value] of this.assembler.G.getRow(row)) {
          current[row] += value * this.assembler.solution[column];
        }
      }
    }
    for (let row = 0; row < current.length; row++) current[row] -= this.assembler.b[row];
    for (let node = 0; node < this.compiled.nodeCount; node++) {
      current[node] += this.options.gmin * this.assembler.solution[node];
    }
    this.prevB = current;
  }

  /**
   * Commit an accepted point to device state. `integration` is the rule of
   * the step that reached it; absent for the initial point.
   */
  private acceptTransientStep(time: number, integration?: ChargeIntegration): void {
    const ctx = this.assembler.getStampContext();
    this.acceptingTime = time;
    ctx.initialUIC = integration === undefined && this.config.useInitialConditions === true;
    try {
      for (const device of this.acceptingDevices) device.acceptTransientStep!(ctx, this.breakpointSink);
    } finally {
      ctx.initialUIC = undefined;
    }
    this.reactiveTruncation.accept(this.assembler.solution, integration);
  }

  /**
   * The integration rule the companion applies to a step from the current
   * state (buildCompanionSystem): order 1 without trapezoidal or Gear-2 history.
   */
  private stepIntegration(dt: number): ChargeIntegration {
    if (this.integrationMethod === 'trapezoidal' && !this.orderOnePending && this.prevB !== undefined) {
      return { method: 'trapezoidal', dt, xmu: this.options.xmu };
    }
    if (this.integrationMethod === 'gear2' && this.secondPrevSol !== undefined) {
      return { method: 'gear2', dt, prevDt: this.prevDt };
    }
    return { method: 'euler', dt };
  }

  private initDC(): void {
    const { assembler: dcAsm } = solveDCOperatingPoint(
      this.compiled, this.options, undefined, this.convergenceTelemetry, 'transient',
      this.config.guard,
    );
    this.assembler.solution.set(dcAsm.solution);
  }

  /** Whether {@link checkLTE} will evaluate truncation error for this step. */
  private lteChecked(dt: number): boolean {
    return this.secondPrevSol !== undefined
      && dt > MIN_LTE_TIMESTEP
      && this.lteRejectCount < MAX_LTE_REJECTS_BEFORE_BYPASS;
  }

  private checkLTE(current: Float64Array, previous: Float64Array, dt: number): number {
    if (!this.lteChecked(dt) || !this.secondPrevSol) return 0;
    let maxRatio = 0;
    // 2nd-order methods (trap, gear2) have O(dt³) LTE → larger divider; BE is O(dt²).
    const method = this.integrationMethod;
    const divider = method === 'trapezoidal' || method === 'gear2' ? 3 : 2;
    const { nodeCount } = this.compiled;
    for (let i = 0; i < nodeCount; i++) {
      if (this.lteExemptNodes[i] === 1) continue;
      const slope = (previous[i] - this.secondPrevSol[i]) / this.prevDt;
      const predicted = previous[i] + dt * slope;
      const error = Math.abs(current[i] - predicted) / divider;
      const tol = this.options.trtol * (this.options.vntol + this.options.reltol * Math.abs(current[i]));
      if (tol > 0) {
        const ratio = error / tol;
        if (ratio > maxRatio) maxRatio = ratio;
      }
    }
    return maxRatio;
  }

  /**
   * ngspice dctran.c order control at an accepted point: the bound on the
   * next step and whether that step stays at order 1 (trapezoidal runs).
   *
   * The first timepoint of the run is accepted without CKTtrunc ("no check
   * on first time point"): CKTdelta is kept and the order stays 1. After any
   * other order-1 step CKTtrunc is repeated at order 2; the order is raised
   * only if MIN(2 x CKTdelta, that bound) exceeds 1.05 x CKTdelta, and the
   * next step is that order-2 bound either way. Otherwise the bound is
   * `chargeBound`, the CKTtrunc of the step just taken.
   */
  private orderAfterAcceptedStep(
    dt: number, integration: ChargeIntegration, chargeBound: number,
  ): { bound: number; orderOne: boolean } {
    const trapezoidal = this.integrationMethod === 'trapezoidal';
    if (this.firstStepPending) {
      this.firstStepPending = false;
      return { bound: dt, orderOne: trapezoidal };
    }
    if (!trapezoidal || integration.method !== 'euler') return { bound: chargeBound, orderOne: false };
    const bound = this.chargeTruncationTimestep(dt, integration, 2);
    return { bound, orderOne: Math.min(2 * dt, bound) <= RAISE_ORDER_FRACTION * dt };
  }

  /**
   * ngspice CKTtrunc: the smallest next timestep CKTterr allows on any
   * device charge (DEVtrunc, plus CAPtrunc/INDtrunc on the linear C and L) at the
   * converged trial solution held by the assembler. Infinity when no device
   * bounds the step. Gated like the voltage LTE so the reject-bypass and the
   * femtosecond floor still terminate stiff shrink loops. `order` evaluates
   * CKTterr at that order instead of the step's own (the order-raise trial).
   */
  private chargeTruncationTimestep(dt: number, integration: ChargeIntegration, order?: 2): number {
    if (
      (this.truncatingDevices.length === 0 && this.reactiveTruncation.isEmpty)
      || dt <= MIN_LTE_TIMESTEP
      || this.lteRejectCount >= MAX_LTE_REJECTS_BEFORE_BYPASS
    ) {
      return Infinity;
    }
    const ctx = this.assembler.getStampContext();
    const { reltol, abstol, chgtol, trtol } = this.options;
    const truncation = {
      deltas: [dt, this.prevDt, this.prevPrevDt] as const, reltol, abstol, chgtol, trtol, order,
    };
    let bound = this.reactiveTruncation.timestep(this.assembler.solution, integration, truncation);
    for (const device of this.truncatingDevices) {
      bound = Math.min(bound, device.truncateTransientStep!(ctx, truncation));
    }
    return bound;
  }

  private buildStep(solution: Float64Array): TransientStep {
    const { nodeNames, branchNames, nodeCount, nodeIndexMap } = this.compiled;
    const voltages = new Map<string, number>();
    for (const name of nodeNames) voltages.set(name, solution[nodeIndexMap.get(name)!]);
    const currents = new Map<string, number>();
    for (let i = 0; i < branchNames.length; i++) currents.set(branchNames[i], solution[nodeCount + i]);
    return { time: this.time, voltages, currents };
  }
}

const ulpFloats = new Float64Array(2);
const ulpInts = new BigInt64Array(ulpFloats.buffer);

/** ngspice AlmostEqualUlps: same sign and at most `maxUlps` representable doubles apart. */
function almostEqualUlps(a: number, b: number, maxUlps: number): boolean {
  if (a === b) return true;
  ulpFloats[0] = a;
  ulpFloats[1] = b;
  const x = ulpInts[0]!;
  const y = ulpInts[1]!;
  if ((x < 0n) !== (y < 0n)) return false;
  return (x > y ? x - y : y - x) <= BigInt(maxUlps);
}

/**
 * Internal constructor used by `solveTransient` / `streamTransient` to avoid
 * re-parsing circuits. Exposes `peekInitialStep()` for t=0 inspection.
 */
export function createDriverFromCompiled(
  compiled: CompiledCircuit,
  options: ResolvedOptions,
  config: {
    stopTime: number | undefined;
    timestep: number;
    maxTimestep: number;
    initialSolution?: Float64Array;
    useInitialConditions?: boolean;
    operatingPoint?: { useDcSourceValue: boolean };
    convergence?: ConvergenceTelemetry;
    guard?: ProtocolExecutionGuard;
    onReject?: (rejection: TransientRejection) => void;
  },
): TransientSim & {
  peekInitialStep(): TransientStep;
  currentSolution(): Float64Array;
  advanceSolution(): Float64Array;
} {
  const impl = new TransientSimImpl(compiled, options, {
    stopTime: config.stopTime,
    timestep: config.timestep,
    maxTimestep: config.maxTimestep,
    initialSolution: config.initialSolution,
    useInitialConditions: config.useInitialConditions,
    operatingPoint: config.operatingPoint,
    convergence: config.convergence,
    guard: config.guard,
    onReject: config.onReject,
  });
  return impl;
}
