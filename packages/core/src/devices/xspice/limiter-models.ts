/**
 * ngspice-47 XSPICE code models of the analog_models3 group (climit, ilimit,
 * hyst), slew, and the xtradev cmeter/lmeter, transcribed from
 * src/xspice/icm/{analog,xtradev}/<model>/cfunc.mod.
 */
import {
  flag, real, smoothCorner, STATIC,
  type CodeModelBehavior, type CodeModelCall, type ResolvedXspiceParams, type XspiceBehaviorContext,
} from './models.js';

/** Flat input/output indices of each non-null connection (first port), in MIFload order. */
export interface PortIndices {
  readonly input: ReadonlyMap<string, number>;
  readonly output: ReadonlyMap<string, number>;
  readonly inputCount: number;
}

export function portIndices(context: XspiceBehaviorContext): PortIndices {
  const input = new Map<string, number>();
  const output = new Map<string, number>();
  let inputs = 0;
  let outputs = 0;
  for (const connection of context.connections) {
    if (connection.isNull) continue;
    if (connection.direction !== 'out') {
      input.set(connection.name, inputs);
      inputs += connection.ports.length;
    }
    if (connection.direction !== 'in') {
      output.set(connection.name, outputs);
      outputs += connection.ports.length;
    }
  }
  return { input, output, inputCount: inputs };
}

/** ngspice cmutil.c cm_smooth_discontinuity: a smoothed step from (x_lower, y_lower) to (x_upper, y_upper). */
export function smoothDiscontinuity(
  x: number,
  xLower: number,
  yLower: number,
  xUpper: number,
  yUpper: number,
): { y: number; dydx: number } {
  const xCenter = (xUpper + xLower) / 2.0;
  const yCenter = (yUpper + yLower) / 2.0;
  const centerSlope = 2.0 * (yUpper - yLower) / (xUpper - xLower);
  if (x < xLower) return { y: yLower, dydx: 0.0 };
  if (x < xCenter) {
    const a = centerSlope / (xUpper - xLower);
    const b = centerSlope - 2.0 * a * xCenter;
    const c = yCenter - a * xCenter * xCenter - b * xCenter;
    return { y: a * x * x + b * x + c, dydx: 2.0 * a * x + b };
  }
  if (x < xUpper) {
    const a = -centerSlope / (xUpper - xLower);
    const b = -2.0 * a * xUpper;
    const c = yUpper - a * xUpper * xUpper - b * xUpper;
    return { y: a * x * x + b * x + c, dydx: 2.0 * a * x + b };
  }
  return { y: yUpper, dydx: 0.0 };
}

interface ClimitResult {
  out: number;
  pIn: number;
  pLower: number;
  pUpper: number;
}

/**
 * The limiting core of cm_climit and cmutil.c cm_climit_fcn. ngspice's
 * cm_climit returns a zero output when the linear range is negative
 * (`returnZeroOnEmptyRange`); cm_climit_fcn only prints the error and limits anyway.
 */
function climitCore(
  input: number,
  inOffset: number,
  cntlUpper: number,
  cntlLower: number,
  lowerDelta: number,
  upperDelta: number,
  limitRangeParam: number,
  gain: number,
  fraction: boolean,
  returnZeroOnEmptyRange: boolean,
): ClimitResult {
  const outLowerLimit = cntlLower + lowerDelta;
  const outUpperLimit = cntlUpper - upperDelta;
  const limitRange = fraction ? limitRangeParam * (outUpperLimit - outLowerLimit) : limitRangeParam;
  const thresholdUpper = outUpperLimit - limitRange;
  const thresholdLower = outLowerLimit + limitRange;
  if (thresholdUpper - thresholdLower < 0.0 && returnZeroOnEmptyRange) {
    return { out: 0.0, pIn: 0.0, pLower: 0.0, pUpper: 0.0 };
  }
  const out = gain * (inOffset + input);
  if (out < thresholdLower) {
    if (out > outLowerLimit - limitRange) {
      const smooth = smoothCorner(out, outLowerLimit, outLowerLimit, limitRange, 0.0, 1.0);
      const lower = smoothDiscontinuity(out, outLowerLimit, 1.0, thresholdLower, 0.0);
      return { out: smooth.y, pIn: gain * smooth.dydx, pLower: lower.y, pUpper: 0.0 };
    }
    return { out: outLowerLimit, pIn: 0.0, pLower: 1.0, pUpper: 0.0 };
  }
  if (out > thresholdUpper) {
    if (out < outUpperLimit + limitRange) {
      const smooth = smoothCorner(out, outUpperLimit, outUpperLimit, limitRange, 1.0, 0.0);
      const upper = smoothDiscontinuity(out, thresholdUpper, 0.0, outUpperLimit, 1.0);
      return { out: smooth.y, pIn: gain * smooth.dydx, pLower: 0.0, pUpper: upper.y };
    }
    return { out: outUpperLimit, pIn: 0.0, pLower: 0.0, pUpper: 1.0 };
  }
  return { out, pIn: gain, pLower: 0.0, pUpper: 0.0 };
}

