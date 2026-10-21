import type { ACRHSContribution, DeviceModel, StampContext, TransientBreakpointSink } from './device.js';
import type {
  SourceWaveform, PulseSource, SinSource, PWLSource, ExpSource, SffmSource, AmSource, RFPort,
} from '../types.js';
import { InvalidCircuitError } from '../errors.js';
import { TransientNoiseContext, type NoiseHandle } from './transient-noise.js';

export class VoltageSource implements DeviceModel {
  readonly branches: number[];
  readonly isNonlinear = false;
  private transientTimestep = 0;
  /** Transient TSTOP (ngspice CKTfinalTime), used by SFFM/AM frequency defaults. */
  private transientStopTime: number | undefined;
  /** TRNOISE/TRRANDOM state (ngspice VSRCtrnoise_state/VSRCtrrandom_state). */
  private readonly noise?: NoiseHandle;
  /** Present for noisy sources and accept-time PULSE/PWL breakpoint scheduling. */
  readonly acceptTransientStep?: (ctx: StampContext, breakpoints?: TransientBreakpointSink) => void;
  /**
   * False for PULSE/PWL: their accept hooks only schedule breakpoints,
   * so it must not put its nodes under the node-voltage LTE.
   */
  readonly storesCharge?: boolean;
  /** ngspice accept-time PWL corners (vsrcacct.c). */
  private readonly pwlSchedule?: PwlBreakpointSchedule;
  private readonly pulseSchedule?: PulseBreakpointSchedule;

  /**
   * @param nodes - `[+, -]`, or `[+, -, res]` for an RF port, whose ideal
   *   source sits between the internal `res` node and `-` with `z0` from `+`
   *   to `res` (ngspice-47 vsrcset.c/vsrcload.c RFSPICE).
   * @param noiseContext - shared random stream of the circuit's TRNOISE and
   *   TRRANDOM sources; a private one is created when absent.
   */
  constructor(
    readonly name: string,
    readonly nodes: number[],
    readonly branchIndex: number,
    public waveform: SourceWaveform,
    readonly port?: RFPort,
    noiseContext?: TransientNoiseContext,
  ) {
    this.branches = [branchIndex];
    if (waveform.type === 'trnoise' || waveform.type === 'trrandom') {
      const noise = (noiseContext ?? new TransientNoiseContext()).register('V', name, waveform);
      this.noise = noise;
      this.acceptTransientStep = (ctx, breakpoints) => noise.accept(ctx.time, breakpoints);
    } else if (waveform.type === 'pulse') {
      const schedule = new PulseBreakpointSchedule();
      this.pulseSchedule = schedule;
      this.storesCharge = false;
      this.acceptTransientStep = (ctx, breakpoints) => {
        if (this.waveform.type !== 'pulse') return;
        const next = schedule.next(effectivePulse(this.waveform, this.transientTimestep), ctx.time,
          this.transientStopTime ?? Infinity, this.transientTimestep);
        if (next !== undefined) breakpoints?.schedule(next);
      };
    } else if (waveform.type === 'pwl') {
      const schedule = new PwlBreakpointSchedule(waveform);
      this.pwlSchedule = schedule;
      this.storesCharge = false;
      this.acceptTransientStep = (ctx, breakpoints) => {
        const next = schedule.next(ctx.time, this.transientStopTime ?? Infinity, this.transientTimestep);
        if (next !== undefined) breakpoints?.schedule(next);
      };
    }
  }

  /** The node the ideal source drives: the internal `res` node of an RF port, else `+`. */
  get sourceNode(): number {
    return this.port ? this.nodes[2] : this.nodes[0];
  }

