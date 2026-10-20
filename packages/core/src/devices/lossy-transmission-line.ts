import type { DeviceModel, StampContext, TransientBreakpointSink } from './device.js';
import {
  linInterp,
  quadInterp,
  rlcCoeffsSetup,
  type ResolvedLtraModel,
  type RlcCoefficients,
} from './ltra-model.js';

/**
 * Coefficient cache shared by every instance of one LTRA model. All instances
 * accept the same timepoints, so the convolution coefficients of a trial time
 * depend only on the model (ngspice computes them once per model in LTRAload).
 */
export class LtraModelState {
  private coefficients: RlcCoefficients | undefined;
  private key: { time: number; count: number; last: number } | undefined;

  constructor(readonly model: ResolvedLtraModel) {}

  rlcCoefficients(time: number, timePoints: Float64Array, count: number): RlcCoefficients {
    const last = timePoints[count - 1];
    const key = this.key;
    if (this.coefficients && key && key.time === time && key.count === count && key.last === last) {
      return this.coefficients;
    }
    const { delay, alpha, beta } = this.model;
    // LTRAchopReltol defaults to zero: every coefficient is kept.
    this.coefficients = rlcCoeffsSetup(delay, alpha, beta, time, timePoints, count - 1, 0, this.coefficients);
    this.key = { time, count, last };
    return this.coefficients;
  }
}

interface TransientLoad {
  time: number;
  /** Extra admittance on the port-voltage terms, Y * h1dashFirst. */
  selfAdmittance: number;
  input1: number;
  input2: number;
}

function growTo(array: Float64Array, size: number): Float64Array {
  if (array.length >= size) return array;
  const grown = new Float64Array(Math.max(size, 2 * array.length));
  grown.set(array);
  return grown;
}

/**
 * ngspice-47 LTRA lossy transmission line (O element) for the G=0 LC and RLC
 * cases: the exact convolution formulation of ltraload.c over the accepted
 * timepoint history, with quadratic interpolation of the delayed port waves,
 * the ltratrun.c LTRAtrunc step limits (STEPLIMIT/NOSTEPLIMIT delay bound,
 * maxSafeStep unless TRUNCDONTCUT; no FULLCONTROL/HALFCONTROL), and the LTRAaccept
 * breakpoints one delay after a slope change of an outgoing wave. Branch
 * currents are positive into each port.
 */
export class LossyTransmissionLine implements DeviceModel {
  readonly branches: number[];
  readonly isNonlinear = false;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (LTRAtrunc). */
  readonly truncationCoversCharges = true;

  private timePoints: Float64Array = new Float64Array(64);
  private v1: Float64Array = new Float64Array(64);
  private i1: Float64Array = new Float64Array(64);
  private v2: Float64Array = new Float64Array(64);
  private i2: Float64Array = new Float64Array(64);
  private count = 0;
  private initVolt1 = 0;
  private initCur1 = 0;
  private initVolt2 = 0;
  private initCur2 = 0;
  private load: TransientLoad | undefined;

  constructor(
    readonly name: string,
    /** [port1+, port1-, port2+, port2-] */
    readonly nodes: number[],
    readonly branch1: number,
    readonly branch2: number,
    readonly state: LtraModelState,
  ) {
    this.branches = [branch1, branch2];
  }

  get model(): ResolvedLtraModel {
    return this.state.model;
  }

  get modelWarnings(): readonly string[] {
    return this.model.warnings;
  }

  readonly frequencyDependent = true;

  /** The full complex wave stamp is loaded per frequency, not from DC. */
  stampSmallSignal(): void {}

