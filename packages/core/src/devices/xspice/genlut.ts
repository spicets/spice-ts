/** Public-domain ngspice-47 digital/d_genlut/cfunc.mod:153-401.
 * https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/d_genlut/
 */
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { HI_IMPEDANCE, ONE, STRONG, UNDETERMINED, UNKNOWN, ZERO, type DigitalValue } from './event-network.js';

interface State {
  inputs: number[];
  outputs: DigitalValue[];
}

export const genlut: DigitalModelFactory = (params, context) => {
  const inputs = context.connections[0].ports.length;
  const outputs = context.connections[1].ports.length;
  const entries = 2 ** inputs;
  const table = String(params.get('table_values')![0]);
  // ngspice repeats the final vector element for remaining ports.
  const delay = (name: string, port: number): number => {
    const values = params.get(name)!;
    return Number(values[Math.min(port, values.length - 1)]);
  };
  return {
    event: {
      createState: () => ({ inputs: Array(inputs).fill(ZERO), outputs: Array.from({ length: outputs }, () => ({ state: ZERO, strength: STRONG })) }),
      event(call) {
        let index = 0;
        let valid = true;
        // Preserve the upstream early exit on an unknown input: later input
        // slots retain their previous values for changed-input delay selection.
        for (let i = 0; i < inputs; i++) {
          const value = call.state.inputs[i] = call.inputState(i);
          if (value === UNKNOWN) { valid = false; break; }
          if (value === ONE) index += 2 ** i;
        }
        let maxDelay = 0;
        for (let i = 0; i < inputs; i++) {
          if (call.state.inputs[i] !== call.previous.inputs[i]) maxDelay = Math.max(maxDelay, delay('input_delay', i));
        }
        for (let i = 0; i < outputs; i++) {
          const char = valid ? table[index + i * entries] : undefined;
          const value = { state: char === '0' ? ZERO : char === '1' ? ONE : UNKNOWN,
            strength: char === '0' || char === '1' ? STRONG : char === 'z' ? HI_IMPEDANCE : UNDETERMINED };
          const previous = call.previous.outputs[i];
          call.state.outputs[i] = value;
          const out = call.outputs[i];
          if (call.analysis === 'dc') {
            out.state = value.state;
            out.strength = value.strength;
          } else if (value.state !== previous.state) {
            out.state = value.state;
            out.strength = value.strength;
            const rising = value.state === ONE || (value.state === UNKNOWN && previous.state === ZERO);
            out.delay = maxDelay + delay(rising ? 'rise_delay' : 'fall_delay', i);
          } else if (value.strength !== previous.strength) {
            // Strength-only transitions omit input delay in the original.
            out.strength = value.strength;
            const falling = value.strength === STRONG ? previous.state === ZERO : previous.state !== ZERO;
            out.delay += delay(falling ? 'fall_delay' : 'rise_delay', i);
          } else out.changed = false;
        }
      },
    },
  } satisfies DigitalModel<State> as DigitalModel<unknown>;
};
