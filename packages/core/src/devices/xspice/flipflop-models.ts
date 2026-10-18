/** ngspice-47 digital/{d_jkff,d_dff,d_tff,d_srff}/cfunc.mod (Public Domain).
 * Source: https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/digital
 */
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { ONE, STRONG, UNKNOWN, ZERO, type EventBehavior } from './event-network.js';
import { real } from './models.js';

interface FlipFlopState {
  clk: number;
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

/** Shared control/edge/delay logic, identical in the four ngspice models. */
export function flipFlop(kind: 'jk' | 'd' | 't' | 'sr'): DigitalModelFactory {
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
      createState: () => ({ clk: ZERO, set: ZERO, reset: ZERO, out: ZERO }),
      event(call) {
        const read = (name: string): number => {
          const index = inputs.get(name);
          return index === undefined ? ZERO : call.inputState(index);
        };
        const state = call.state;
        const old = { ...call.previous };
        state.clk = read('clk');
        state.set = read('set');
        state.reset = read('reset');
        let value = old.out;
        let delay = 0;
        let force = false;
        if (call.time === 0) {
          value = real(params, 'ic');
          if (state.set === ONE && state.reset === ZERO) value = ONE;
          if (state.set === ZERO && state.reset === ONE) value = ZERO;
          if (state.set === ONE && state.reset === ONE) value = UNKNOWN;
        } else if (state.set !== old.set) {
          delay = real(params, 'set_delay');
          force = state.set === UNKNOWN && state.reset === ONE;
          if (state.set === ONE) value = state.reset === ONE ? UNKNOWN : ONE;
          else if (state.reset === ONE) value = ZERO;
        } else if (state.reset !== old.reset) {
          delay = real(params, 'reset_delay');
          force = state.reset === UNKNOWN && state.set === ONE;
          if (state.reset === ONE) value = state.set === ONE ? UNKNOWN : ZERO;
          else if (state.set === ONE) value = ONE;
        } else if (state.clk !== old.clk && state.clk === ONE && state.set !== ONE && state.reset !== ONE) {
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