/** analog/climit/cfunc.mod cm_climit: inputs in, cntl_upper, cntl_lower. */
function climit(params: ResolvedXspiceParams): CodeModelBehavior {
  const inOffset = real(params, 'in_offset');
  const gain = real(params, 'gain');
  const upperDelta = real(params, 'upper_delta');
  const lowerDelta = real(params, 'lower_delta');
  const limitRange = real(params, 'limit_range');
  const fraction = flag(params, 'fraction');
  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      const result = climitCore(
        inputs[0], inOffset, inputs[1], inputs[2], lowerDelta, upperDelta, limitRange, gain, fraction, true,
      );
      outputs[0] = result.out;
      partials[0] = result.pIn;
      partials[1] = result.pUpper;
      partials[2] = result.pLower;
    },
  };
}

/**
 * analog/ilimit/cfunc.mod cm_ilimit: a current-limited output stage whose
 * supply current flows through the `%g` power ports. Null power ports read
 * +-1e6 V and get no output (PORT_NULL).
 */
function ilimit(params: ResolvedXspiceParams, context: XspiceBehaviorContext): CodeModelBehavior {
  const inOffset = real(params, 'in_offset');
  const gain = real(params, 'gain');
  const rOutSource = real(params, 'r_out_source');
  const rOutSink = real(params, 'r_out_sink');
  const iLimitSource = real(params, 'i_limit_source');
  const iLimitSink = real(params, 'i_limit_sink');
  const vPwrRange = real(params, 'v_pwr_range');
  const iSourceRange = real(params, 'i_source_range');
  const iSinkRange = real(params, 'i_sink_range');
  const rOutDomain = real(params, 'r_out_domain');
  const ports = portIndices(context);
  const n = ports.inputCount;
  const inIn = ports.input.get('in')!;
  const inPos = ports.input.get('pos_pwr');
  const inNeg = ports.input.get('neg_pwr');
  const inOut = ports.input.get('out')!;
  const outPos = ports.output.get('pos_pwr');
  const outNeg = ports.output.get('neg_pwr');
  const outOut = ports.output.get('out')!;

  return {
    stateful: false,
    ac: STATIC,
    load({ init, inputs, outputs, partials }) {
      const vout = inputs[inOut];
      const posPwrIn = inPos === undefined ? 1.0e6 : inputs[inPos];
      const negPwrIn = inNeg === undefined ? -1.0e6 : inputs[inNeg];

      let veq: number;
      let pveqPvin: number;
      let pveqPvpos: number;
      let pveqPvneg: number;
      if (!init) {
        const eq = climitCore(
          inputs[inIn], inOffset, posPwrIn, negPwrIn, 0.0, 0.0, vPwrRange, gain, false, false,
        );
        veq = eq.out;
        pveqPvin = eq.pIn;
        pveqPvneg = eq.pLower;
        pveqPvpos = eq.pUpper;
      } else {
        veq = (posPwrIn - negPwrIn) / 2.0;
        pveqPvin = 0.0;
        pveqPvpos = 0.0;
        pveqPvneg = 0.0;
      }

      let rOut: number;
      let prOutPx: number;
      if (rOutSource === rOutSink) {
        rOut = rOutSource;
        prOutPx = 0.0;
      } else {
        const smooth = smoothDiscontinuity(veq - vout, -rOutDomain, rOutSink, rOutDomain, rOutSource);
        rOut = smooth.y;
        prOutPx = smooth.dydx;
      }

      const iThresholdLower = -iLimitSink + iSinkRange;
      const iThresholdUpper = iLimitSource - iSourceRange;
      let iOut = (veq - vout) / rOut;
      let piOutPvin = pveqPvin / rOut - veq * prOutPx * pveqPvin / (rOut * rOut);
      let piOutPvout = -1.0 / rOut - vout * prOutPx / (rOut * rOut);
      let piOutPposPwr = pveqPvpos / rOut - veq * prOutPx * pveqPvpos / (rOut * rOut);
      let piOutPnegPwr = pveqPvneg / rOut - veq * prOutPx * pveqPvneg / (rOut * rOut);

      let iPosPwr = 0.0;
      let piPosPvin = 0.0;
      let piPosPvneg = 0.0;
      let piPosPvpos = 0.0;
      let piPosPvout = 0.0;
      let iNegPwr = 0.0;
      let piNegPvin = 0.0;
      let piNegPvneg = 0.0;
      let piNegPvpos = 0.0;
      let piNegPvout = 0.0;

      if (iOut < 0.0) {
        if (iOut < iThresholdLower) {
          if (iOut < -iLimitSink - iSinkRange) {
            iOut = -iLimitSink;
            iNegPwr = -iOut;
            piOutPvin = 0.0;
            piOutPvout = 0.0;
            piOutPposPwr = 0.0;
            piOutPnegPwr = 0.0;
          } else {
            const smooth = smoothCorner(iOut, -iLimitSink, -iLimitSink, iSinkRange, 0.0, 1.0);
            iOut = smooth.y;
            piOutPvin *= smooth.dydx;
            piOutPvout *= smooth.dydx;
            piOutPposPwr *= smooth.dydx;
            piOutPnegPwr *= smooth.dydx;
            iNegPwr = -iOut;
            piNegPvin = -piOutPvin;
            piNegPvneg = -piOutPnegPwr;
            piNegPvpos = -piOutPposPwr;
            piNegPvout = -piOutPvout;
          }
        } else if (iOut > -2.0 * iSinkRange) {
          const smooth = smoothCorner(iOut, -iSinkRange, 0.0, iSinkRange, 1.0, 0.0);
          iNegPwr = -smooth.y;
          piNegPvin = -piOutPvin * smooth.dydx;
          piNegPvneg = -piOutPnegPwr * smooth.dydx;
          piNegPvpos = -piOutPposPwr * smooth.dydx;
          piNegPvout = -piOutPvout * smooth.dydx;
        } else {
          iNegPwr = -iOut;
          piNegPvin = -piOutPvin;
          piNegPvneg = -piOutPnegPwr;
          piNegPvpos = -piOutPposPwr;
          piNegPvout = -piOutPvout;
        }
      } else if (iOut > iThresholdUpper) {
        if (iOut > iLimitSource + iSourceRange) {
          iOut = iLimitSource;
          iPosPwr = -iOut;
          piOutPvin = 0.0;
          piOutPvout = 0.0;
          piOutPposPwr = 0.0;
          piOutPnegPwr = 0.0;
        } else {
          // ngspice passes i_sink_range as the source-side smoothing domain.
          const smooth = smoothCorner(iOut, iLimitSource, iLimitSource, iSinkRange, 1.0, 0.0);
          iOut = smooth.y;
          piOutPvin *= smooth.dydx;
          piOutPvout *= smooth.dydx;
          piOutPposPwr *= smooth.dydx;
          piOutPnegPwr *= smooth.dydx;
          iPosPwr = -iOut;
          piPosPvin = -piOutPvin;
          piPosPvneg = -piOutPnegPwr;
          piPosPvpos = -piOutPposPwr;
          piPosPvout = -piOutPvout;
        }
      } else if (iOut < 2.0 * iSourceRange) {
        const smooth = smoothCorner(iOut, iSourceRange, 0.0, iSourceRange, 0.0, 1.0);
        iPosPwr = -smooth.y;
        piPosPvin = -piOutPvin * smooth.dydx;
        piPosPvneg = -piOutPnegPwr * smooth.dydx;
        piPosPvpos = -piOutPposPwr * smooth.dydx;
        piPosPvout = -piOutPvout * smooth.dydx;
      } else {
        iPosPwr = -iOut;
        piPosPvin = -piOutPvin;
        piPosPvneg = -piOutPnegPwr;
        piPosPvpos = -piOutPposPwr;
        piPosPvout = -piOutPvout;
      }

      outputs[outOut] = -iOut;
      partials[outOut * n + inIn] = -piOutPvin;
      partials[outOut * n + inOut] = -piOutPvout;
      if (outNeg !== undefined && inNeg !== undefined) {
        outputs[outNeg] = -iNegPwr;
        partials[outNeg * n + inIn] = -piNegPvin;
        partials[outNeg * n + inOut] = -piNegPvout;
        if (inPos !== undefined) partials[outNeg * n + inPos] = -piNegPvpos;
        partials[outNeg * n + inNeg] = -piNegPvneg;
        partials[outOut * n + inNeg] = -piOutPnegPwr;
      }
      if (outPos !== undefined && inPos !== undefined) {
        outputs[outPos] = -iPosPwr;
        partials[outPos * n + inIn] = -piPosPvin;
        partials[outPos * n + inOut] = -piPosPvout;
        partials[outPos * n + inPos] = -piPosPvpos;
        if (inNeg !== undefined) partials[outPos * n + inNeg] = -piPosPvneg;
        partials[outOut * n + inPos] = -piOutPposPwr;
      }
    },
  };
}

