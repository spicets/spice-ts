import type { ChargeIntegration, ChargeTruncation } from '../device.js';
import type { XspiceConnection } from './connections.js';
import type { XspiceParamValue } from './spec.js';
import { pwlts } from './pwlts.js';

/**
 * One call of a code model function (ngspice cm_<model>(ARGS)). Inputs,
 * outputs, partials and AC gains are flattened over ports in connection
 * order: `partials[out * inputCount + in]` is PARTIAL(out, in).
 */
export interface CodeModelCall {
  /** ngspice ANALYSIS: MIF_DC (operating point, DC sweep, TIME = 0), MIF_TRAN or MIF_AC. */
  readonly analysis: 'dc' | 'tran' | 'ac';
  /** ngspice INIT: first call of this instance. */
  readonly init: boolean;
  /** ngspice TIME; 0 outside transient. */
  readonly time: number;
  /** TIME - T(1): the transient step being solved; 0 outside transient. */
  readonly delta: number;
  /** Integration rule of the transient step (ngspice CKTintegrateMethod/CKTorder/CKTag). */
  readonly integration?: ChargeIntegration;
  /** INPUT values; a model may overwrite them (ngspice pwl limits its input). */
  readonly inputs: Float64Array;
  readonly outputs: Float64Array;
  readonly partials: Float64Array;
  /** ngspice cm_analog_not_converged(). */
  notConverged(): void;
}

/** Netlist values a code model reads at INIT (ngspice cm_netlist_get_c / cm_netlist_get_l). */
export interface XspiceNetlistProbe {
  /** Parallel capacitance on the instance's first port (cm_netlist_get_c). */
  capacitance(): number;
  /** Parallel inductance on the instance's first port (cm_netlist_get_l). */
  inductance(): number;
}

/** What a code model sees of its instance besides parameters. */
export interface XspiceBehaviorContext {
  /** Resolved connections in port-table order; `isNull` marks PORT_NULL. */
  readonly connections: readonly XspiceConnection[];
  readonly netlist: XspiceNetlistProbe;
}

/** How a model's AC gain relates to its DC/TRAN partials. */
export type CodeModelACForm =
  /** AC_GAIN equals the operating-point PARTIAL (gain, summer, mult, divide, pwl, limit). */
  | { readonly kind: 'static' }
  /** AC_GAIN = j * omega * gain (d_dt); optional indices select one pair in a multiport model. */
  | { readonly kind: 'differentiator'; readonly gain: number; readonly input?: number; readonly output?: number }
  /** AC_GAIN = gain / (j * omega) (int). */
  | { readonly kind: 'integrator'; readonly gain: number };

export interface CodeModelBehavior {
  /** ngspice TSTEP/TSTOP, supplied before transient initialization. */
  setTransientTimestep?(timestep: number, stopTime?: number): void;
  /** RAMPTIME configured for transient OP and subsequent transient loads. */
  setRampTime?(time: number): void;
  /** True when the model keeps transient state (cm_analog_alloc). */
  readonly stateful: boolean;
  readonly ac: CodeModelACForm;
  /** Evaluate outputs and partials. Must not change accepted state. */
  load(call: CodeModelCall): void;
  /** Commit the state of a {@link load} made at an accepted timepoint. */
  accept?(call: CodeModelCall): void;
  /** Future analog corners scheduled after accepting this point. */
  breakpoints?(): readonly number[];
  /** ngspice MIFtrunc for this instance at the trial point of `call`. */
  truncate?(call: CodeModelCall, truncation: ChargeTruncation): number;
  /** Forget transient history before a restart at t = 0. */
  reset?(): void;
  /**
   * Accepting the operating point that starts a transient run. Defaults to
   * {@link reset}; a model whose state the operating point itself sets (the
   * hyst leg) keeps it, as dctran.c copies state0 into state1 at MODEINITTRAN.
   */
  beginTransient?(): void;
}

export type ResolvedXspiceParams = ReadonlyMap<string, readonly XspiceParamValue[]>;

export function real(params: ResolvedXspiceParams, name: string, index = 0): number {
  return params.get(name)![index] as number;
}

export function flag(params: ResolvedXspiceParams, name: string): boolean {
  return params.get(name)![0] as boolean;
}

export function reals(params: ResolvedXspiceParams, name: string): number[] {
  return params.get(name)!.map(value => value as number);
}

export const STATIC: CodeModelACForm = { kind: 'static' };

