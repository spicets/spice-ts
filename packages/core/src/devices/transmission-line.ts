import type { ChargeTruncation, DeviceModel, StampContext, TransientBreakpointSink } from './device.js';

/** Port voltages and currents into the line: V1, I1, V2, I2 (used only with UIC). */
export type TransmissionLineInitialConditions = readonly [number, number, number, number];

interface PortSample {
  time: number;
  /** Wave launched at port 1, V1 + Z0*I1: the port-2 input one delay later. */
  port1Incoming: number;
  /** Wave launched at port 2, V2 + Z0*I2: the port-1 input one delay later. */
  port2Incoming: number;
}

/** ngspice-47 trasetup.c defaults of the T-card REL and ABS breakpoint controls. */
const BREAKPOINT_RELTOL = 1;
const BREAKPOINT_ABSTOL = 1;

/**
 * Minimum spacing of retained history points (ngspice-47 traacct.c appends
 * only beyond CKTminBreak). Close later samples leave the earlier point intact.
 */
const MIN_HISTORY_SPACING = 1e-14;

/**
 * Ideal two-port lossless delay line using the SPICE T-element wave equations.
 * Branch currents are positive into each port.
 *
 * Transient behaviour follows ngspice-47 `src/spicelib/devices/tra`:
 * - traload.c: the delayed waves are the three-point (quadratic Lagrange)
 *   interpolation of the accepted history at `t - TD`.
 * - traacct.c (TRAaccept): the history starts with the operating point at
 *   -2TD, -TD and 0 and is pruned to two points before `t - TD`. When a
 *   launched wave changes slope at the previous point, a breakpoint is set at
 *   that point plus TD.
 * - tratrunc.c (TRAtrunc): the same slope test at the trial point bounds the
 *   next step by the last accepted point plus TD. That is the line's whole
 *   DEVtrunc, so its port nodes take no node-voltage truncation (ngspice-47
 *   has none), and the line sets no breakpoint of its own at TD (#791).
 */
export class TransmissionLine implements DeviceModel {
  readonly branches: number[];
  readonly isNonlinear = false;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (TRAtrunc). */
  readonly truncationCoversCharges = true;
  private readonly history: PortSample[] = [];

  constructor(
    readonly name: string,
    readonly nodes: number[],
    readonly branch1: number,
    readonly branch2: number,
    readonly impedance: number,
    readonly delay: number,
    readonly initialConditions?: TransmissionLineInitialConditions,
  ) {
    this.branches = [branch1, branch2];
  }

  stamp(ctx: StampContext): void {
    const [p1, n1, p2, n2] = this.nodes;
    const b1 = ctx.numNodes + this.branch1;
    const b2 = ctx.numNodes + this.branch2;

    this.stampPortKcl(ctx, p1, n1, b1);
    this.stampPortKcl(ctx, p2, n2, b2);

    if (ctx.dt === 0) {
      // ngspice-47 traload.c MODEDC, with its internal port nodes eliminated.
      // The gmin factor regularizes parallel ideal lines' otherwise
      // indeterminate circulating branch currents.
      const coupling = -(1 - (ctx.gmin ?? 1e-12)) * this.impedance;
      this.stampVoltage(ctx, b1, p1, n1, 1);
      this.stampVoltage(ctx, b1, p2, n2, -1);
      ctx.stampG(b1, b1, -this.impedance);
      ctx.stampG(b1, b2, coupling);
      this.stampVoltage(ctx, b2, p2, n2, 1);
      this.stampVoltage(ctx, b2, p1, n1, -1);
      ctx.stampG(b2, b2, -this.impedance);
      ctx.stampG(b2, b1, coupling);
      return;
    }

    const delayed = this.sampleAt(ctx.time - this.delay);

    // V1 - Z0*I1 = V2(t-TD) + Z0*I2(t-TD), and vice versa.
    this.stampVoltage(ctx, b1, p1, n1, 1);
    ctx.stampG(b1, b1, -this.impedance);
    ctx.stampB(b1, delayed.port2Incoming);

    this.stampVoltage(ctx, b2, p2, n2, 1);
    ctx.stampG(b2, b2, -this.impedance);
    ctx.stampB(b2, delayed.port1Incoming);
  }

