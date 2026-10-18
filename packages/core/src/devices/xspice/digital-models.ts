/**
 * ngspice-47 XSPICE digital code models and node bridges, transcribed from
 * src/xspice/icm/digital/{d_buffer,d_inverter,d_and,d_nand,d_or,d_nor,d_xor,
 * d_xnor,d_pulldown,d_pullup,adc_bridge,dac_bridge}/cfunc.mod.
 *
 * The gates and the adc_bridge output side are event-driven
 * ({@link EventBehavior}); the adc_bridge input and dac_bridge output sides
 * are analog code model halves ({@link CodeModelBehavior}) that share the
 * instance's event state through an {@link EventInstanceView}.
 */
import {
  ONE, RESISTIVE, STRONG, UNKNOWN, ZERO,
  type EventBehavior, type EventCall, type EventInstanceView,
} from './event-network.js';
import { flag, real, STATIC, type CodeModelBehavior, type CodeModelCall, type ResolvedXspiceParams } from './models.js';
import type { XspiceConnection } from './connections.js';
import { flipFlop } from './flipflop-models.js';
import { controlledOscillator } from './dosc-pwm-models.js';
import { tristate } from './d-tristate.js';
import { bidiBridge } from './bidi-bridge.js';

/** What a digital model factory sees of its instance besides parameters. */
export interface DigitalModelContext {
  readonly connections: readonly XspiceConnection[];
  /** Parameters given on the `.model` card (ngspice !PARAM_NULL). */
  readonly given: ReadonlySet<string>;
}

/** A digital code model: its event half and, for a hybrid, the factory of its analog half. */
export interface DigitalModel<S> {
  readonly event: EventBehavior<S>;
  readonly analog?: (view: EventInstanceView<S>) => CodeModelBehavior;
}

export type DigitalModelFactory = (params: ResolvedXspiceParams, context: DigitalModelContext) => DigitalModel<unknown>;

/**
 * digital/d_pulldown and d_pullup/cfunc.mod: LOAD(out), constant resistive output.
 * Public Domain source at ngspice-47 a80f6e3e95d51534905b1f23410a951802666656:
 * https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/
 */
function pull(value: number): DigitalModelFactory {
  return params => ({
    event: {
      createState: () => null,
      event(call) {
        const out = call.outputs[0];
        out.load = real(params, 'load');
        out.state = value;
        out.strength = RESISTIVE;
      },
    },
  });
}

function portCount(context: DigitalModelContext, name: string): number {
  return context.connections.find(connection => connection.name === name)!.ports.length;
}

/** cmutil.c cm_toggle_bit: 0 and 1 swap; U stays. */
function toggle(state: number): number {
  return state === ZERO ? ONE : state === ONE ? ZERO : state;
}

/** Gate output state from its input states (the "Calculate new output value" block of each cfunc.mod). */
type GateFunction = (inputs: readonly number[]) => number;

const buffer: GateFunction = ([value]) => value;
const inverter: GateFunction = ([value]) => (value === UNKNOWN ? UNKNOWN : toggle(value));

/** d_and/d_nand/d_or/d_nor: `dominant` input forces `forced`; otherwise `idle`, or U when any input is U. */
function dominantGate(dominant: number, forced: number, idle: number): GateFunction {
  return inputs => {
    let value = idle;
    for (const input of inputs) {
      if (input === dominant) return forced;
      if (input === UNKNOWN) value = UNKNOWN;
    }
    return value;
  };
}

/** d_xor/d_xnor: toggle per ONE input from `start`; any U input gives U. */
function parityGate(start: number): GateFunction {
  return inputs => {
    let value = start;
    for (const input of inputs) {
      if (input === ONE) value = toggle(value);
      else if (input === UNKNOWN) return UNKNOWN;
    }
    return value;
  };
}

/** Gate state: the last output (tag 0) and the inertial-delay bookkeeping (tag 1, struct idata). */
interface GateState {
  out: number;
  when: number;
  prev: number;
}

/**
 * The output logic every ngspice-47 gate shares: post a change with
 * rise_delay/fall_delay (an U output takes the delay of the edge it leaves),
 * and with inertial_delay=true cancel a pending change that a later one
 * overrides (cm_is_inertial: only when the parameter is given as true, as
 * the `digital_delay_type` variable is unset).
 */
