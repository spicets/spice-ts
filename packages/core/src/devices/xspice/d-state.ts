import { InvalidCircuitError } from '../../errors.js';
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { type DigitalValue, type EventBehavior, ONE, ZERO } from './event-network.js';
import { real } from './models.js';

interface Transition { inputs: string[]; next: number }
interface MachineState { outputs: DigitalValue[]; transitions: Transition[] }
interface RuntimeState { current: number; clock: number; reset: number }
const fail = (message: string): never => { throw new InvalidCircuitError(`XSPICE d_state: ${message}`); };

/** ngspice-47 digital/d_state: ordered Moore-machine rows, first match wins.
 * Immutable tables belong to the factory; runtime state is event-owned for rollback.
 */
export const digitalState: DigitalModelFactory = (params, context) => {
  const input = context.connections.find(c => c.name === 'in')!;
  const reset = context.connections.find(c => c.name === 'reset')!;
  const width = context.connections.find(c => c.name === 'out')!.ports.length;
  const count = input.isNull ? 0 : input.ports.length;
  const text = params.get('__file_data')?.[0];
  if (typeof text !== 'string') fail('state_file requires host-resolved file data');
  const states = new Map<number, MachineState>();
  let current: MachineState | undefined;
  const number = (token: string): number => {
    const value = Number(token);
    if (!token || !Number.isSafeInteger(value)) fail(`invalid state number '${token}'`);
    return value;
  };
  for (const [index, line] of (text as string).split(/\r?\n/).entries()) {
    if (!line.trim() || line.startsWith('*')) continue;
    const tokens = line.trim().split(/[\s=(),]+/).filter(Boolean);
    if (tokens.length === count + width + 3) {
      const id = number(tokens.shift()!);
      if (states.has(id)) fail(`duplicate state ${id}`);
      const outputs = tokens.splice(0, width).map(token => {
        if (!/^[01U][srzu]$/.test(token)) fail(`invalid output '${token}' on line ${index + 1}`);
        return { state: '01U'.indexOf(token[0]), strength: 'srzu'.indexOf(token[1]) };
      });
      current = { outputs, transitions: [] };
      states.set(id, current);
    } else if (tokens.length !== count + 2) fail(`invalid row width on line ${index + 1}`);
    if (!current) fail(`continuation before state header on line ${index + 1}`);
    const inputs = tokens.splice(0, count);
    if (inputs.some(token => !/^[01xX]$/.test(token)) || tokens[0] !== '->') fail(`invalid transition on line ${index + 1}`);
    current!.transitions.push({ inputs, next: number(tokens[1]) });
  }
  const initial = real(params, 'reset_state');
  if (!states.has(initial)) fail(`reset_state ${initial} not found`);
  for (const state of states.values()) for (const transition of state.transitions) {
    if (!states.has(transition.next)) fail(`next state ${transition.next} not found`);
  }
  const event: EventBehavior<RuntimeState> = {
    createState: () => ({ current: initial, clock: ZERO, reset: ZERO }),
    event(call) {
      const state = call.state;
      let delay = 0;
      let changed = call.time === 0;
      if (changed) state.current = initial;
      else {
        state.clock = call.inputState(count);
        state.reset = reset.isNull ? ZERO : call.inputState(count + 1);
        if (state.reset !== call.previous.reset) {
          if (state.reset === ONE) { state.current = initial; changed = true; delay = real(params, 'reset_delay'); }
        } else if (state.reset !== ONE && state.clock !== call.previous.clock && state.clock === ONE) {
          const transition = states.get(state.current)!.transitions.find(row => row.inputs.every((token, i) =>
            /[xX]/.test(token) || Number(token) === call.inputState(i)));
          if (transition) { state.current = transition.next; changed = true; delay = real(params, 'clk_delay'); }
        }
      }
      call.outputs.forEach((out, i) => {
        out.changed = changed;
        if (changed) { Object.assign(out, states.get(state.current)!.outputs[i]); out.delay = delay; }
      });
    },
  };
  return { event } as DigitalModel<unknown>;
};