  /** ngspice-47 ltraacld.c: Y0 V1 - I1 = exp(-lambda LEN)(Y0 V2 + I2). */
  stampFrequencyConductance(ctx: StampContext, omega: number): void {
    const { resistancePerLength: r, inductancePerLength: l, capacitancePerLength: c, length, specialCase } = this.model;
    let yr: number;
    let yi: number;
    let lr: number;
    let li: number;
    if (specialCase === 'LC') {
      yr = this.model.admittance;
      yi = lr = 0;
      li = Math.sqrt(l * c) * omega;
    } else if (specialCase === 'RC') {
      yr = yi = Math.sqrt(0.5 * omega * c / r);
      lr = li = Math.sqrt(0.5 * omega * r * c);
    } else {
      const theta = 0.5 * Math.atan(r / (omega * l));
      const z = Math.hypot(r, omega * l);
      const magnitude = Math.sqrt(omega * c / z);
      yr = magnitude * Math.cos(theta);
      yi = magnitude * Math.sin(theta);
      lr = magnitude * z * Math.cos(Math.PI / 2 - theta);
      li = magnitude * z * Math.sin(Math.PI / 2 - theta);
    }
    const attenuation = Math.exp(-lr * length);
    const er = attenuation * Math.cos(-li * length);
    const ei = attenuation * Math.sin(-li * length);
    const yer = yr * er - yi * ei;
    const yei = yr * ei + yi * er;
    const [p1, n1, p2, n2] = this.nodes;
    const b1 = ctx.numNodes + this.branch1;
    const b2 = ctx.numNodes + this.branch2;
    // C is multiplied by j*omega by the AC assembler.
    const complex = (row: number, col: number, real: number, imaginary: number): void => {
      if (col < 0) return;
      ctx.stampG(row, col, real);
      ctx.stampC(row, col, imaginary / omega);
    };
    for (const [row, own, other, positive, negative, remotePositive, remoteNegative] of [
      [b1, b1, b2, p1, n1, p2, n2],
      [b2, b2, b1, p2, n2, p1, n1],
    ]) {
      this.stampNodePair(ctx, positive, negative, own, 1);
      complex(row, positive, yr, yi);
      complex(row, negative, -yr, -yi);
      complex(row, own, -1, 0);
      complex(row, remotePositive, -yer, -yei);
      complex(row, remoteNegative, yer, yei);
      complex(row, other, -er, -ei);
    }
  }

  stamp(ctx: StampContext): void {
    const [p1, n1, p2, n2] = this.nodes;
    const b1 = ctx.numNodes + this.branch1;
    const b2 = ctx.numNodes + this.branch2;
    const model = this.model;

    // Port KCL: the branch current leaves the positive node.
    this.stampNodePair(ctx, p1, n1, b1, 1);
    this.stampNodePair(ctx, p2, n2, b2, 1);

    if (ctx.dt === 0) {
      // ltraload.c MODEDC for LC/RLC: a series resistance R*LEN between the
      // ports, i1 + i2 = 0.
      ctx.stampG(b1, b1, 1);
      ctx.stampG(b1, b2, 1);
      if (p1 >= 0) ctx.stampG(b2, p1, 1);
      if (p2 >= 0) ctx.stampG(b2, p2, -1);
      ctx.stampG(b2, b1, -model.resistancePerLength * model.length);
      // Register the transient pattern before sparse topology locking.
      this.stampVoltageRow(ctx, b1, p1, n1, 0);
      this.stampVoltageRow(ctx, b2, p2, n2, 0);
      ctx.stampG(b2, b2, 0);
      return;
    }

    const load = this.transientLoad(ctx.time);
    const admittance = model.admittance + load.selfAdmittance;
    this.stampVoltageRow(ctx, b1, p1, n1, admittance);
    ctx.stampG(b1, b1, -1);
    this.stampVoltageRow(ctx, b2, p2, n2, admittance);
    ctx.stampG(b2, b2, -1);
    ctx.stampB(b1, load.input1);
    ctx.stampB(b2, load.input2);
    // Keep the DC-only entries in the locked pattern.
    ctx.stampG(b1, b2, 0);
    ctx.stampG(b2, b1, 0);
    if (p1 >= 0) ctx.stampG(b2, p1, 0);
  }