  stamp(ctx: StampContext): void {
    const nMinus = this.nodes[1];
    const nPlus = this.sourceNode;
    const bi = ctx.numNodes + this.branchIndex;
    const voltage = this.getValue(ctx) * ctx.sourceScale;

    if (this.port) {
      const outer = this.nodes[0];
      const g0 = 1 / this.port.z0;
      if (outer >= 0) ctx.stampG(outer, outer, g0);
      ctx.stampG(nPlus, nPlus, g0);
      if (outer >= 0) {
        ctx.stampG(outer, nPlus, -g0);
        ctx.stampG(nPlus, outer, -g0);
      }
    }

    // KCL: branch current enters positive node, leaves negative
    if (nPlus >= 0) ctx.stampG(nPlus, bi, 1);
    if (nMinus >= 0) ctx.stampG(nMinus, bi, -1);

    // Branch equation: V(+) - V(-) = Vs
    if (nPlus >= 0) ctx.stampG(bi, nPlus, 1);
    if (nMinus >= 0) ctx.stampG(bi, nMinus, -1);

    ctx.stampB(bi, voltage);
  }

  getVoltageAtTime(time: number): number {
    const power = this.port?.power;
    if (power) {
      // ngspice-47 vsrctemp.c/vsrcload.c PORT: sqrt(4*pwr*z0) * cos(2*pi*freq*t).
      return Math.sqrt(4 * power.watts * this.port!.z0) * Math.cos(2 * Math.PI * power.frequency * time);
    }
    switch (this.waveform.type) {
      case 'dc':
        return this.waveform.value;
      case 'pulse':
        return evaluatePulse(this.waveform, time, this.transientTimestep);
      case 'sin':
        return evaluateSin(this.waveform, time);
      case 'pwl':
        return evaluatePwl(this.waveform, time);
      case 'exp':
        return evaluateExp(this.waveform, time, this.transientTimestep);
      case 'sffm':
        return evaluateSffm(this.waveform, time, this.transientStopTime);
      case 'am':
        return evaluateAm(this.waveform, time, this.transientStopTime);
      case 'trnoise':
      case 'trrandom':
        // ngspice-47 vsrcload.c adds the DC value when one is given.
        return (this.waveform.dc ?? 0) + this.noise!.value(time);
      case 'ac':
        return this.waveform.dc ?? 0;
    }
  }

  private getValue(ctx: StampContext): number {
    const power = this.port?.power;
    if (power) {
      return ctx.useDcSourceValue && power.dc !== undefined ? power.dc : this.getVoltageAtTime(ctx.time);
    }
    if (ctx.useDcSourceValue && this.waveform.type !== 'dc' && this.waveform.dc !== undefined) {
      return this.waveform.dc;
    }
    return this.getVoltageAtTime(ctx.time);
  }

  getACExcitation(): ACRHSContribution | null {
    const excitation = this.waveform.type === 'ac' ? this.waveform : this.waveform.ac;
    if (excitation) {
      return {
        kind: 'branch',
        magnitude: excitation.magnitude,
        phase: excitation.phase,
        branch: this.branchIndex,
      };
    }
    return null;
  }

  setParameter(value: number): void {
    if (this.port?.power) {
      throw new InvalidCircuitError(`RF power port '${this.name}' has no sweepable DC value`);
    }
    if (this.waveform.type === 'dc') {
      this.waveform.value = value;
      return;
    }
    if (this.waveform.type === 'ac') {
      this.waveform.dc = value;
      return;
    }
    throw new InvalidCircuitError(`Voltage source '${this.name}' has no sweepable DC value`);
  }

  getParameter(): number {
    if (this.waveform.type === 'dc') return this.waveform.value;
    if (this.waveform.type === 'ac') return this.waveform.dc ?? 0;
    throw new InvalidCircuitError(`Voltage source '${this.name}' has no sweepable DC value`);
  }

  setTransientTimestep(timestep: number, stopTime?: number): void {
    requireStopTimeForDefaults(this.name, this.waveform, stopTime);
    this.transientTimestep = timestep;
    this.transientStopTime = stopTime;
  }

