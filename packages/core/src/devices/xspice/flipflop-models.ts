/** ngspice-47 digital/{d_jkff,d_dff,d_tff,d_srff,d_dlatch,d_srlatch,d_fdiv}/cfunc.mod (Public Domain).
 * Source: https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/digital
 */
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { ONE, STRONG, UNKNOWN, ZERO, type EventBehavior } from './event-network.js';
import { real } from './models.js';

interface FlipFlopState {
  clk: number;
  data: number;
  r: number;
  set: number;
  reset: number;
  out: number;
}

const complement = (value: number): number => value === UNKNOWN ? UNKNOWN : 1 - value;

/** cm_eval_jk_result intentionally propagates every unknown J or K. */
function jkResult(j: number, k: number, old: number): number {
  if (j === UNKNOWN || k === UNKNOWN) return UNKNOWN;
  if (j === ZERO) return k === ZERO ? old : ZERO;
  return k === ZERO ? ONE : complement(old);
}

/** Shared asynchronous control and complementary-output delay logic. */
export function flipFlop(kind: 'jk' | 'd' | 't' | 'sr' | 'dlatch' | 'srlatch'): DigitalModelFactory {
  const latch = kind === 'dlatch' || kind === 'srlatch';
  const srResult = (s: number, r: number, old: number): number =>
    s === UNKNOWN || r === UNKNOWN || (s === ONE && r === ONE)
      ? UNKNOWN : s === ONE ? ONE : r === ONE ? ZERO : old;
  return (params, context) => {
    // NULL connections have no flattened event ports. Keep logical names here
    // rather than assuming set/reset or either output is connected.
    const inputs = new Map<string, number>();
    const outputs: string[] = [];
    for (const connection of context.connections) {
      if (connection.ports.length === 0) continue;
      if (connection.direction === 'in') inputs.set(connection.name, inputs.size);
      else outputs.push(connection.name);
    }
    const event: EventBehavior<FlipFlopState> = {
      createState: () => ({ clk: ZERO, data: ZERO, r: ZERO, set: ZERO, reset: ZERO, out: ZERO }),
      event(call) {
        const read = (name: string): number => {
          const index = inputs.get(name);
          return index === undefined ? ZERO : call.inputState(index);
        };
        const state = call.state;
        const old = { ...call.previous };
        state.clk = read(latch ? 'enable' : 'clk');
        state.data = read(kind === 'srlatch' ? 's' : 'data');
        state.r = read('r');
        state.set = read('set');
        state.reset = read('reset');
        let value = old.out;
        let delay = 0;
        let force = false;
        if (call.time === 0) {
          value = real(params, 'ic');
          if (kind === 'dlatch' && state.clk === ONE) value = state.data;
          // At DC only an unambiguous synchronous set/reset overrides IC.
          if (kind === 'srlatch' && state.clk === ONE) {
            if (state.data === ONE && state.r === ZERO) value = ONE;
            if (state.data === ZERO && state.r === ONE) value = ZERO;
          }
          if (state.set === ONE && state.reset === ZERO) value = ONE;
          if (state.set === ZERO && state.reset === ONE) value = ZERO;
          if (state.set === ONE && state.reset === ONE) value = UNKNOWN;
        } else if (state.set !== old.set) {
          delay = real(params, 'set_delay');
          force = state.set === UNKNOWN && state.reset === ONE;
          if (state.set === ONE) value = state.reset === ONE ? UNKNOWN : ONE;
          else if (state.reset === ONE) value = ZERO;
          else if (latch && state.clk === ONE) {
            // Transparent latches resume synchronous evaluation on release,
            // using the releasing control's delay, not the data/enable delay.
            value = kind === 'dlatch' ? state.data : srResult(state.data, state.r, old.out);
          }
        } else if (state.reset !== old.reset) {
          delay = real(params, 'reset_delay');
          force = state.reset === UNKNOWN && state.set === ONE;
          if (state.reset === ONE) value = state.set === ONE ? UNKNOWN : ZERO;
          else if (state.set === ONE) value = ONE;
          else if (latch && state.clk === ONE) {
            value = kind === 'dlatch' ? state.data : srResult(state.data, state.r, old.out);
          }
        } else if (latch && state.set !== ONE && state.reset !== ONE) {
          if (state.clk === ONE && (state.clk !== old.clk || state.data !== old.data || state.r !== old.r)) {
            delay = real(params, state.clk !== old.clk ? 'enable_delay' : kind === 'dlatch' ? 'data_delay' : 'sr_delay');
            value = kind === 'dlatch' ? state.data : srResult(state.data, state.r, old.out);
          }
        } else if (!latch && state.clk !== old.clk && state.clk === ONE && state.set !== ONE && state.reset !== ONE) {
          delay = real(params, 'clk_delay');
          switch (kind) {
            case 'jk': value = jkResult(read('j'), read('k'), old.out); break;
            case 'd': value = read('data'); break;
            case 't': {
              const t = read('t');
              value = t === UNKNOWN ? UNKNOWN : t === ONE ? complement(old.out) : old.out;
              break;
            }
            case 'sr': {
              const s = read('s'), r = read('r');
              value = s === UNKNOWN || r === UNKNOWN || (s === ONE && r === ONE)
                ? UNKNOWN : s === ONE ? ONE : r === ONE ? ZERO : old.out;
              break;
            }
          }
        }
        state.out = value;
        for (let i = 0; i < outputs.length; i++) {
          const out = call.outputs[i];
          if (call.time !== 0 && value === old.out && !force) {
            out.changed = false;
            continue;
          }
          const inverted = outputs[i] === 'nout';
          out.state = inverted ? complement(value) : value;
          out.strength = STRONG;
          // Unknown transitions use the edge leaving the previous Q value.
          const rising = value === ONE || (value === UNKNOWN && old.out === ZERO);
          out.delay = call.time === 0 ? 0 : delay;
          if (call.time !== 0 && value !== old.out) out.delay += real(params, rising !== inverted ? 'rise_delay' : 'fall_delay');
        }
      },
    };
    return { event } as DigitalModel<unknown>;
  };
}

interface DividerState {
  input: number;
  count: number;
  out: number;
}

/** ngspice-47 digital/d_fdiv/cfunc.mod. Counter advances on every edge to ONE. */
export const frequencyDivider: DigitalModelFactory = params => {
  const event: EventBehavior<DividerState> = {
    createState: () => ({ input: ZERO, count: 0, out: ZERO }),
    event(call) {
      const state = call.state;
      const old = call.previous;
      const output = call.outputs[0];
      const factor = real(params, 'div_factor');
      const high = real(params, 'high_cycles');
      output.strength = STRONG;
      if (call.time === 0) {
        const initial = real(params, 'i_count');
        state.count = initial < 0 || initial >= factor ? 0 : initial;
        state.out = state.count > 0 && state.count <= high ? ONE : ZERO;
        output.state = state.out;
        output.delay = 0;
        return;
      }
      state.input = call.inputState(0);
      output.changed = false;
      if (state.input !== old.input && state.input === ONE) {
        state.count = old.count + 1;
        if (state.count === factor + 1 || state.count === 1) {
          state.count = 1;
          state.out = ONE;
          output.changed = true;
        } else if (state.count === high + 1) {
          state.out = ZERO;
          output.changed = true;
        }
        if (output.changed) {
          output.state = state.out;
          output.delay = real(params, state.out === ONE ? 'rise_delay' : 'fall_delay');
        }
      }
    },
  };
  return { event } as DigitalModel<unknown>;
};
