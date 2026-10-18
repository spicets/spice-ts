import type {
  ChargeIntegration, ChargeTruncation, DeviceModel, StampContext, TransientBreakpointSink,
} from '../device.js';
import type { CodeModelBehavior, CodeModelCall } from './models.js';

/** An input port as stamped: a node pair (v, vd) or the current of an MNA branch (i, id, vnam). */
export interface XspiceInputPort {
  readonly kind: 'voltage' | 'current';
  readonly positive: number;
  readonly negative: number;
  /** Zero-volt sensing branch owned by this instance (i, id). */
  readonly ownBranch?: number;
  /** Branch whose current is read: the own sensing branch or a named voltage source (vnam). */
  branch?: number;
  /** Name of the controlling voltage source of a vnam port, resolved after compile. */
  readonly source?: string;
}

/** An output port as stamped: an ideal voltage source (v, vd) or a current source (i, id). */
export interface XspiceOutputPort {
  readonly kind: 'voltage' | 'current';
  readonly positive: number;
  readonly negative: number;
  /** Branch of a voltage output. */
  readonly branch?: number;
}

/** ngspice cktinit.c: XSPICE input convergence limiting defaults (conv_limit step / abs_step). */
const CONV_LIMIT_STEP = 0.25;
const CONV_LIMIT_ABS_STEP = 0.1;

/**
 * An XSPICE A-element (ngspice MIFload). Each voltage output is an ideal
 * voltage source and each current output a current source, linearised by the
 * code model's PARTIALs; each current input is a zero-volt sensing source.
 * Inputs are limited between Newton iterations to max(25 % of the last input,
 * 0.1) as ngspice's default conv_limit does, and a limited iteration cannot
 * converge (CKTnoncon).
 */
export class XspiceDevice implements DeviceModel {
  readonly nodes: number[];
  readonly branches: number[];
  readonly isNonlinear = true;
  /** Inputs are limited against the previous iterate, so the device's nodes take no Newton damping. */
  readonly limitsOwnJunctions = true;
  readonly integratesTransientCharge: boolean;
  readonly stampDynamic?: (ctx: StampContext) => void;
  readonly truncateTransientStep?: (ctx: StampContext, truncation: ChargeTruncation) => number;
  readonly truncationCoversCharges?: boolean;
  readonly modelWarnings?: readonly string[];
  /**
   * False for digital node bridges and magnetic models: ngspice MIFtrunc
   * limits the step only through cm_analog_integrate, which they never call, so their nodes take
   * no truncation error.
   */
  readonly storesCharge?: boolean;

  private readonly inputs: Float64Array;
  private readonly outputs: Float64Array;
  private readonly partials: Float64Array;
  private readonly lastInputs: Float64Array;
  private readonly acceptedInputs: Float64Array;
  private readonly acceptedOutputs: Float64Array;
  private readonly acceptedPartials: Float64Array;
  private initialized = false;
  private limited = false;
  /** Time of the last accepted transient point; undefined outside a transient run. */
  private acceptedTime: number | undefined;
  private lastIntegration: ChargeIntegration | undefined;

