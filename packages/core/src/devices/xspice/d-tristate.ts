import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { HI_IMPEDANCE, STRONG, UNDETERMINED, UNKNOWN, ZERO, type DigitalValue, type EventBehavior } from './event-network.js';
import { real } from './models.js';

/**
 * ngspice-47 src/xspice/icm/digital/d_tristate/cfunc.mod:143,155-172,454-456.
 * Enable controls strength, not state; data and enable share a single delay.
 * Input loads are declared in the interface spec, as for the other digital gates.
 */
export const tristate: DigitalModelFactory = params => {
  const event: EventBehavior<DigitalValue> = {
    createState: () => ({ state: UNKNOWN + 1, strength: UNDETERMINED }),
    event(call) {
      const enable = call.inputState(1);
      const value = call.inputState(0);
      const strength = enable === ZERO ? HI_IMPEDANCE : enable === UNKNOWN ? UNDETERMINED : STRONG;
      const out = call.outputs[0];
      if (value === call.state.state && strength === call.state.strength) {
        out.changed = false;
        return;
      }
      call.state.state = out.state = value;
      call.state.strength = out.strength = strength;
      out.delay = real(params, 'delay');
    },
  };
  return { event } as DigitalModel<unknown>;
};
