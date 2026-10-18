/** ngspice-47 digital/d_ram/cfunc.mod (Public Domain).
 * https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/d_ram/
 * Words are sparse, with a uniform default, rather than C's packed two-bit array.
 * Keeping all memory in event state preserves rollback on rejected analog steps.
 */
import { InvalidCircuitError } from '../../errors.js';
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { HI_IMPEDANCE, ONE, STRONG, UNKNOWN, ZERO, type EventBehavior } from './event-network.js';
import { real } from './models.js';

interface RamState {
  selected: boolean;
  initial: number;
  words: Map<number, number[]>;
}

export const ram: DigitalModelFactory = (params, context) => {
  const size = (name: string) => context.connections.find(c => c.name === name)!.ports.length;
  const width = size('data_in');
  const addressSize = size('address');
  const selectSize = size('select');
  if (size('data_out') !== width) throw new InvalidCircuitError('d_ram data_in and data_out must have the same width');
  const ic = real(params, 'ic');
  const selectValue = real(params, 'select_value');
  const delay = real(params, 'read_delay');
  const event: EventBehavior<RamState> = {
    createState: () => ({ selected: false, initial: ic, words: new Map() }),
    event(call) {
      const { state } = call;
      const write = call.inputState(width + addressSize);
      let selected = true;
      for (let i = 0; i < selectSize; i++) {
        if (call.inputState(width + addressSize + 1 + i) !== ((selectValue >> i) & 1)) selected = false;
      }
      const selectionChanged = !call.init && selected !== call.previous.selected;
      state.selected = selected;
      if (call.time === 0) {
        // TIME==0 reinitializes the whole array, even on subsequent DC iterations.
        state.initial = ic;
        state.words.clear();
        for (const out of call.outputs) {
          out.state = selected && write === ZERO ? ic : UNKNOWN;
          out.strength = selected && write === ZERO ? STRONG : HI_IMPEDANCE;
        }
        return;
      }
      if (!selected) {
        for (const out of call.outputs) {
          if (selectionChanged && write === ZERO) {
            out.state = UNKNOWN;
            out.strength = HI_IMPEDANCE;
            out.delay = delay;
          } else out.changed = false;
        }
        return;
      }
      let address = 0;
      let unknown = false;
      for (let i = 0; i < addressSize; i++) {
        const bit = call.inputState(width + i);
        unknown ||= bit === UNKNOWN;
        if (bit === ONE) address += 2 ** i;
      }
      // The reference treats U write_en as write on selection, but read otherwise.
      const writing = selectionChanged ? write !== ZERO : write === ONE;
      let word: number[] | undefined;
      if (writing) {
        if (unknown) {
          state.words.clear();
          state.initial = UNKNOWN;
        } else {
          word = Array.from({ length: width }, (_, i) => call.inputState(i));
          state.words.set(address, word);
        }
      } else if (!unknown) word = state.words.get(address);
      for (let i = 0; i < width; i++) {
        const out = call.outputs[i];
        out.state = unknown ? UNKNOWN : word?.[i] ?? state.initial;
        out.strength = writing ? HI_IMPEDANCE : STRONG;
        out.delay = delay;
      }
    },
  };
  return { event } as DigitalModel<unknown>;
};