  acceptTransientStep(ctx: StampContext, breakpoints?: TransientBreakpointSink): void {
    const [p1, n1, p2, n2] = this.nodes;
    const voltage = (positive: number, negative: number): number =>
      (positive >= 0 ? ctx.getVoltage(positive) : 0) - (negative >= 0 ? ctx.getVoltage(negative) : 0);
    const time = this.count === 0 ? 0 : ctx.time;
    let index = this.count;
    if (index > 0 && time <= this.timePoints[index - 1]) {
      // A repeated acceptance of the same timepoint replaces it.
      index--;
    } else {
      this.ensureCapacity(index + 1);
      this.count = index + 1;
    }
    this.timePoints[index] = time;
    this.v1[index] = voltage(p1, n1);
    this.v2[index] = voltage(p2, n2);
    this.i1[index] = ctx.getCurrent(this.branch1);
    this.i2[index] = ctx.getCurrent(this.branch2);
    if (index === 0) {
      // ltraload.c MODEINITTRAN: initial conditions from the operating point.
      this.initVolt1 = this.v1[0];
      this.initVolt2 = this.v2[0];
      this.initCur1 = this.i1[0];
      this.initCur2 = this.i2[0];
      this.load = undefined;
    } else if (breakpoints) {
      this.scheduleBreakpoint(index, breakpoints);
    }
  }

  /**
   * ltraacct.c (non-NOTDEF branch): when the slope of an outgoing wave
   * (v + Z0 i) * attenuation changes by more than REL relative (ABS absolute)
   * and the last three samples are not a steady value, the previous point
   * reaches the far port one delay later: set a breakpoint there.
   */
  private scheduleBreakpoint(index: number, breakpoints: TransientBreakpointSink): void {
    const model = this.model;
    const { impedance, attenuation } = model;
    const t = this.timePoints;
    const wave = (v: Float64Array, i: Float64Array, k: number): number => (v[k] + i[k] * impedance) * attenuation;
    const first = index < 2;
    const v1 = wave(this.v1, this.i1, index);
    const v2 = wave(this.v1, this.i1, index - 1);
    const v3 = first ? v2 : wave(this.v1, this.i1, index - 2);
    const v4 = wave(this.v2, this.i2, index);
    const v5 = wave(this.v2, this.i2, index - 1);
    const v6 = first ? v5 : wave(this.v2, this.i2, index - 2);
    const step = t[index] - t[index - 1];
    const previousStep = first ? 0 : t[index - 1] - t[index - 2];
    const d1 = (v1 - v2) / step;
    const d2 = first ? 0 : (v2 - v3) / previousStep;
    const d3 = (v4 - v5) / step;
    const d4 = first ? 0 : (v5 - v6) / previousStep;
    const { breakpointReltol: rel, breakpointAbstol: abs, circuitReltol, circuitAbstol } = model;
    const changing = (a: number, b: number, c: number): boolean =>
      Math.max(a, b, c) - Math.min(a, b, c) >= Math.abs(50 * (circuitReltol / 3 * (a + b + c) + circuitAbstol));
    const bends = (da: number, db: number): boolean =>
      Math.abs(da - db) >= rel * Math.max(Math.abs(da), Math.abs(db)) + abs;
    if ((bends(d1, d2) && changing(v1, v2, v3)) || (bends(d3, d4) && changing(v4, v5, v6))) {
      breakpoints.schedule(t[index - 1] + model.delay);
    }
  }

  /**
   * ngspice-47 ltratrun.c LTRAtrunc for the LC and RLC cases, evaluated at
   * the converged trial solution in `ctx` against the accepted history.
   */
  truncateTransientStep(ctx: StampContext): number {
    const model = this.model;
    let step = Infinity;
    if (model.stepLimit) {
      // ltratrun.c:37-39: STEPLIMIT (the ltraset.c default) bounds every
      // step by the delay.
      step = model.delay;
    } else if (this.count >= 2 && this.slopeChangesAtTrial(ctx)) {
      // ltratrun.c:75-93 (NOSTEPLIMIT): the incoming wave changed slope at
      // the last accepted point, so the next step must not pass one delay.
      step = model.delay;
    }
    // ltratrun.c:125-128: the piecewise-linear impulse-response integration.
    if (model.specialCase === 'RLC' && !model.truncDontCut) {
      step = Math.min(step, model.maxSafeStep);
    }
    // ltratrun.c:129-186 (FULLCONTROL/HALFCONTROL) is rejected at model
    // resolution; NOCONTROL, the ltraset.c default, adds no bound.
    return step;
  }