function gate(compute: GateFunction): DigitalModelFactory {
  return (params, context) => {
    const riseDelay = real(params, 'rise_delay');
    const fallDelay = real(params, 'fall_delay');
    const inertial = context.given.has('inertial_delay') && flag(params, 'inertial_delay');
    const inputCount = portCount(context, 'in');
    const inputs = new Array<number>(inputCount);
    const event: EventBehavior<GateState> = {
      createState: () => ({ out: UNKNOWN + 1, when: -1, prev: ZERO }),
      event(call: EventCall<GateState>) {
        const state = call.state;
        for (let i = 0; i < inputCount; i++) inputs[i] = call.inputState(i);
        const value = compute(inputs);
        const out = call.outputs[0];
        if (value === state.out) {
          out.changed = false;
          return;
        }
        if (value === ZERO) out.delay = fallDelay;
        else if (value === ONE) out.delay = riseDelay;
        else out.delay = state.out === ZERO ? riseDelay : fallDelay;
        if (inertial && call.analysis === 'tran') {
          if (state.when <= call.time) {
            // Normal transition.
            state.prev = state.out;
            state.when = call.time + out.delay;
          } else if (value !== state.prev) {
            // Third value: cancel the earlier change and output as usual.
            call.scheduleOutput(0, (state.when - call.time) / 2.0, { state: state.prev, strength: STRONG });
            if (value === UNKNOWN) out.delay = state.prev === ZERO ? riseDelay : fallDelay;
            state.when = call.time + out.delay;
          } else {
            // Changing back: override the pending change.
            out.delay = (state.when - call.time) / 2.0;
            state.when = -1.0;
          }
        }
        state.out = value;
        out.state = value;
        out.strength = STRONG;
      },
    };
    return { event } as DigitalModel<unknown>;
  };
}

/** adc_bridge get_out_value: thresholds, or a Schmitt trigger when in_low > in_high. */
function adcLevel(input: number, low: number, high: number): number {
  if (low <= high) {
    if (input >= high) return ONE;
    if (input <= low) return ZERO;
  } else {
    if (input >= low) return ONE;
    if (input <= high) return ZERO;
  }
  return UNKNOWN;
}

interface AdcState {
  out: number[];
}

/**
 * digital/adc_bridge: an ANALOG call queues an event call at TIME when any
 * output would change; the EVENT call posts the new states with
 * rise_delay/fall_delay. A single analog input with several outputs is a
 * multi-bit converter.
 */
const adcBridge: DigitalModelFactory = (params, context) => {
  const inLow = real(params, 'in_low');
  const inHigh = real(params, 'in_high');
  const riseDelay = real(params, 'rise_delay');
  const fallDelay = real(params, 'fall_delay');
  const sizeIn = portCount(context, 'in');
  const sizeOut = portCount(context, 'out');
  const multiBit = sizeIn !== sizeOut && sizeIn === 1;
  const size = Math.min(sizeIn, sizeOut);
  let view: EventInstanceView<AdcState> | undefined;

  /** Each bit's state from the analog inputs, MSB first for the multi-bit converter. */
  const levels = (inputs: readonly number[]): number[] => {
    if (multiBit) {
      let x = (inputs[0] - inLow) / (inHigh - inLow);
      const bits: number[] = [];
      for (let i = 0; i < sizeOut; i++) {
        const bit = x >= 0.5 ? ONE : ZERO;
        bits.push(bit);
        if (bit === ONE) x -= 0.5;
        x *= 2.0;
      }
      return bits;
    }
    return Array.from({ length: size }, (_, i) => adcLevel(inputs[i], inLow, inHigh));
  };

  const event: EventBehavior<AdcState> = {
    createState: () => ({ out: new Array<number>(sizeOut).fill(UNKNOWN + 1) }),
    event(call) {
      // INIT only allocates the state (every out[i] = UNKNOWN + 1 forces the first output).
      if (call.init) return;
      const out = call.state.out;
      const test = levels(view!.analogInputs);
      for (let i = 0; i < test.length; i++) {
        const output = call.outputs[i];
        if (test[i] === out[i]) {
          output.changed = false;
          continue;
        }
        if (multiBit) {
          output.delay = test[i] === ZERO ? fallDelay : riseDelay;
          out[i] = test[i];
          output.state = test[i];
          output.strength = STRONG;
          continue;
        }
        output.state = test[i];
        if (test[i] === ZERO) {
          output.delay = fallDelay;
        } else if (test[i] === ONE) {
          output.delay = riseDelay;
        } else {
          if (inLow > inHigh) {
            // Input in the hysteresis band.
            output.changed = false;
            continue;
          }
          output.delay = out[i] === ZERO ? riseDelay : fallDelay;
        }
        out[i] = test[i];
        output.strength = STRONG;
      }
    },
  };

  const analog = (eventView: EventInstanceView<AdcState>): CodeModelBehavior => {
    view = eventView;
    return {
      stateful: false,
      ac: STATIC,
      load(call: CodeModelCall) {
        eventView.setAnalogInputs(call.inputs);
        if (!eventView.initialized) return;
        const out = eventView.state.out;
        const test = levels(eventView.analogInputs);
        // ANALOG call: request an event call at TIME on the first bit that would change.
        if (test.some((bit, i) => bit !== out[i])) eventView.queue(call.time);
      },
    };
  };
  return { event, analog } as DigitalModel<unknown>;
};

