/** ngspice-47 digital/{d_osc,d_pwm}/cfunc.mod (Public Domain).
 * Hybrid controlled oscillators. Event state belongs to the network so rejected
 * analog steps restore pending transitions together with the output queues.
 */
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { ONE, ZERO, STRONG, type EventInstanceView } from './event-network.js';
import { real, reals, STATIC } from './models.js';

interface OscillatorState {
  lastTime: number;
  last: number;
}

/** Same table interpolation/extrapolation as get_period/get_dc in ngspice. */
function interpolate(x: readonly number[], y: readonly number[], control: number): number {
  let i = 0;
  while (i < x.length - 2 && control >= x[i + 1]) i++;
  return y[i] + (control - x[i]) * (y[i + 1] - y[i]) / (x[i + 1] - x[i]);
}

export function controlledOscillator(pwm: boolean): DigitalModelFactory {
  return params => {
    const x = reals(params, 'cntl_array');
    const y = reals(params, pwm ? 'dc_array' : 'freq_array').map(value =>
      pwm ? (value <= 0 ? .01 : value >= 1 ? .99 : value) : (value <= 0 ? 1e-16 : value));
    // ngspice disables an instance with a badly-formed table.
    const valid = x.length === y.length && x.every((value, i) => i === 0 || value > x[i - 1]);
    let phase = real(params, 'init_phase') / 360;
    if (phase < 0) phase += 1;
    let view: EventInstanceView<OscillatorState>;
    const timing = () => {
      const value = interpolate(x, y, view.analogInputs[0]);
      return {
        period: 1 / (pwm ? real(params, 'frequency') : value),
        duty: pwm ? Math.max(.01, Math.min(.99, value)) : real(params, 'duty_cycle'),
      };
    };
    const model: DigitalModel<OscillatorState> = {
      event: {
        createState: () => ({ lastTime: 0, last: ZERO }),
        event(call) {
          const out = call.outputs[0];
          out.changed = false;
          if (call.init || !valid) return;
          const state = call.state;
          if (call.time === 0) {
            out.changed = true;
            out.state = state.last;
            out.strength = STRONG;
          }
          const { period, duty } = timing();
          const delta = period * (state.last === ONE ? duty : 1 - duty);
          let when = state.lastTime + delta;
          if (call.time >= when) {
            if (call.setTemporaryBreakpoint(state.lastTime + .8 * delta)) return;
            if (when > call.previousTime
              && call.setTemporaryBreakpoint((call.previousTime + when) / 2)) return;
            // The transition is already in the fixed past (ngspice fallback).
            when = call.time;
          }
          if (call.time >= state.lastTime + .75 * delta) {
            state.lastTime = when;
            state.last ^= ONE;
            out.changed = true;
            out.state = state.last;
            out.strength = STRONG;
            out.delay = Math.max(0, when - call.time);
            view.queue(when + .8 * period * (state.last === ONE ? duty : 1 - duty));
          } else if (call.time >= state.lastTime) {
            view.queue(state.lastTime + .8 * delta);
          }
        },
      },
      analog(eventView) {
        view = eventView;
        return {
          stateful: false, ac: STATIC,
          load(call) {
            view.setAnalogInputs(call.inputs);
            if (!view.initialized || !valid || call.time !== 0) return;
            const { period, duty } = timing();
            const lastTime = period * (1 - duty - phase);
            view.state.last = lastTime < 0 ? ONE : ZERO;
            view.state.lastTime = lastTime < 0 ? lastTime : -period * phase;
          },
        };
      },
    };
    return model as DigitalModel<unknown>;
  };
}
