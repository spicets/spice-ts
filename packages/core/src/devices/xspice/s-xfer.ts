import { InvalidCircuitError } from '../../errors.js';
import type { ChargeTruncation, StampContext } from '../device.js';
import { gear3Coefficients } from '../gear3.js';
import type { CodeModelBehavior, CodeModelCall, ResolvedXspiceParams } from './models.js';
import { real, reals, STATIC } from './models.js';
import { XspiceDevice, type XspiceInputPort, type XspiceOutputPort } from './xspice-device.js';

/** Ascending, frequency-denormalized coefficients, with a monic denominator. */
export interface STransfer {
  readonly numerator: readonly number[];
  readonly denominator: readonly number[];
  readonly initial: readonly number[];
  readonly gain: number;
  readonly offset: number;
}

/** The bounded slice is strictly proper, order 1 or 2, with finite coefficients. */
export function resolveSTransfer(params: ResolvedXspiceParams): STransfer {
  const den = reals(params, 'den_coeff');
  const num = reals(params, 'num_coeff');
  const order = den.length - 1;
  const fail = (message: string): never => { throw new InvalidCircuitError(`XSPICE s_xfer: ${message}`); };
  if (order < 1 || order > 2) fail('supported denominator order is 1 or 2');
  if (num.length > order) fail('only strictly proper transfer functions are supported');
  if (den[0] === 0) fail('leading denominator coefficient must be nonzero');
  const frequency = real(params, 'denormalized_freq');
  if (!(frequency > 0) || !Number.isFinite(frequency)) fail('denormalized_freq must be finite and positive');
  const givenIc = reals(params, 'int_ic');
  if (givenIc.length !== 0 && givenIc.length !== order) fail('int_ic size must equal denominator order');
  const initial = givenIc.length === 0 ? Array<number>(order).fill(0) : givenIc.reverse();
  const normalize = (coefficients: number[]) => coefficients.reverse().map((value, i) => value / frequency ** i);
  const denominator = normalize(den);
  const numerator = normalize(num);
  const factor = denominator[order];
  for (let i = 0; i < denominator.length; i++) denominator[i] /= factor;
  const gain = real(params, 'gain') / factor;
  const offset = real(params, 'in_offset');
  if (![...denominator, ...numerator, ...initial, gain, offset].every(Number.isFinite)) {
    fail('coefficients, initial conditions and normalized values must be finite');
  }
  return { numerator, denominator, initial, gain, offset };
}