/** hyst/cfunc.mod: TRUE (X_RISING) is the lower leg of the hysteresis loop. */
const X_RISING = true;
const X_FALLING = false;

/**
 * analog/hyst/cfunc.mod cm_hyst. The leg is a cm_analog_alloc state: a
 * transient load starts from the leg accepted at the last timepoint and
 * {@link CodeModelBehavior.accept} commits the leg of the accepted load. In
 * DC the leg carries from load to load, as ngspice's dctrcurv.c rotates the
 * state vectors from one sweep point to the next. INIT picks the leg from
 * the input of the first call (the operating point's first iteration), and
 * the transient starts from the leg the operating point converged on.
 */
export function hyst(params: ResolvedXspiceParams): CodeModelBehavior {
  const inLow = real(params, 'in_low');
  const inHigh = real(params, 'in_high');
  const hysteresis = real(params, 'hyst');
  const outLowerLimit = real(params, 'out_lower_limit');
  const outUpperLimit = real(params, 'out_upper_limit');
  const slope = (outUpperLimit - outLowerLimit) / (inHigh - inLow);
  const xRiseLinear = inLow + hysteresis;
  const xRiseZero = inHigh + hysteresis;
  const xFallLinear = inHigh - hysteresis;
  const xFallZero = inLow - hysteresis;
  const inputDomain = flag(params, 'fraction')
    ? real(params, 'input_domain') * (inHigh - inLow)
    : real(params, 'input_domain');
  let committed: boolean | undefined;

  const evaluate = (input: number, oldState: boolean): { out: number; partial: number; state: boolean } => {
    let state = oldState;
    let out: number;
    let partial: number;
    if (oldState === X_RISING) {
      if (input <= xRiseLinear - inputDomain) {
        out = outLowerLimit;
        partial = 0.0;
      } else if (input <= xRiseLinear + inputDomain) {
        ({ y: out, dydx: partial } = smoothCorner(input, xRiseLinear, outLowerLimit, inputDomain, 0.0, slope));
      } else if (input <= xRiseZero - inputDomain) {
        out = (input - xRiseLinear) * slope + outLowerLimit;
        partial = slope;
      } else if (input <= xRiseZero + inputDomain) {
        ({ y: out, dydx: partial } = smoothCorner(input, xRiseZero, outUpperLimit, inputDomain, slope, 0.0));
      } else {
        out = outUpperLimit;
        partial = 0.0;
        state = X_FALLING;
      }
    } else if (input >= xFallLinear + inputDomain) {
      out = outUpperLimit;
      partial = 0.0;
    } else if (input >= xFallLinear - inputDomain) {
      ({ y: out, dydx: partial } = smoothCorner(input, xFallLinear, outUpperLimit, inputDomain, slope, 0.0));
    } else if (input >= xFallZero + inputDomain) {
      out = (input - xFallZero) * slope + outLowerLimit;
      partial = slope;
    } else if (input >= xFallZero - inputDomain) {
      ({ y: out, dydx: partial } = smoothCorner(input, xFallZero, outLowerLimit, inputDomain, 0.0, slope));
    } else {
      out = outLowerLimit;
      partial = 0.0;
      state = X_RISING;
    }
    return { out, partial, state };
  };

  const run = (call: CodeModelCall): boolean => {
    const input = call.inputs[0];
    committed ??= input < xRiseZero + inputDomain ? X_RISING : X_FALLING;
    const { out, partial, state } = evaluate(input, committed);
    call.outputs[0] = out;
    call.partials[0] = partial;
    return state;
  };

  return {
    stateful: false,
    ac: STATIC,
    load(call) {
      const state = run(call);
      if (call.analysis === 'dc') committed = state;
    },
    accept(call) {
      committed = run(call);
    },
    reset() {
      committed = undefined;
    },
    beginTransient() {
      // Keep the operating point's leg; INIT does not run again.
    },
  };
}