  getBreakpoints(stopTime: number): number[] {
    if (this.waveform.type === 'sin') {
      const delay = this.waveform.delay ?? 0;
      return delay > 0 && delay <= stopTime ? [delay] : [];
    }
    if (this.waveform.type === 'pulse') {
      return initialPulseBreakpoints(effectivePulse(this.waveform, this.transientTimestep), stopTime, this.transientTimestep);
    }
    if (this.waveform.type === 'pwl') {
      return pwlBreakpoints(this.waveform, stopTime, this.transientTimestep);
    }
    if (this.noise) return this.noise.breakpoints(stopTime);
    return [];
  }

  resetTransient(): void {
    this.noise?.resetTransient();
    this.pwlSchedule?.reset();
    this.pulseSchedule?.reset();
  }
}

/**
 * Return all times in [0, stopTime] at which a PULSE waveform has a
 * derivative discontinuity: rising-edge start, rising-edge end, falling-edge
 * start, falling-edge end, repeated each period. A corner at t=0 is kept: the
 * DC operating point carries no slope, so the transient driver integrates the
 * first step at order 1 when a waveform kinks at the start. Negative times
 * are filtered.
 *
 * Period offsets are computed as `delay + n * period` rather than an additive
 * accumulator so that breakpoints at high `n` land exactly on their analytic
 * values (no FP drift).
 *
 * A PULSE without a usable PER (omitted, so `Infinity`, or <= 0) is a single
 * pulse, exactly as {@link evaluatePulse} evaluates it; its corners are still
 * breakpoints. (`0 * Infinity` is NaN, which used to drop every corner of an
 * omitted-PER pulse, #469.)
 *
 * A positive NP (`pulses`) ends the train after NP periods, as in ngspice.
 */
export function pulseBreakpoints(p: PulseSource, stopTime: number): number[] {
  const { delay, rise, width, fall, period } = p;
  const result: number[] = [];
  const periodic = Number.isFinite(period) && period > 0;
  const limit = pulseTrainEnd(p);
  for (let n = 0; n === 0 || periodic; n++) {
    const periodStart = n === 0 ? delay : delay + n * period;
    if (!(periodStart < stopTime)) break;
    const corners = [
      periodStart,                       // rising-edge start
      periodStart + rise,                // rising-edge end
      periodStart + rise + width,        // falling-edge start
      periodStart + rise + width + fall, // falling-edge end
    ];
    const offsets = [0, rise, rise + width, rise + width + fall];
    for (let corner = 0; corner < corners.length; corner++) {
      const t = corners[corner];
      if (t >= 0 && t <= stopTime) result.push(t);
      // ngspice vsrcacct.c stops scheduling once TIME-TD > NP*PER; the last
      // evaluation at or before that point still queues the next corner.
      if (n * period + offsets[corner] > limit) return result;
    }
  }
  return result;
}

/** ngspice-47 vsrcacct.c:99-150 / isrcacct.c: accept-time PULSE schedule.
 * Keep the exact TIME-TD, period-fold, TIME+wait arithmetic: replacing it
 * with precomputed TD+n*PER corners changes the ADC sampling grid (#1185).
 */
export class PulseBreakpointSchedule {
  private breakTime = -1;

  reset(): void {
    this.breakTime = -1;
  }

  next(p: PulseSource, time: number, stopTime: number, timestep: number): number | undefined {
    if (time < this.breakTime) return undefined;
    let local = time - p.delay;
    if (local > pulseTrainEnd(p)) return undefined;
    const period = Number.isFinite(p.period) && p.period > 0 ? p.period : stopTime;
    if (local >= period) local -= period * Math.floor(local / period);
    const maxStep = Math.min(timestep > 0 ? timestep : Infinity, stopTime / 50);
    const minBreak = Number.isFinite(maxStep) ? 1e-10 * maxStep : 0;
    const after = local + minBreak;
    const corner = after < 0 ? 0 : after < p.rise ? p.rise
      : after < p.rise + p.width ? p.rise + p.width
      : after < p.rise + p.width + p.fall ? p.rise + p.width + p.fall : period;
    const breakpoint = time + (corner - local);
    this.breakTime = breakpoint - minBreak;
    return Number.isFinite(breakpoint) ? breakpoint : undefined;
  }
}