  /**
   * ltratrun.c:41-78: whether the incoming wave of either port,
   * (v * Y0 + i) * attenuation, changes slope between the last accepted
   * interval and the trial interval by more than REL/ABS.
   */
  private slopeChangesAtTrial(ctx: StampContext): boolean {
    const model = this.model;
    const [p1, n1, p2, n2] = this.nodes;
    const voltage = (positive: number, negative: number): number =>
      (positive >= 0 ? ctx.getVoltage(positive) : 0) - (negative >= 0 ? ctx.getVoltage(negative) : 0);
    const last = this.count - 1;
    const t = this.timePoints;
    const changes = (trialV: number, trialI: number, v: Float64Array, i: Float64Array): boolean => {
      const wave = (vk: number, ik: number): number => (vk * model.admittance + ik) * model.attenuation;
      const w1 = wave(trialV, trialI);
      const w2 = wave(v[last], i[last]);
      const w3 = wave(v[last - 1], i[last - 1]);
      const d1 = (w1 - w2) / (ctx.time - t[last]);
      const d2 = (w2 - w3) / (t[last] - t[last - 1]);
      return Math.abs(d1 - d2)
        >= model.breakpointReltol * Math.max(Math.abs(d1), Math.abs(d2)) + model.breakpointAbstol;
    };
    return changes(voltage(p2, n2), ctx.getCurrent(this.branch2), this.v2, this.i2)
      || changes(voltage(p1, n1), ctx.getCurrent(this.branch1), this.v1, this.i1);
  }

  resetTransient(): void {
    this.count = 0;
    this.load = undefined;
  }

