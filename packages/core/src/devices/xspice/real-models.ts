/** ngspice-47 src/xspice/icm/xtraevt/{d_to_real,real_gain,real_delay,real_to_v}.
 * Behavioral transcription of the Public Domain cfunc.mod implementations.
 * Real node initialize/invert/resolve follow xtraevt/real/udnfunc.c.
 */
import type { DigitalModelFactory } from './digital-models.js';
import { ONE, UNKNOWN, ZERO } from './event-network.js';
import { real, STATIC } from './models.js';

interface RampState {
  start: number;
  end: number;
  from: number;
  to: number;
}

function ramp(state: RampState, time: number): number {
  if (time <= state.start) return state.from;
  if (time >= state.end) return state.to;
  return state.from + (state.to - state.from) * (time - state.start) / (state.end - state.start);
}

const dToReal: DigitalModelFactory = (params, context) => {
  const enabled = context.connections[1].isNull;
  return { event: {
    createState: () => null,
    event(call) {
      const zero = real(params, 'zero');
      const one = real(params, 'one');
      const input = call.inputState(0);
      const enable = enabled || call.inputState(1) === ONE;
      call.outputs[0].real = (input === ZERO ? zero : input === UNKNOWN ? (zero + one) / 2 : one) * Number(enable);
      if (call.time > 0) call.outputs[0].delay = real(params, 'delay');
    },
  } };
};

const realGain: DigitalModelFactory = params => ({ event: {
  createState: () => null,
  event(call) {
    const out = call.outputs[0];
    if (call.analysis === 'dc') {
      out.real = real(params, 'ic');
      if (call.init) call.queue(real(params, 'delay'));
    } else {
      out.real = real(params, 'gain') * (call.inputReal(0) + real(params, 'in_offset')) + real(params, 'out_offset');
      out.delay = real(params, 'delay');
    }
  },
} });

const realDelay: DigitalModelFactory = params => ({ event: {
  createState: () => ({ clock: ZERO }),
  event(call) {
    const state = call.state as { clock: number };
    const previous = call.previous as { clock: number };
    if (call.init) state.clock = call.inputState(1);
    const old = previous.clock;
    if (call.analysis === 'tran') state.clock = call.inputState(1);
    const out = call.outputs[0];
    out.changed = call.analysis === 'tran' && state.clock !== old && state.clock === ONE;
    if (out.changed) {
      out.real = call.inputReal(0);
      out.delay = real(params, 'delay');
    }
  },
} });

const realToV: DigitalModelFactory = params => ({
  event: {
    createState: (): RampState => ({ start: -2, end: -1, from: 0, to: 0 }),
    event(call) {
      const state = call.state as RampState;
      const input = call.inputReal(0);
      if (call.init) state.from = state.to = input;
      if (call.time === 0) return;
      state.from = ramp(state, call.time);
      state.to = input;
      state.start = call.time;
      state.end = call.time + real(params, 'transition_time');
    },
  },
  analog: view => ({
    stateful: true,
    ac: STATIC,
    load(call) {
      const gain = real(params, 'gain');
      const state = view.state as RampState;
      // Preserve ngspice-47's expression, including gain on only the ramp
      // increment in the interior (unlike the endpoint branches).
      call.outputs[0] = call.time === 0 ? view.inputReal(0) * gain
        : call.time <= state.start ? state.from * gain
          : call.time >= state.end ? state.to * gain
            : state.from + (state.to - state.from) * (call.time - state.start) / (state.end - state.start) * gain;
      if (call.time === 0 && view.initialized) {
        state.from = state.to = view.inputReal(0);
      }
    },
  }),
});

export const REAL_MODELS: ReadonlyMap<string, DigitalModelFactory> = new Map([
  ['d_to_real', dToReal], ['real_gain', realGain], ['real_delay', realDelay], ['real_to_v', realToV],
]);