/** Seed only the next corner; all subsequent corners are requested on accept. */
export function initialPulseBreakpoints(p: PulseSource, stopTime: number, timestep: number): number[] {
  const next = new PulseBreakpointSchedule().next(p, 0, stopTime, timestep);
  const result = p.delay === 0 ? [0] : [];
  if (next !== undefined && next >= 0 && next <= stopTime) result.push(next);
  return result;
}

/**
 * Time after the delay at which an NP-limited pulse train stops (ngspice
 * `tmax = NP * PER`), or `Infinity` when the train is unlimited. NP only
 * applies to a positive, finite PER; an aperiodic PULSE is a single pulse.
 */
function pulseTrainEnd(p: PulseSource): number {
  const { pulses, period } = p;
  if (pulses === undefined || !(pulses > 0)) return Infinity;
  if (!(Number.isFinite(period) && period > 0)) return Infinity;
  return pulses * period;
}

/**
 * The first PWL corner ngspice requests as a breakpoint, if within
 * [0, stopTime]. Later corners are scheduled on accept
 * ({@link PwlBreakpointSchedule}), as ngspice-47 vsrcacct.c does.
 */
export function pwlBreakpoints(pwl: PWLSource, stopTime: number, transientTimestep = 0): number[] {
  const first = new PwlBreakpointSchedule(pwl).next(0, stopTime, transientTimestep);
  return first !== undefined && first <= stopTime ? [first] : [];
}

/**
 * ngspice-47 vsrcacct.c/isrcacct.c PWL breakpoints. On each accepted time
 * `T` at or past the pending break, the source maps `T - TD` into the
 * (repeating) waveform and requests the next corner at `(T + corner) - mapped`.
 * That floating-point chain, not `corner + TD + n * period`, decides on which
 * side of a repeat's wrap-around discontinuity ngspice samples, and even
 * without TD=/R= it can put the breakpoint one ulp off the corner, where the
 * step then lands, so spice-ts reproduces it for every PWL. `minBreak` is ngspice's CKTminBreak, 10 * CKTdelmin =
 * 1e-10 * CKTmaxStep in an XSPICE build, with the default CKTmaxStep
 * `min(TSTEP, TSTOP / 50)`.
 */
export class PwlBreakpointSchedule {
  /** ngspice VSRCbreak_time, -1 before the first accept (vsrcset.c). */
  private breakTime = -1;

  constructor(private readonly pwl: PWLSource) {}

  reset(): void {
    this.breakTime = -1;
  }

  /** Accept `time`; return the breakpoint ngspice would request, if any. */
  next(time: number, stopTime: number, transientTimestep: number): number | undefined {
    if (time < this.breakTime) return undefined;
    const mapped = pwlLocalTime(this.pwl, time);
    if (mapped === undefined) {
      this.breakTime = Infinity;
      return undefined;
    }
    const maxStep = Math.min(transientTimestep > 0 ? transientTimestep : Infinity, stopTime / 50);
    // An open-ended run without TSTEP has no CKTmaxStep; only rounding is absorbed then.
    const minBreak = Number.isFinite(maxStep) ? 1e-10 * maxStep : 0;
    const after = mapped + minBreak;
    const corner = this.pwl.points.find(point => point.time > after);
    if (!corner) return undefined;
    const breakpoint = time + corner.time - mapped;
    this.breakTime = breakpoint - minBreak;
    return breakpoint;
  }
}