/** ngspice cmutil.c cm_smooth_corner: parabolic blend of two slopes about (x_center, y_center). */
export function smoothCorner(
  x: number,
  xCenter: number,
  yCenter: number,
  domain: number,
  lowerSlope: number,
  upperSlope: number,
): { y: number; dydx: number } {
  const xUpper = xCenter + domain;
  const yUpper = yCenter + upperSlope * domain;
  const a = ((upperSlope - lowerSlope) / 4.0) * (1 / domain);
  const b = upperSlope - 2.0 * a * xUpper;
  const c = yUpper - a * xUpper * xUpper - b * xUpper;
  return { y: a * x * x + b * x + c, dydx: 2.0 * a * x + b };
}

/**
 * The output-limit smoothing shared by ngspice int and d_dt: hard limits
 * outside limit_range, cm_smooth_corner inside it, the partial scaled by the
 * smoothing slope.
 */
function smoothOutputLimits(
  out: number,
  partial: number,
  lower: number,
  upper: number,
  range: number,
): { out: number; partial: number } {
  if (out < lower - range) return { out: lower, partial: 0 };
  if (out < lower + range) {
    const smooth = smoothCorner(out, lower, lower, range, 0.0, 1.0);
    return { out: smooth.y, partial: partial * smooth.dydx };
  }
  if (out > upper + range) return { out: upper, partial: 0 };
  if (out > upper - range) {
    const smooth = smoothCorner(out, upper, upper, range, 1.0, 0.0);
    return { out: smooth.y, partial: partial * smooth.dydx };
  }
  return { out, partial };
}

/** analog/gain/cfunc.mod cm_gain */
function gain(params: ResolvedXspiceParams): CodeModelBehavior {
  const inOffset = real(params, 'in_offset');
  const k = real(params, 'gain');
  const outOffset = real(params, 'out_offset');
  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      outputs[0] = outOffset + k * (inputs[0] + inOffset);
      partials[0] = k;
    },
  };
}

/** analog/summer/cfunc.mod cm_summer */
function summer(params: ResolvedXspiceParams): CodeModelBehavior {
  const inOffset = reals(params, 'in_offset');
  const inGain = reals(params, 'in_gain');
  const outGain = real(params, 'out_gain');
  const outOffset = real(params, 'out_offset');
  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      let accumulate = 0.0;
      for (let i = 0; i < inputs.length; i++) {
        accumulate = accumulate + inGain[i] * (inputs[i] + inOffset[i]);
        partials[i] = inGain[i] * outGain;
      }
      outputs[0] = accumulate * outGain + outOffset;
    },
  };
}

/** analog/mult/cfunc.mod cm_mult */
function mult(params: ResolvedXspiceParams): CodeModelBehavior {
  const inOffset = reals(params, 'in_offset');
  const inGain = reals(params, 'in_gain');
  const outGain = real(params, 'out_gain');
  const outOffset = real(params, 'out_offset');
  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      let accumulateGain = 1.0;
      let accumulateIn = 1.0;
      for (let i = 0; i < inputs.length; i++) {
        accumulateGain = accumulateGain * inGain[i];
        accumulateIn = accumulateIn * (inputs[i] + inOffset[i]);
      }
      for (let i = 0; i < inputs.length; i++) {
        partials[i] = accumulateIn !== 0.0
          ? (accumulateIn / (inputs[i] + inOffset[i])) * accumulateGain * outGain
          : 0.0;
      }
      outputs[0] = accumulateIn * accumulateGain * outGain + outOffset;
    },
  };
}