/** cm_s_xfer uses OLD feedback then cascaded cm_analog_integrate, not an implicit Laplace companion. */
export function sTransferBehavior(model: STransfer): CodeModelBehavior {
  const order = model.initial.length;
  const history = Array.from({ length: 3 }, () => [...model.initial]);
  let length = 0;
  const evaluate = (call: CodeModelCall): number[] => {
    const states = [...model.initial, 0];
    states[order] = model.gain * (call.inputs[0] + model.offset);
    for (let i = 0; i < order; i++) states[order] -= history[0][i] * model.denominator[i];
    if (call.analysis !== 'dc' && call.time !== 0) {
      for (let i = order; i > 0; i--) {
        const integration = call.integration;
        if (integration?.method === 'gear2' && integration.order === 3
          && integration.prevDt !== undefined && integration.prevPrevDt !== undefined && length >= 3) {
          const [a0, a1, a2, a3] = gear3Coefficients(integration.dt, integration.prevDt, integration.prevPrevDt);
          states[i - 1] = (states[i] - a1 * history[0][i - 1] - a2 * history[1][i - 1] - a3 * history[2][i - 1]) / a0;
        } else if (integration?.method === 'gear2' && integration.prevDt !== undefined && length >= 2) {
          const dt = integration.dt;
          const alpha = integration.prevDt / dt;
          const a1 = (2 + alpha) / ((1 + alpha) * dt);
          const a2 = (1 + alpha) / (alpha * dt);
          const a3 = 1 / (alpha * (1 + alpha) * dt);
          states[i - 1] = (states[i] + a2 * history[0][i - 1] - a3 * history[1][i - 1]) / a1;
        } else {
          // ngspice cm_static_integrate is backward Euler even at TRAP order 2.
          states[i - 1] = history[0][i - 1] + call.delta * states[i];
        }
      }
    }
    return states;
  };
  return {
    stateful: true,
    ac: STATIC,
    load(call) {
      const states = evaluate(call);
      call.outputs[0] = model.numerator.reduce((out, b, i) => out + b * states[i], 0);
      // Preserve ngspice's unusual PARTIAL, which is the second integrator value.
      call.partials[0] = states[1];
    },
    accept(call) {
      const states = evaluate(call).slice(0, order);
      history[2] = history[1];
      history[1] = history[0];
      history[0] = states;
      length = Math.min(3, length + 1);
    },
    reset() {
      for (let i = 0; i < 3; i++) history[i] = [...model.initial];
      length = 0;
    },
    truncate(call, truncation: ChargeTruncation) {
      if (call.integration === undefined) return Infinity;
      const integrationOrder = truncation.order ?? (call.integration.method === 'euler' ? 1 : 2);
      if (length < integrationOrder + 1) return Infinity;
      const trial = evaluate(call);
      const { deltas, abstol, reltol, chgtol, trtol } = truncation;
      let bound = Infinity;
      for (let k = 0; k < order; k++) {
        const tolerance = Math.max(
          abstol + reltol * Math.abs(trial[k] - history[0][k]) / deltas[0],
          reltol * Math.max(Math.abs(trial[k]), Math.abs(history[0][k]), chgtol) / deltas[0],
        );
        const diff = [trial[k], history[0][k], history[1][k], history[2][k]];
        const span = [...deltas];
        for (let j: number = integrationOrder; ; j--) {
          for (let i = 0; i <= j; i++) diff[i] = (diff[i] - diff[i + 1]) / span[i];
          if (j === 0) break;
          for (let i = 0; i < j; i++) span[i] = span[i + 1] + deltas[i];
        }
        const factor = (call.integration.method === 'gear2' ? [0.5, 0.2222222222] : [0.5, 0.08333333333])[integrationOrder - 1];
        const estimate = trtol * tolerance / Math.max(abstol, factor * Math.abs(diff[0]));
        bound = Math.min(bound, integrationOrder === 2 ? Math.sqrt(estimate) : estimate);
      }
      return bound;
    },
  };
}

/** Hidden MNA state branches realize the rational AC gain using only G + jωC. */
export class STransferDevice extends XspiceDevice {
  constructor(
    name: string,
    private readonly input: XspiceInputPort,
    private readonly output: XspiceOutputPort,
    private readonly model: STransfer,
    private readonly states: readonly number[],
    warnings: readonly string[],
  ) {
    super(name, 's_xfer', [input], [output], sTransferBehavior(model), warnings);
    this.branches.push(...states);
  }

  override stamp(ctx: StampContext): void {
    super.stamp(ctx);
    for (const branch of this.states) ctx.stampG(ctx.numNodes + branch, ctx.numNodes + branch, 1);
  }

  stampSmallSignal(ctx: StampContext): void {
    const n = ctx.numNodes;
    const add = (row: number, col: number, value: number) => { if (row >= 0 && col >= 0) ctx.stampG(row, col, value); };
    if (this.input.ownBranch !== undefined) {
      const row = n + this.input.ownBranch;
      add(this.input.positive, row, 1); add(this.input.negative, row, -1);
      add(row, this.input.positive, 1); add(row, this.input.negative, -1);
    }
    const last = n + this.states[this.states.length - 1];
    for (let i = 0; i < this.states.length; i++) {
      const row = n + this.states[i];
      if (i + 1 < this.states.length) add(row, n + this.states[i + 1], -1);
      add(last, row, this.model.denominator[i]);
    }
    if (this.input.kind === 'voltage') {
      add(last, this.input.positive, -this.model.gain); add(last, this.input.negative, this.model.gain);
    } else add(last, n + this.input.branch!, -this.model.gain);
    if (this.output.kind === 'voltage') {
      const row = n + this.output.branch!;
      add(this.output.positive, row, 1); add(this.output.negative, row, -1);
      add(row, this.output.positive, 1); add(row, this.output.negative, -1);
      this.model.numerator.forEach((b, i) => add(row, n + this.states[i], -b));
    } else {
      this.model.numerator.forEach((b, i) => {
        add(this.output.positive, n + this.states[i], b); add(this.output.negative, n + this.states[i], -b);
      });
    }
  }

  override stampDynamic = (ctx: StampContext): void => {
    for (const branch of this.states) ctx.stampC(ctx.numNodes + branch, ctx.numNodes + branch, 1);
  };
}