/**
 * Waveform-local time of a PWL source at circuit time `time`: shifted by
 * `TD=` and, past the last point with `R=`, folded back into the repeated
 * section (ngspice-47 vsrcload.c/vsrcacct.c). Undefined past the last point
 * of a non-repeating waveform.
 */
function pwlLocalTime(pwl: PWLSource, time: number): number | undefined {
  const { points } = pwl;
  time -= pwl.delay ?? 0;
  const end = points[points.length - 1].time;
  if (time > end) {
    const period = end - (pwl.repeat ?? end);
    // A non-positive period (no R=, or one the parser would reject) holds the last value.
    if (pwl.repeat === undefined || !(period > 0)) return undefined;
    time -= pwl.repeat;
    time -= period * Math.floor(time / period);
    time += pwl.repeat;
  }
  return time;
}

/**
 * Evaluate a PWL waveform with ngspice endpoint and duplicate-time semantics.
 * Values are held outside the declared range. At equal-time points, the final
 * value at that time wins, which represents an instantaneous discontinuity.
 * `TD=` shifts the waveform; `R=` repeats it from the repeat point once time
 * passes the last point (ngspice-47 vsrcload.c/isrcload.c PWL).
 */
export function evaluatePwl(pwl: PWLSource, time: number): number {
  const { points } = pwl;
  const local = pwlLocalTime(pwl, time);
  if (local === undefined) return points[points.length - 1].value;
  time = local;
  if (time < points[0].time) return points[0].value;

  let left = points[0];
  for (let i = 1; i < points.length; i++) {
    const right = points[i];
    if (time < right.time) {
      const fraction = (time - left.time) / (right.time - left.time);
      return left.value + (right.value - left.value) * fraction;
    }
    left = right;
  }
  return left.value;
}

/**
 * Resolve ngspice's zero-edge rule: a PULSE TR or TF of zero uses the
 * transient TSTEP. Without a transient timestep (`0`) the edge stays ideal.
 */
export function effectivePulse(p: PulseSource, transientTimestep: number): PulseSource {
  if (transientTimestep <= 0 || (p.rise !== 0 && p.fall !== 0)) return p;
  return {
    ...p,
    rise: p.rise === 0 ? transientTimestep : p.rise,
    fall: p.fall === 0 ? transientTimestep : p.fall,
  };
}

/**
 * Evaluate a PULSE waveform with ngspice semantics: V1 at and before the
 * delay, periods repeat from the delay, and a zero TR/TF uses the transient
 * TSTEP (`transientTimestep`, `0` outside transient analysis).
 */
export function evaluatePulse(pulse: PulseSource, time: number, transientTimestep = 0): number {
  const { v1, v2, rise, width, fall, period } = effectivePulse(pulse, transientTimestep);
  let t = time - pulse.delay;
  if (t > pulseTrainEnd(pulse)) return v1;
  if (period > 0 && t > period) t -= period * Math.floor(t / period);
  if (t <= 0 || t >= rise + width + fall) return v1;
  if (t < rise) return v1 + (v2 - v1) * t / rise;
  if (t <= rise + width) return v2;
  return v2 + (v1 - v2) * (t - rise - width) / fall;
}

/** Whether `value` is a given, nonzero coefficient (ngspice's `coeffs[i] != 0.0` defaults test). */
function nonzero(value: number | undefined): value is number {
  return value !== undefined && value !== 0;
}

/**
 * Evaluate EXP with ngspice-47 vsrcload.c/isrcload.c semantics: an omitted or
 * zero TD1, TAU1 or TAU2 is the transient TSTEP and TD2 is TD1 + TSTEP.
 * ngspice-47 registers no breakpoints for EXP (vsrcacct.c), and neither does
 * spice-ts.
 */