  constructor(
    readonly name: string,
    readonly codeModel: string,
    private readonly inputPorts: readonly XspiceInputPort[],
    private readonly outputPorts: readonly XspiceOutputPort[],
    private readonly behavior: CodeModelBehavior,
    warnings: readonly string[] = [],
    untruncated = false,
  ) {
    // cm_square computes phase arithmetically; cm_oneshot stores clock/corner
    // times. Neither uses cm_analog_integrate. Their prescribed finite edges
    // are bounded by model breakpoints, not node-voltage LTE.
    if (untruncated || codeModel === 'square' || codeModel === 'oneshot') this.storesCharge = false;
    const nodes = new Set<number>();
    for (const port of [...inputPorts, ...outputPorts]) {
      nodes.add(port.positive);
      nodes.add(port.negative);
    }
    this.nodes = [...nodes];
    this.branches = [
      ...outputPorts.flatMap(port => port.branch === undefined ? [] : [port.branch]),
      ...inputPorts.flatMap(port => port.ownBranch === undefined ? [] : [port.ownBranch]),
    ];
    const inputCount = inputPorts.length;
    const outputCount = outputPorts.length;
    this.inputs = new Float64Array(inputCount);
    this.outputs = new Float64Array(outputCount);
    this.partials = new Float64Array(inputCount * outputCount);
    this.lastInputs = new Float64Array(inputCount);
    this.acceptedInputs = new Float64Array(inputCount);
    this.acceptedOutputs = new Float64Array(outputCount);
    this.acceptedPartials = new Float64Array(inputCount * outputCount);
    this.integratesTransientCharge = behavior.stateful;
    if (warnings.length > 0) this.modelWarnings = warnings;
    if (behavior.ac.kind !== 'static') this.stampDynamic = ctx => this.stampFrequencyDependent(ctx);
    if (behavior.truncate) {
      this.truncateTransientStep = (ctx, truncation) => this.truncationTimestep(ctx, truncation);
      // xtradev/{capacitor,inductor}/cfunc.mod:76-82 integrates its only
      // state. miftrunc.c:98-103 bounds that integral, including ramp release;
      // a second node-voltage LTE check changes the release grid and state.
      if (codeModel === 'capacitoric' || codeModel === 'inductoric') this.truncationCoversCharges = true;
    }
  }

  setTransientRampTime(rampTime: number): void {
    this.behavior.setRampTime?.(rampTime);
  }

  stamp(ctx: StampContext): void {
    const transient = this.acceptedTime !== undefined && ctx.dt > 0;
    if (transient && ctx.time === this.acceptedTime) {
      // Re-stamp at the accepted point (trapezoidal history of other elements).
      this.stampLinearization(ctx, this.acceptedInputs, this.acceptedOutputs, this.acceptedPartials);
      return;
    }
    // A stateful model needs the step's integration rule: stampTransientCharge loads it.
    if (transient && this.behavior.stateful) return;
    this.loadAndStamp(ctx, transient ? 'tran' : 'dc', undefined);
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    if (this.acceptedTime === undefined || ctx.time === this.acceptedTime) return;
    this.lastIntegration = integration;
    this.loadAndStamp(ctx, 'tran', integration);
  }

  setTransientTimestep(timestep: number, stopTime?: number): void {
    this.behavior.setTransientTimestep?.(timestep, stopTime);
  }

  beginTransientNewton(): void {
    this.lastInputs.set(this.acceptedInputs);
  }

  limitedLastStamp(): boolean {
    return this.limited;
  }

  acceptTransientStep(ctx: StampContext, breakpoints?: TransientBreakpointSink): void {
    const transient = this.acceptedTime !== undefined && ctx.dt > 0 && ctx.time > this.acceptedTime;
    // The operating point that starts a transient run: drop any earlier run's history.
    if (!transient) {
      if (this.behavior.beginTransient) this.behavior.beginTransient();
      else this.behavior.reset?.();
    }
    const call = this.call(ctx, transient ? 'tran' : 'dc', transient ? this.lastIntegration : undefined, false);
    this.behavior.load(call);
    this.behavior.accept?.(call);
    if (this.behavior.breakpoints) {
      const times = this.behavior.breakpoints();
      if (breakpoints?.replaceTemporary) breakpoints.replaceTemporary(this, times);
      else for (const time of times) breakpoints?.schedule(time);
    }
    this.acceptedInputs.set(this.inputs);
    this.acceptedOutputs.set(this.outputs);
    this.acceptedPartials.set(this.partials);
    this.lastInputs.set(this.inputs);
    this.acceptedTime = transient ? ctx.time : 0;
  }

  resetTransient(): void {
    this.acceptedTime = undefined;
    this.lastIntegration = undefined;
    this.behavior.reset?.();
  }