/** analog/divide/cfunc.mod cm_divide */
function divide(params: ResolvedXspiceParams): CodeModelBehavior {
  const denLowerLimit = real(params, 'den_lower_limit');
  const outGain = real(params, 'out_gain');
  const numGain = real(params, 'num_gain');
  const denGain = real(params, 'den_gain');
  const numOffset = real(params, 'num_offset');
  const denOffset = real(params, 'den_offset');
  const outOffset = real(params, 'out_offset');
  const denDomain = flag(params, 'fraction')
    ? real(params, 'den_domain') * denLowerLimit
    : real(params, 'den_domain');
  const thresholdUpper = denLowerLimit + denDomain;
  const thresholdLower = denLowerLimit - denDomain;
  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      const numerator = (inputs[0] + numOffset) * numGain;
      const denominator = (inputs[1] + denOffset) * denGain;
      let limitedDen: number;
      let denPartial: number;
      if (denominator < thresholdUpper && denominator >= 0) {
        if (denominator > thresholdLower) {
          const smooth = smoothCorner(denominator, denLowerLimit, denLowerLimit, denDomain, 0.0, 1.0);
          limitedDen = smooth.y;
          denPartial = smooth.dydx;
        } else {
          limitedDen = denLowerLimit;
          denPartial = 0.0;
        }
      } else if (denominator > -thresholdUpper && denominator < 0) {
        if (denominator < -thresholdLower) {
          const smooth = smoothCorner(denominator, -denLowerLimit, -denLowerLimit, denDomain, 0.0, 1.0);
          limitedDen = smooth.y;
          denPartial = smooth.dydx;
        } else {
          limitedDen = -denLowerLimit;
          denPartial = 0.0;
        }
      } else {
        limitedDen = denominator;
        denPartial = 1.0;
      }
      outputs[0] = outOffset + outGain * (numerator / limitedDen);
      partials[0] = outGain * numGain / limitedDen;
      partials[1] = -outGain * numerator * denGain * denPartial / (limitedDen * limitedDen);
    },
  };
}

/** analog/limit/cfunc.mod cm_limit */
function limit(params: ResolvedXspiceParams): CodeModelBehavior {
  const lower = real(params, 'out_lower_limit');
  const upper = real(params, 'out_upper_limit');
  const k = real(params, 'gain');
  const inOffset = real(params, 'in_offset');
  const range = flag(params, 'fraction')
    ? real(params, 'limit_range') * (upper - lower)
    : real(params, 'limit_range');
  const thresholdUpper = upper - range;
  const thresholdLower = lower + range;
  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      const out = k * (inOffset + inputs[0]);
      let limited: number;
      let partial: number;
      if (out < thresholdLower) {
        if (out > lower - range) {
          const smooth = smoothCorner(out, lower, lower, range, 0.0, 1.0);
          limited = smooth.y;
          partial = k * smooth.dydx;
        } else {
          limited = lower;
          partial = 0.0;
        }
      } else if (out > thresholdUpper) {
        if (out < upper + range) {
          const smooth = smoothCorner(out, upper, upper, range, 1.0, 0.0);
          limited = smooth.y;
          partial = k * smooth.dydx;
        } else {
          limited = upper;
          partial = 0.0;
        }
      } else {
        limited = out;
        partial = k;
      }
      outputs[0] = limited;
      partials[0] = partial;
    },
  };
}

/** analog/pwl/cfunc.mod: FRACTION and EPSILON of the input limiter. */
const PWL_FRACTION = 0.30;
const PWL_EPSILON = 1.0e-9;