/**
 * analog/slew/cfunc.mod cm_slew: the output follows the input at most at
 * rise_slope / fall_slope, from the input and output accepted at T(1).
 */
function slew(params: ResolvedXspiceParams): CodeModelBehavior {
  const slopeRise = real(params, 'rise_slope');
  const slopeFall = real(params, 'fall_slope');
  let inOld = 0;
  let outOld = 0;

  const evaluate = (call: CodeModelCall): void => {
    const input = call.inputs[0];
    if (call.analysis === 'dc' || call.time === 0) {
      call.outputs[0] = input;
      call.partials[0] = 1.0;
      return;
    }
    const delta = call.delta;
    const slope = (input - inOld) / delta;
    let outs: number;
    let partial: number;
    if (slope >= 0) {
      const outSlew = outOld + slopeRise * delta;
      if (input < outOld - slopeFall * delta) {
        outs = outOld - slopeFall * delta;
        partial = 0;
      } else if (slope > slopeRise || (slope < slopeRise && outSlew <= input)) {
        outs = outSlew;
        partial = 0;
      } else {
        outs = input;
        partial = 1;
      }
    } else {
      const outSlew = outOld - slopeFall * delta;
      if (input > outOld + slopeRise * delta) {
        outs = outOld + slopeRise * delta;
        partial = 0;
      } else if (-slope > slopeFall || (-slope < slopeFall && outSlew > input)) {
        outs = outSlew;
        partial = 0;
      } else {
        outs = input;
        partial = 1;
      }
    }
    call.outputs[0] = outs;
    call.partials[0] = partial;
  };

  return {
    stateful: false,
    ac: STATIC,
    load: evaluate,
    accept(call) {
      evaluate(call);
      inOld = call.inputs[0];
      outOld = call.outputs[0];
    },
    reset() {
      inOld = 0;
      outOld = 0;
    },
  };
}

/**
 * xtradev cmeter/lmeter: OUTPUT = gain * the netlist capacitance
 * (inductance) on the input node, read once at INIT (STATIC_VAR).
 */
function meter(read: (context: XspiceBehaviorContext) => number) {
  return (params: ResolvedXspiceParams, context: XspiceBehaviorContext): CodeModelBehavior => {
    const gain = real(params, 'gain');
    let value: number | undefined;
    return {
      stateful: false,
      ac: STATIC,
      load({ outputs }) {
        value ??= read(context);
        outputs[0] = gain * value;
      },
    };
  };
}

export const LIMITER_BEHAVIORS = new Map([
  ['climit', climit],
  ['ilimit', ilimit],
  ['hyst', hyst],
  ['slew', slew],
  ['cmeter', meter(context => context.netlist.capacitance())],
  ['lmeter', meter(context => context.netlist.inductance())],
] as const);