  prepareTransientStep(ctx: StampContext): void {
    this.behavior.load(this.call(ctx, 'tran', this.lastIntegration, false));
  }

  /** Resolve a vnam input to the branch of its controlling voltage source. */
  bindSourceBranch(port: number, branch: number): void {
    (this.inputPorts[port] as XspiceInputPort).branch = branch;
  }

  get unresolvedSources(): { port: number; source: string }[] {
    return this.inputPorts.flatMap((port, index) =>
      port.source !== undefined && port.branch === undefined ? [{ port: index, source: port.source }] : []);
  }

  private truncationTimestep(ctx: StampContext, truncation: ChargeTruncation): number {
    if (this.acceptedTime === undefined || ctx.time === this.acceptedTime) return Infinity;
    const call = this.call(ctx, 'tran', this.lastIntegration, false);
    return this.behavior.truncate!(call, truncation);
  }

  private loadAndStamp(ctx: StampContext, analysis: 'dc' | 'tran', integration: ChargeIntegration | undefined): void {
    this.limited = false;
    const call = this.call(ctx, analysis, integration, true);
    this.behavior.load(call);
    this.initialized = true;
    this.stampLinearization(ctx, this.inputs, this.outputs, this.partials);
  }

  /** Read the inputs (ngspice MIFload) and build the code model call. */
  private call(
    ctx: StampContext,
    analysis: 'dc' | 'tran',
    integration: ChargeIntegration | undefined,
    limit: boolean,
  ): CodeModelCall {
    for (let i = 0; i < this.inputPorts.length; i++) {
      const port = this.inputPorts[i];
      let value = port.kind === 'voltage'
        ? voltage(ctx, port.positive) - voltage(ctx, port.negative)
        : ctx.getCurrent(port.branch!);
      if (limit) {
        const last = this.lastInputs[i];
        const bound = Math.max(Math.abs(last) * CONV_LIMIT_STEP, CONV_LIMIT_ABS_STEP);
        if (Math.abs(value - last) > bound) {
          value = value - last > 0 ? last + bound : last - bound;
          this.limited = true;
        }
        this.lastInputs[i] = value;
      }
      this.inputs[i] = value;
    }
    this.outputs.fill(0);
    this.partials.fill(0);
    const tran = analysis === 'tran';
    return {
      analysis,
      init: !this.initialized,
      time: tran ? ctx.time : 0,
      delta: tran ? ctx.time - this.acceptedTime! : 0,
      ...(integration ? { integration } : {}),
      inputs: this.inputs,
      outputs: this.outputs,
      partials: this.partials,
      notConverged: () => { if (limit) this.limited = true; },
    };
  }

  /** ngspice MIFload matrix load for DC/TRAN: outputs plus PARTIAL-weighted controlled sources. */
  private stampLinearization(
    ctx: StampContext,
    inputs: Float64Array,
    outputs: Float64Array,
    partials: Float64Array,
  ): void {
    const n = ctx.numNodes;
    const inputCount = this.inputPorts.length;
    for (const port of this.inputPorts) {
      if (port.ownBranch === undefined) continue;
      stampBranchCoupling(ctx, port.positive, port.negative, n + port.ownBranch);
    }
    for (let o = 0; o < this.outputPorts.length; o++) {
      const out = this.outputPorts[o];
      if (out.kind === 'voltage') {
        const row = n + out.branch!;
        stampBranchCoupling(ctx, out.positive, out.negative, row);
        ctx.stampB(row, outputs[o]);
        for (let k = 0; k < inputCount; k++) {
          const partial = partials[o * inputCount + k];
          const input = this.inputPorts[k];
          if (input.kind === 'voltage') {
            stampG(ctx, row, input.positive, -partial);
            stampG(ctx, row, input.negative, partial);
          } else {
            ctx.stampG(row, n + input.branch!, -partial);
          }
          ctx.stampB(row, -partial * inputs[k]);
        }
      } else {
        stampB(ctx, out.positive, -outputs[o]);
        stampB(ctx, out.negative, outputs[o]);
        for (let k = 0; k < inputCount; k++) {
          const partial = partials[o * inputCount + k];
          const input = this.inputPorts[k];
          if (input.kind === 'voltage') {
            stampG(ctx, out.positive, input.positive, partial);
            stampG(ctx, out.positive, input.negative, -partial);
            stampG(ctx, out.negative, input.positive, -partial);
            stampG(ctx, out.negative, input.negative, partial);
          } else {
            stampG(ctx, out.positive, n + input.branch!, partial);
            stampG(ctx, out.negative, n + input.branch!, -partial);
          }
          stampB(ctx, out.positive, partial * inputs[k]);
          stampB(ctx, out.negative, -partial * inputs[k]);
        }
      }
    }
  }