  acceptTransientStep(ctx: StampContext, breakpoints?: TransientBreakpointSink): void {
    const sample = this.launchedWaves(ctx);
    const history = this.history;
    if (history.length === 0) {
      if (ctx.initialUIC) {
        // traload.c MODEINITTRAN | MODEUIC uses the instance IC, not the
        // unsolved circuit seed; omitted port values default to zero.
        const [v1, i1, v2, i2] = this.initialConditions ?? [0, 0, 0, 0];
        sample.port1Incoming = v1 + this.impedance * i1;
        sample.port2Incoming = v2 + this.impedance * i2;
      }
      // traload.c MODEINITTRAN: the history starts at -2TD, -TD and 0 with
      // the operating-point waves.
      history.push(
        { ...sample, time: sample.time - 2 * this.delay },
        { ...sample, time: sample.time - this.delay },
        sample,
      );
      return;
    }

    // traacct.c: keep two points before the first one at or after t - TD.
    const oldestNeeded = sample.time - this.delay;
    if (oldestNeeded > history[2].time) {
      let index = 2;
      while (index < history.length - 1 && oldestNeeded > history[index].time) index++;
      history.splice(0, index - 2);
    }

    const last = history[history.length - 1];
    if (sample.time === last.time) {
      // A repeated acceptance of the same timepoint replaces it.
      history[history.length - 1] = sample;
      return;
    }
    // Never advance the retained timestamp for a distinct too-close sample:
    // otherwise small accepted steps continually erase the delayed history.
    if (sample.time - last.time <= MIN_HISTORY_SPACING) return;
    history.push(sample);

    const previous = history[history.length - 2];
    const older = history[history.length - 3];
    if (breakpoints && this.bends(
      sample, previous, older, sample.time - previous.time, previous.time - older.time,
    )) {
      // The slope change at the previous point reaches the far port one delay later.
      breakpoints.schedule(previous.time + this.delay);
    }
  }

  /**
   * ngspice-47 tratrunc.c: when a launched wave at the trial point changes
   * slope against the accepted history, the step must not pass the last
   * accepted point plus TD. As in TRAtrunc, the two slopes divide by
   * CKTdeltaOld[1] and CKTdeltaOld[2].
   */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    const history = this.history;
    if (history.length < 2) return Infinity;
    const last = history[history.length - 1];
    const previous = history[history.length - 2];
    const trial = this.launchedWaves(ctx);
    if (!this.bends(trial, last, previous, truncation.deltas[1], truncation.deltas[2])) return Infinity;
    return last.time + this.delay - ctx.time;
  }

  resetTransient(): void {
    this.history.length = 0;
  }

  /** traacct.c/tratrunc.c slope test on either launched wave over two intervals. */
  private bends(
    newest: PortSample, middle: PortSample, oldest: PortSample, newerStep: number, olderStep: number,
  ): boolean {
    const changes = (a: number, b: number, c: number): boolean => {
      const d1 = (a - b) / newerStep;
      const d2 = (b - c) / olderStep;
      return Math.abs(d1 - d2) >= BREAKPOINT_RELTOL * Math.max(Math.abs(d1), Math.abs(d2)) + BREAKPOINT_ABSTOL;
    };
    return changes(newest.port2Incoming, middle.port2Incoming, oldest.port2Incoming)
      || changes(newest.port1Incoming, middle.port1Incoming, oldest.port1Incoming);
  }

  private launchedWaves(ctx: StampContext): PortSample {
    const portVoltage = (positive: number, negative: number): number =>
      (positive >= 0 ? ctx.getVoltage(positive) : 0)
      - (negative >= 0 ? ctx.getVoltage(negative) : 0);
    return {
      time: ctx.time,
      port1Incoming: portVoltage(this.nodes[0], this.nodes[1])
        + this.impedance * ctx.getCurrent(this.branch1),
      port2Incoming: portVoltage(this.nodes[2], this.nodes[3])
        + this.impedance * ctx.getCurrent(this.branch2),
    };
  }

  private stampPortKcl(ctx: StampContext, positive: number, negative: number, branch: number): void {
    if (positive >= 0) ctx.stampG(positive, branch, 1);
    if (negative >= 0) ctx.stampG(negative, branch, -1);
  }

  private stampVoltage(
    ctx: StampContext,
    row: number,
    positive: number,
    negative: number,
    scale: number,
  ): void {
    if (positive >= 0) ctx.stampG(row, positive, scale);
    if (negative >= 0) ctx.stampG(row, negative, -scale);
  }

  /**
   * traload.c MODEINITPRED: three-point Lagrange interpolation of the history
   * at `time`, over the first point after it and the two before (the last
   * three points when `time` is past the history).
   */
  private sampleAt(time: number): PortSample {
    const history = this.history;
    if (history.length < 3) {
      return history[history.length - 1] ?? { time, port1Incoming: 0, port2Incoming: 0 };
    }
    let index = 2;
    while (index < history.length - 1 && history[index].time <= time) index++;
    const first = history[index - 2];
    const second = history[index - 1];
    const third = history[index];
    const t1 = first.time;
    const t2 = second.time;
    const t3 = third.time;
    const w1 = (time - t2) * (time - t3) / ((t1 - t2) * (t1 - t3));
    const w2 = (time - t1) * (time - t3) / ((t2 - t1) * (t2 - t3));
    const w3 = (time - t1) * (time - t2) / ((t3 - t1) * (t3 - t2));
    return {
      time,
      port1Incoming: w1 * first.port1Incoming + w2 * second.port1Incoming + w3 * third.port1Incoming,
      port2Incoming: w1 * first.port2Incoming + w2 * second.port2Incoming + w3 * third.port2Incoming,
    };
  }
}