/** analog/pwl/cfunc.mod cm_pwl, including its iteration-to-iteration input limiter. */
function pwl(params: ResolvedXspiceParams): CodeModelBehavior {
  const xArray = reals(params, 'x_array');
  const yArray = reals(params, 'y_array');
  const fraction = flag(params, 'fraction');
  const size = xArray.length + 2;
  const x = new Float64Array(size);
  const y = new Float64Array(size);
  for (let i = 1; i < size - 1; i++) {
    x[i] = xArray[i - 1];
    // ngspice reads y_array[i - 1] for every x point.
    y[i] = yArray[i - 1];
  }
  x[0] = 2 * x[1] - x[2];
  x[size - 1] = 2 * x[size - 2] - x[size - 3];
  if (flag(params, 'limit')) {
    y[0] = y[1];
    y[size - 1] = y[size - 2];
  } else {
    y[0] = 2 * y[1] - y[2];
    y[size - 1] = 2 * y[size - 2] - y[size - 3];
  }
  // ngspice STATIC_VAR(last_x_value): persists across iterations, timepoints and analyses.
  let lastX = 0;
  let initialized = false;

  const limitX = (xLower: number, xUpper: number, input: number, call: CodeModelCall): number => {
    const maxDelta = PWL_FRACTION * (xUpper - xLower);
    if (maxDelta < Math.abs(input - lastX)) {
      lastX = input - lastX >= 0.0 ? lastX + maxDelta : lastX - maxDelta;
      call.notConverged();
      return lastX;
    }
    lastX = input;
    return input;
  };

  return {
    stateful: false,
    ac: STATIC,
    load(call) {
      const { inputs, outputs, partials } = call;
      let input = inputs[0];
      if (!initialized) {
        lastX = input;
        initialized = true;
      }
      if (lastX < x[0]) {
        const test = (x[0] - input) > (x[1] - x[0])
          ? limitX(input, x[0], input, call)
          : limitX(x[0], x[1], input, call);
        if (test >= x[0]) {
          input = lastX = x[0];
          call.notConverged();
        } else {
          input = lastX = test;
        }
      } else if (lastX >= x[size - 1]) {
        const test = (input - x[size - 1]) > (x[size - 1] - x[size - 2])
          ? limitX(x[size - 1], input, input, call)
          : limitX(x[size - 2], x[size - 1], input, call);
        if (test < x[size - 1]) {
          input = lastX = x[size - 1] - PWL_EPSILON;
          call.notConverged();
        } else {
          input = lastX = test;
        }
      } else {
        for (let i = 1; i < size; i++) {
          if (lastX < x[i]) {
            const test = limitX(x[i - 1], x[i], input, call);
            if (test > x[i]) {
              input = lastX = x[i];
              call.notConverged();
            } else if (test < x[i - 1]) {
              input = lastX = x[i - 1] - PWL_EPSILON;
              call.notConverged();
            } else {
              input = lastX = test;
            }
            break;
          }
        }
      }
      inputs[0] = input;

      let out = 0.0;
      let dOutDIn = 0.0;
      if (input <= (x[0] + x[1]) / 2.0) {
        dOutDIn = (y[1] - y[0]) / (x[1] - x[0]);
        out = y[0] + (input - x[0]) * dOutDIn;
      } else if (input >= (x[size - 2] + x[size - 1]) / 2.0) {
        dOutDIn = (y[size - 1] - y[size - 2]) / (x[size - 1] - x[size - 2]);
        out = y[size - 1] + (input - x[size - 1]) * dOutDIn;
      } else {
        for (let i = 1; i < size; i++) {
          if (input < (x[i] + x[i + 1]) / 2.0) {
            const lowerSeg = x[i] - x[i - 1];
            const upperSeg = x[i + 1] - x[i];
            let domain = real(params, 'input_domain');
            if (fraction) domain = domain * (lowerSeg <= upperSeg ? lowerSeg : upperSeg);
            if (input < x[i] - domain) {
              dOutDIn = (y[i] - y[i - 1]) / lowerSeg;
              out = y[i] + (input - x[i]) * dOutDIn;
            } else if (input < x[i] + domain) {
              const smooth = smoothCorner(
                input, x[i], y[i], domain,
                (y[i] - y[i - 1]) / lowerSeg, (y[i + 1] - y[i]) / upperSeg,
              );
              out = smooth.y;
              dOutDIn = smooth.dydx;
            } else {
              dOutDIn = (y[i + 1] - y[i]) / upperSeg;
              out = y[i] + (input - x[i]) * dOutDIn;
            }
            break;
          }
        }
      }
      outputs[0] = out;
      partials[0] = dOutDIn;
    },
  };
}

/** ngspice miftrunc.c MIFterr coefficients, indexed by integration order - 1. */
const TRAP_COEFFICIENTS = [0.5, 0.08333333333];
const GEAR_COEFFICIENTS = [0.5, 0.2222222222];

/**
 * analog/int/cfunc.mod cm_int with cm_analog_integrate (cm.c
 * cm_static_integrate) and MIFtrunc. Under TRAP, ngspice's integrate gives
 * y(n+1) = y(n) + h * x(n+1) at both orders (its order-2 branch halves ag[0]
 * and uses -ag[0]/2 * y(n)); GEAR uses the BDF coefficients. As in ngspice,
 * PARTIAL(out, in) is the integrator's dy/dx without the gain factor.
 */