export function evaluateExp(e: ExpSource, time: number, transientTimestep = 0): number {
  const td1 = nonzero(e.td1) ? e.td1 : transientTimestep;
  const tau1 = nonzero(e.tau1) ? e.tau1 : transientTimestep;
  const td2 = nonzero(e.td2) ? e.td2 : td1 + transientTimestep;
  const tau2 = nonzero(e.tau2) ? e.tau2 : transientTimestep;
  if (time <= td1) return e.v1;
  const rise = e.v1 + (e.v2 - e.v1) * (1 - Math.exp(-(time - td1) / tau1));
  if (time <= td2) return rise;
  return rise + (e.v1 - e.v2) * (1 - Math.exp(-(time - td2) / tau2));
}

/**
 * Evaluate SFFM with ngspice-47 vsrcload.c/isrcload.c semantics, including
 * the value 0 (not VO) at and before TD, the `5/TSTOP` and `500/TSTOP`
 * frequency defaults and the MDI clamp to [0, FC/FM].
 */
export function evaluateSffm(s: SffmSource, time: number, stopTime: number | undefined): number {
  const t = time - (s.delay ?? 0);
  if (t <= 0) return 0;
  const carrier = s.carrierFrequency ?? 5 / stopTime!;
  const signal = nonzero(s.signalFrequency) ? s.signalFrequency : 500 / stopTime!;
  let index = s.modulationIndex ?? 90;
  if (index > carrier / signal) index = carrier / signal;
  else if (index < 0) index = 0;
  const carrierPhase = (s.carrierPhase ?? 0) * Math.PI / 180;
  const signalPhase = (s.signalPhase ?? 0) * Math.PI / 180;
  return s.offset + s.amplitude * Math.sin(
    (2 * Math.PI * carrier * t + carrierPhase) + index * Math.sin(2 * Math.PI * signal * t + signalPhase),
  );
}

/**
 * Evaluate AM with ngspice-47 vsrcload.c/isrcload.c semantics, including the
 * value 0 (not VO) at and before TD and the `5/TSTOP` (FM) and `500/TSTOP`
 * (FC) frequency defaults.
 */
export function evaluateAm(a: AmSource, time: number, stopTime: number | undefined): number {
  const t = time - (a.delay ?? 0);
  if (t <= 0) return 0;
  const modulationFrequency = a.modulationFrequency ?? 5 / stopTime!;
  const carrierFrequency = a.carrierFrequency ?? 500 / stopTime!;
  const modulationPhase = (a.modulationPhase ?? 0) * Math.PI / 180;
  const carrierPhase = (a.carrierPhase ?? 0) * Math.PI / 180;
  return a.offset
    + (a.carrierAmplitude + (a.modulationAmplitude ?? 1) * Math.sin(2 * Math.PI * modulationFrequency * t + modulationPhase))
    * Math.sin(2 * Math.PI * carrierFrequency * t + carrierPhase);
}

/**
 * SFFM/AM default an omitted frequency from the transient TSTOP. A transient
 * run without a stop time (an open-ended stepping session) has none, so such a
 * source must state its frequencies.
 */
export function requireStopTimeForDefaults(name: string, waveform: SourceWaveform, stopTime: number | undefined): void {
  if (stopTime !== undefined) return;
  const missing = waveform.type === 'sffm'
    ? waveform.carrierFrequency === undefined || !nonzero(waveform.signalFrequency)
    : waveform.type === 'am'
      ? waveform.modulationFrequency === undefined || waveform.carrierFrequency === undefined
      : false;
  if (missing) {
    throw new InvalidCircuitError(
      `Source '${name}': ${waveform.type.toUpperCase()} frequencies default from the transient stop time, which this run does not have; give them explicitly`,
    );
  }
}

export function evaluateSin(s: SinSource, time: number): number {
  const delay = s.delay ?? 0;
  const damping = s.damping ?? 0;
  const phase = s.phase ?? 0;
  if (time < delay) return s.offset;
  const t = time - delay;
  return s.offset + s.amplitude * Math.exp(-damping * t) *
    Math.sin(2 * Math.PI * s.frequency * t + (phase * Math.PI) / 180);
}