  /**
   * ltraload.c transient load for one trial time: the self-admittance term and
   * the history excitations, computed once per timepoint (MODEINITPRED) from
   * the accepted history only.
   */
  private transientLoad(time: number): TransientLoad {
    const last = this.count - 1;
    if (this.load && (this.load.time === time || last < 0 || time <= this.timePoints[last])) {
      // Restamps at an accepted point reuse the load that point was solved with.
      return this.load;
    }
    if (last < 0 || time <= this.timePoints[last]) {
      // No trial ahead of the history (a restamp before any transient solve):
      // the line is at its initial state.
      const model = this.model;
      return {
        time,
        selfAdmittance: 0,
        input1: model.attenuation * (this.initVolt2 * model.admittance + this.initCur2),
        input2: model.attenuation * (this.initVolt1 * model.admittance + this.initCur1),
      };
    }
    const model = this.model;
    const { admittance: Y } = model;
    const t = this.timePoints;
    const tdover = time > model.delay;

    let v1d = 0;
    let v2d = 0;
    let i1d = 0;
    let i2d = 0;
    if (tdover) {
      const delayed = time - model.delay;
      let i = last;
      for (; i >= 0; i--) {
        if (t[i] < delayed) break;
      }
      if (i === last) i--;
      if (i < 0) i = 0;
      if (i + 1 > last) {
        v1d = this.v1[last];
        v2d = this.v2[last];
        i1d = this.i1[last];
        i2d = this.i2[last];
      } else {
        const quad = i !== 0 && model.interpolation !== 'linear'
          ? quadInterp(delayed, t[i - 1], t[i], t[i + 1]) : undefined;
        const lin = linInterp(delayed, t[i], t[i + 1]) ?? [1, 0];
        const sample = (values: Float64Array): number => {
          if (quad) {
            const value = values[i - 1] * quad[0] + values[i] * quad[1] + values[i + 1] * quad[2];
            // MIXEDINTERP falls back to linear on quadratic overshoot;
            // QUADINTERP retains it (ltraload.c).
            if (model.interpolation !== 'mixed'
              || (value >= Math.min(values[i - 1], values[i], values[i + 1])
                && value <= Math.max(values[i - 1], values[i], values[i + 1]))) return value;
          }
          return values[i] * lin[0] + values[i + 1] * lin[1];
        };
        // QUADINTERP keeps an out-of-range quadratic value (ngspice only
        // reports it under LTRADEBUG).
        v1d = sample(this.v1);
        i1d = sample(this.i1);
        v2d = sample(this.v2);
        i2d = sample(this.i2);
      }
    }

    let input1 = 0;
    let input2 = 0;
    let selfAdmittance = 0;
    if (model.specialCase === 'RLC') {
      const coefficients = this.state.rlcCoefficients(time, t, this.count);
      const { h1dash, h2, h3dash, h1dashFirst, h2First, h3dashFirst, auxIndex } = coefficients;
      selfAdmittance = Y * h1dashFirst;

      let dummy1 = 0;
      let dummy2 = 0;
      for (let k = last; k > 0; k--) {
        const c = h1dash[k];
        if (c !== 0) {
          dummy1 += c * (this.v1[k] - this.initVolt1);
          dummy2 += c * (this.v2[k] - this.initVolt2);
        }
      }
      dummy1 += this.initVolt1 * model.intH1dash - this.initVolt1 * h1dashFirst;
      dummy2 += this.initVolt2 * model.intH1dash - this.initVolt2 * h1dashFirst;
      input1 -= dummy1 * Y;
      input2 -= dummy2 * Y;

      dummy1 = 0;
      dummy2 = 0;
      if (tdover) {
        dummy1 = (i2d - this.initCur2) * h2First;
        dummy2 = (i1d - this.initCur1) * h2First;
        for (let k = auxIndex; k > 0; k--) {
          const c = h2[k];
          if (c !== 0) {
            dummy1 += c * (this.i2[k] - this.initCur2);
            dummy2 += c * (this.i1[k] - this.initCur1);
          }
        }
      }
      dummy1 += this.initCur2 * model.intH2;
      dummy2 += this.initCur1 * model.intH2;
      input1 += dummy1;
      input2 += dummy2;

      dummy1 = 0;
      dummy2 = 0;
      if (tdover) {
        dummy1 = (v2d - this.initVolt2) * h3dashFirst;
        dummy2 = (v1d - this.initVolt1) * h3dashFirst;
        for (let k = auxIndex; k > 0; k--) {
          const c = h3dash[k];
          if (c !== 0) {
            dummy1 += c * (this.v2[k] - this.initVolt2);
            dummy2 += c * (this.v1[k] - this.initVolt1);
          }
        }
      }
      dummy1 += this.initVolt2 * model.intH3dash;
      dummy2 += this.initVolt1 * model.intH3dash;
      input1 += Y * dummy1;
      input2 += Y * dummy2;
    }

    // The lossless-like part shared by LC and RLC.
    if (!tdover) {
      input1 += model.attenuation * (this.initVolt2 * Y + this.initCur2);
      input2 += model.attenuation * (this.initVolt1 * Y + this.initCur1);
    } else {
      input1 += model.attenuation * (v2d * Y + i2d);
      input2 += model.attenuation * (v1d * Y + i1d);
    }

    this.load = { time, selfAdmittance, input1, input2 };
    return this.load;
  }

  private ensureCapacity(size: number): void {
    this.timePoints = growTo(this.timePoints, size);
    this.v1 = growTo(this.v1, size);
    this.i1 = growTo(this.i1, size);
    this.v2 = growTo(this.v2, size);
    this.i2 = growTo(this.i2, size);
  }

  private stampNodePair(ctx: StampContext, positive: number, negative: number, branch: number, scale: number): void {
    if (positive >= 0) ctx.stampG(positive, branch, scale);
    if (negative >= 0) ctx.stampG(negative, branch, -scale);
  }

  private stampVoltageRow(ctx: StampContext, row: number, positive: number, negative: number, value: number): void {
    if (positive >= 0) ctx.stampG(row, positive, value);
    if (negative >= 0) ctx.stampG(row, negative, -value);
  }
}