function integrator(params: ResolvedXspiceParams): CodeModelBehavior {
  const inOffset = real(params, 'in_offset');
  const k = real(params, 'gain');
  const lower = real(params, 'out_lower_limit');
  const upper = real(params, 'out_upper_limit');
  const range = real(params, 'limit_range');
  const outIc = real(params, 'out_ic');
  // Accepted integral states, newest first: y(n), y(n-1), y(n-2) (ngspice CKTstates[1..3]).
  const history = [0, 0, 0];
  let historyLength = 0;

  const integrate = (call: CodeModelCall): { out: number; partial: number } => {
    const integrand = k * (call.inputs[0] + inOffset);
    const integration = call.integration;
    if (
      integration?.method === 'gear2' && integration.prevDt !== undefined && historyLength >= 2
    ) {
      const dt = integration.dt;
      const alpha = integration.prevDt / dt;
      const a1 = (2 + alpha) / ((1 + alpha) * dt);
      const a2 = (1 + alpha) / (alpha * dt);
      const a3 = 1 / (alpha * (1 + alpha) * dt);
      return { out: (integrand + a2 * history[0] - a3 * history[1]) / a1, partial: 1 / a1 };
    }
    return { out: history[0] + call.delta * integrand, partial: call.delta };
  };

  const evaluate = (call: CodeModelCall): { out: number; partial: number } => {
    const raw = call.analysis === 'dc' || call.time === 0
      ? { out: outIc, partial: 0.0 }
      : integrate(call);
    return smoothOutputLimits(raw.out, raw.partial, lower, upper, range);
  };

  return {
    stateful: true,
    ac: { kind: 'integrator', gain: k },
    load(call) {
      const { out, partial } = evaluate(call);
      call.outputs[0] = out;
      call.partials[0] = partial;
    },
    accept(call) {
      const { out } = evaluate(call);
      history[2] = history[1];
      history[1] = history[0];
      history[0] = out;
      historyLength = Math.min(historyLength + 1, 3);
    },
    truncate(call, truncation) {
      if (call.analysis !== 'tran' || call.integration === undefined) return Infinity;
      const order = truncation.order ?? (call.integration.method === 'euler' ? 1 : 2);
      if (historyLength < order + 1) return Infinity;
      const { deltas, reltol, abstol, chgtol, trtol } = truncation;
      const delta = deltas[0];
      const trial = evaluate(call).out;
      const voltTolerance = abstol + reltol * Math.abs(trial - history[0]) / delta;
      const chargeTolerance = reltol * Math.max(Math.abs(trial), Math.abs(history[0]), chgtol) / delta;
      const tolerance = Math.max(voltTolerance, chargeTolerance);
      const diff = [trial, history[0], history[1], history[2]];
      const span = [deltas[0], deltas[1], deltas[2]];
      for (let j: number = order; ; j--) {
        for (let i = 0; i <= j; i++) diff[i] = (diff[i] - diff[i + 1]) / span[i];
        if (j === 0) break;
        for (let i = 0; i < j; i++) span[i] = span[i + 1] + deltas[i];
      }
      const factor = (call.integration.method === 'gear2' ? GEAR_COEFFICIENTS : TRAP_COEFFICIENTS)[order - 1];
      const bound = trtol * tolerance / Math.max(abstol, factor * Math.abs(diff[0]));
      return order === 2 ? Math.sqrt(bound) : bound;
    },
    reset() {
      history.fill(0);
      historyLength = 0;
    },
  };
}

/**
 * analog/d_dt/cfunc.mod cm_d_dt: a backward difference over the accepted
 * input. Its cm_analog_integrate call passes a stack variable, which ngspice
 * rejects ("Argument must be in state vector 0"), so it never limits the step.
 */
function differentiator(params: ResolvedXspiceParams): CodeModelBehavior {
  const k = real(params, 'gain');
  const outOffset = real(params, 'out_offset');
  const lower = real(params, 'out_lower_limit');
  const upper = real(params, 'out_upper_limit');
  const range = real(params, 'limit_range');
  let acceptedInput = 0;

  return {
    stateful: true,
    ac: { kind: 'differentiator', gain: k },
    load({ analysis, time, delta, inputs, outputs, partials }) {
      const raw = analysis === 'dc' || time === 0
        ? { out: 0.0, partial: 0.0 }
        : { out: k * (inputs[0] - acceptedInput) / delta + outOffset, partial: k / delta };
      const { out, partial } = smoothOutputLimits(raw.out, raw.partial, lower, upper, range);
      outputs[0] = out;
      partials[0] = partial;
    },
    accept({ inputs }) {
      acceptedInput = inputs[0];
    },
    reset() {
      acceptedInput = 0;
    },
  };
}

export type BehaviorFactory = (params: ResolvedXspiceParams, context: XspiceBehaviorContext) => CodeModelBehavior;

/** Code model behaviors keyed by lower-case ngspice Spice_Model_Name. */
export const XSPICE_BEHAVIORS: ReadonlyMap<string, BehaviorFactory> = new Map<string, BehaviorFactory>([
  ['gain', gain],
  ['summer', summer],
  ['mult', mult],
  ['divide', divide],
  ['pwl', pwl],
  ['pwlts', pwlts],
  ['limit', limit],
  ['int', integrator],
  ['d_dt', differentiator],
]);