  /**
   * Small-signal terms of d_dt (AC_GAIN = j*omega*gain) and int (AC_GAIN =
   * gain/(j*omega)), stamped on top of the operating-point stamp, whose
   * PARTIAL is zero for both at TIME = 0. The int's output equation is scaled
   * by j*omega: j*omega*(V+ - V-) - gain*in = 0.
   */
  private stampFrequencyDependent(ctx: StampContext): void {
    const ac = this.behavior.ac;
    if (ac.kind === 'static') return;
    const n = ctx.numNodes;
    for (const out of this.outputPorts) {
      for (const input of this.inputPorts) {
        if (ac.kind === 'differentiator') {
          if (ac.input !== undefined && input !== this.inputPorts[ac.input]) continue;
          if (ac.output !== undefined && out !== this.outputPorts[ac.output]) continue;
          if (out.kind === 'voltage') {
            const row = n + out.branch!;
            if (input.kind === 'voltage') {
              stampC(ctx, row, input.positive, -ac.gain);
              stampC(ctx, row, input.negative, ac.gain);
            } else {
              ctx.stampC(row, n + input.branch!, -ac.gain);
            }
          } else if (input.kind === 'voltage') {
            stampC(ctx, out.positive, input.positive, ac.gain);
            stampC(ctx, out.positive, input.negative, -ac.gain);
            stampC(ctx, out.negative, input.positive, -ac.gain);
            stampC(ctx, out.negative, input.negative, ac.gain);
          } else {
            stampC(ctx, out.positive, n + input.branch!, ac.gain);
            stampC(ctx, out.negative, n + input.branch!, -ac.gain);
          }
          continue;
        }
        // Integrator: a voltage output (current outputs are rejected at compile).
        const row = n + out.branch!;
        stampG(ctx, row, out.positive, -1);
        stampG(ctx, row, out.negative, 1);
        stampC(ctx, row, out.positive, 1);
        stampC(ctx, row, out.negative, -1);
        if (input.kind === 'voltage') {
          stampG(ctx, row, input.positive, -ac.gain);
          stampG(ctx, row, input.negative, ac.gain);
        } else {
          ctx.stampG(row, n + input.branch!, -ac.gain);
        }
      }
    }
  }
}

function voltage(ctx: StampContext, node: number): number {
  return node < 0 ? 0 : ctx.getVoltage(node);
}

function stampG(ctx: StampContext, row: number, col: number, value: number): void {
  if (row >= 0 && col >= 0) ctx.stampG(row, col, value);
}

function stampC(ctx: StampContext, row: number, col: number, value: number): void {
  if (row >= 0 && col >= 0) ctx.stampC(row, col, value);
}

function stampB(ctx: StampContext, row: number, value: number): void {
  if (row >= 0) ctx.stampB(row, value);
}

/** KCL coupling of a branch current into its nodes plus its V+ - V- branch equation terms. */
function stampBranchCoupling(ctx: StampContext, positive: number, negative: number, row: number): void {
  stampG(ctx, positive, row, 1);
  stampG(ctx, negative, row, -1);
  stampG(ctx, row, positive, 1);
  stampG(ctx, row, negative, -1);
}