interface DacState {
  in: { i: number; changed: number }[];
}

/**
 * digital/dac_bridge: each output ramps to out_low/out_high/out_undef at
 * t_rise/t_fall from its value at T(1). An EVENT call that sees an input
 * change sets a breakpoint at TIME and records when it happened; the next
 * ANALOG call splits the step at that time and sets a breakpoint where the
 * ramp ends. Several inputs into one output form a multi-bit converter.
 */
const dacBridge: DigitalModelFactory = (params, context) => {
  const outLow = real(params, 'out_low');
  const outHigh = real(params, 'out_high');
  const tRise = real(params, 't_rise');
  const tFall = real(params, 't_fall');
  // out_low and out_high given without out_undef: out_undef is their mean.
  const outUndef = context.given.has('out_low') && context.given.has('out_high') && !context.given.has('out_undef')
    ? outLow + (outHigh - outLow) / 2.0
    : real(params, 'out_undef');
  let sizeIn = portCount(context, 'in');
  let sizeOut = portCount(context, 'out');
  const multi = sizeIn !== sizeOut && sizeOut === 1;
  if (!multi) {
    sizeIn = Math.min(sizeIn, sizeOut);
    sizeOut = sizeIn;
  }

  const event: EventBehavior<DacState> = {
    createState: () => ({ in: Array.from({ length: sizeIn }, () => ({ i: ZERO, changed: 0 })) }),
    event(call) {
      const current = call.state.in;
      for (let i = 0; i < sizeIn; i++) current[i].i = call.inputState(i);
      if (call.init) return;
      const old = call.previous.in;
      for (let i = 0; i < sizeIn; i++) {
        if (current[i].i === old[i].i) continue;
        call.setBreakpoint(call.time);
        if (multi) {
          current[0].changed = call.time;
          break;
        }
        current[i].changed = call.time;
      }
    },
  };

  /** get_out_val: the relative output of a multi-bit input, MSB last, U counting a quarter. */
  const multiValue = (bits: readonly { i: number }[]): number => {
    let v = 0.0;
    for (let i = sizeIn - 1; i >= 0; --i) {
      v /= 2.0;
      if (bits[i].i === ONE) v += 0.5;
      else if (bits[i].i === UNKNOWN) v += 0.25;
    }
    return v;
  };

  const levelOf = (state: number): number => (state === ONE ? outHigh : state === ZERO ? outLow : outUndef);

  const analog = (view: EventInstanceView<DacState>): CodeModelBehavior => {
    let accepted = new Float64Array(sizeOut);
    const current = new Float64Array(sizeOut);

    const evaluate = (call: CodeModelCall): void => {
      if (!view.initialized) return;
      const inputs = view.state.in;
      const old = view.previous.in;
      for (let i = 0; i < sizeIn; i++) inputs[i].i = view.inputState(i);
      const levelInc = outHigh - outLow;
      const riseSlope = levelInc / tRise;
      const fallSlope = levelInc / tFall;
      const dc = call.analysis === 'dc' || call.time === 0.0;
      const t0 = call.time;
      const timeInc = call.delta;
      const t1 = t0 - timeInc;

      if (multi) {
        const v = multiValue(inputs);
        if (dc) {
          current[0] = v * levelInc + outLow;
          call.outputs[0] = current[0];
          return;
        }
        let vout = (accepted[0] - outLow) / levelInc;
        const changed = inputs.some((input, i) => input.i !== old[i].i);
        if (!changed) {
          if (vout < v) {
            vout += timeInc / tRise;
            if (vout > v) vout = v;
          } else {
            vout -= timeInc / tFall;
            if (vout < v) vout = v;
          }
        } else {
          const { step: first, count, interval } = splitStep(t0, t1, timeInc, inputs[0].changed);
          let when = -1.0;
          for (let step = first; step < count; ++step) {
            const lastStep = step === count - 1;
            const target = step === 0 ? multiValue(old) : v;
            if (target > vout) {
              vout += interval[step] / tRise;
              if (vout > v) vout = v;
              else if (lastStep) when = (v - vout) * tRise;
            } else if (target < vout) {
              vout -= interval[step] / tFall;
              if (vout < v) vout = v;
              else if (lastStep) when = (vout - v) * tFall;
            }
          }
          if (when > 0.0) view.setBreakpoint(when + t0, t0);
        }
        current[0] = vout * levelInc + outLow;
        call.outputs[0] = current[0];
        return;
      }

      for (let i = 0; i < sizeIn; i++) {
        let vout: number;
        const state = inputs[i].i;
        if (dc) {
          vout = levelOf(state);
        } else if (old[i].i === state) {
          // No change of this input since the last analog call.
          const outOld = accepted[i];
          if (state === ZERO) {
            vout = outOld > outLow ? Math.max(outOld - fallSlope * timeInc, outLow) : outLow;
          } else if (state === ONE) {
            vout = outOld < outHigh ? Math.min(outOld + riseSlope * timeInc, outHigh) : outHigh;
          } else if (outOld < outUndef) {
            vout = Math.min(outOld + riseSlope * timeInc, outUndef);
          } else if (outOld > outUndef) {
            vout = Math.max(outOld - fallSlope * timeInc, outUndef);
          } else {
            vout = outUndef;
          }
        } else {
          // The input changed since the last analog call: ramp each side of the change.
          const { step: first, count, interval } = splitStep(t0, t1, timeInc, inputs[i].changed);
          let when = -1.0;
          vout = accepted[i];
          for (let step = first; step < count; ++step) {
            const lastStep = step === count - 1;
            const drive = step === 0 ? old[i].i : state;
            if (drive === ZERO) {
              if (vout <= outLow) continue;
              vout -= fallSlope * interval[step];
              if (vout < outLow) vout = outLow;
              else if (lastStep) when = (vout - outLow) / fallSlope;
            } else if (drive === ONE) {
              if (vout >= outHigh) continue;
              vout += riseSlope * interval[step];
              if (vout > outHigh) vout = outHigh;
              else if (lastStep) when = (outHigh - vout) / riseSlope;
            } else if (vout > outUndef) {
              vout -= fallSlope * interval[step];
              if (vout < outUndef) vout = outUndef;
              else if (lastStep) when = (vout - outUndef) / fallSlope;
            } else {
              vout += riseSlope * interval[step];
              if (vout > outUndef) vout = outUndef;
              else if (lastStep) when = (outUndef - vout) / riseSlope;
            }
          }
          if (when > 0.0) view.setBreakpoint(when + t0, t0);
        }
        current[i] = vout;
        call.outputs[i] = vout;
      }
    };

    return {
      stateful: false,
      ac: STATIC,
      load: evaluate,
      accept(call) {
        evaluate(call);
        accepted = new Float64Array(current);
      },
      reset() {
        accepted = new Float64Array(sizeOut);
        current.fill(0);
      },
    };
  };
  return { event, analog } as DigitalModel<unknown>;
};

/**
 * Where in the step T(1)..T(0) an input changed: the old value for the
 * whole step, the new one for the whole step, or both sides of the change
 * (changes within 1e-7 of the step from an end count as at that end).
 */
function splitStep(
  t0: number,
  t1: number,
  timeInc: number,
  changed: number,
): { step: number; count: number; interval: [number, number] } {
  const iota = timeInc * 1e-7;
  if (t0 - changed < iota) return { step: 0, count: 1, interval: [timeInc, 0] };
  if (changed - t1 < iota) return { step: 1, count: 2, interval: [0, timeInc] };
  return { step: 0, count: 2, interval: [changed - t1, t0 - changed] };
}

/** Implemented digital code models keyed by lower-case ngspice Spice_Model_Name. */
export const DIGITAL_MODELS: ReadonlyMap<string, DigitalModelFactory> = new Map<string, DigitalModelFactory>([
  ['d_tristate', tristate],
  ['d_osc', controlledOscillator(false)],
  ['d_pwm', controlledOscillator(true)],
  ['d_jkff', flipFlop('jk')],
  ['d_dff', flipFlop('d')],
  ['d_tff', flipFlop('t')],
  ['d_srff', flipFlop('sr')],
  ['d_pulldown', pull(ZERO)],
  ['d_pullup', pull(ONE)],
  ['d_buffer', gate(buffer)],
  ['d_inverter', gate(inverter)],
  ['d_and', gate(dominantGate(ZERO, ZERO, ONE))],
  ['d_nand', gate(dominantGate(ZERO, ONE, ZERO))],
  ['d_or', gate(dominantGate(ONE, ONE, ZERO))],
  ['d_nor', gate(dominantGate(ONE, ZERO, ONE))],
  ['d_xor', gate(parityGate(ZERO))],
  ['d_xnor', gate(parityGate(ONE))],
  // ngspice-47 digital/d_lut/cfunc.mod:168-183,195-223. Input 0 is the
  // least-significant bit; missing entries and non-binary characters give U.
  ['d_lut', (params, context) => {
    const table = String(params.get('table_values')![0]);
    return gate(inputs => {
      let index = 0;
      for (let i = 0; i < inputs.length; i++) {
        if (inputs[i] === UNKNOWN) return UNKNOWN;
        if (inputs[i] === ONE) index += 2 ** i;
      }
      return table[index] === '0' ? ZERO : table[index] === '1' ? ONE : UNKNOWN;
    })(params, context);
  }],
  ['adc_bridge', adcBridge],
  ['bidi_bridge', bidiBridge],
  ['dac_bridge', dacBridge],
]);
