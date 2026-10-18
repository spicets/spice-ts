import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { UnsupportedCodeModelError, parseXspiceInstance, parseXspiceModelCard } from '../../parser/xspice-parser.js';
import { prepareXspiceInstance } from './compile.js';
import { DIGITAL_MODELS } from './digital-models.js';
import {
  HI_IMPEDANCE, ONE, STRONG, UNDETERMINED, UNKNOWN, ZERO,
  XspiceEventNetwork, type EventOutput,
} from './event-network.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';

const params = new Map([['delay', [2]], ['input_load', [3e-12]], ['enable_load', [4e-12]]]);
function model() {
  return DIGITAL_MODELS.get('d_tristate')!(params, { connections: [], given: new Set(params.keys()) }).event;
}

// ngspice-47 src/xspice/icm/digital/d_tristate/cfunc.mod:155-172,454-456:
// state always follows in; enable changes strength only, including UNKNOWN.
describe('d_tristate', () => {
  for (const input of [ZERO, ONE, UNKNOWN]) {
    for (const [enable, strength] of [[ZERO, HI_IMPEDANCE], [ONE, STRONG], [UNKNOWN, UNDETERMINED]]) {
      it(`copies input ${input} with enable ${enable} and exact delay`, () => {
        const event = model();
        const output: EventOutput = { changed: true, state: ZERO, strength: STRONG, delay: 0, load: 0 };
        event.event({ analysis: 'tran', init: false, time: 7, previousTime: 6,
          state: event.createState(), previous: event.createState(), outputs: [output],
          inputState: port => [input, enable][port],
          inputValue() { throw new Error('unused'); }, probeExternal() { throw new Error('unused'); },
          setBreakpoint() {}, setTemporaryBreakpoint: () => false, scheduleOutput() {},
        });
        expect(output).toEqual({ changed: true, state: input, strength, delay: 2, load: 0 });
      });
    }
  }

  it('registers scalar required digital ports and ngspice parameter defaults', () => {
    const spec = XSPICE_CODE_MODEL_SPECS.get('d_tristate')!;
    expect(spec.connections.map(c => [c.name, c.direction, c.defaultType, c.vector, c.nullAllowed]))
      .toEqual([['in', 'in', 'd', false, false], ['enable', 'in', 'd', false, false], ['out', 'out', 'd', false, false]]);
    expect(spec.params.map(p => [p.name, p.defaultValue])).toEqual([
      ['delay', [1e-9]], ['input_load', [1e-12]], ['enable_load', [1e-12]],
    ]);
    expect(spec.params[0].limits).toEqual([1e-12, undefined]);
    expect(() => prepareXspiceInstance(parseXspiceInstance('a1 in en out tri', 1),
      parseXspiceModelCard('.model tri d_tristate(delay=2n input_load=3p enable_load=4p)', 2), false, '0')).not.toThrow();
  });

  it('delivers data and strength transitions at exact event times, with DC undelayed', () => {
    const network = new XspiceEventNetwork();
    const port = (node: string) => ({ node, invert: false });
    const driver = network.addInstance({ name: 'source', hybrid: false, inputs: [], outputs: [port('in'), port('enable')],
      behavior: {
        createState: () => null,
        event(call) {
          call.outputs[0].state = call.time < 5 ? ZERO : ONE;
          call.outputs[1].state = call.time < 10 ? ONE : call.time < 15 ? ZERO : UNKNOWN;
          for (const out of call.outputs) out.strength = STRONG;
        },
      },
    });
    network.addInstance({ name: 'tri', hybrid: false, inputs: [port('in'), port('enable')], outputs: [port('out')], behavior: model() });
    network.operatingPoint(() => {});
    network.beginTransient(() => {}, 0);
    for (const time of [5, 10, 15]) driver.queue(time);
    while (network.nextEventTime() <= 17) {
      const time = network.nextEventTime();
      network.processEvents(time, 0);
      network.acceptStep(time, false);
    }
    expect(network.nodeHistories().get('out')).toEqual([
      { time: 0, state: '0', strength: 's' },
      { time: 7, state: '1', strength: 's' },
      { time: 12, state: '1', strength: 'z' },
      { time: 17, state: '1', strength: 'u' },
    ]);
  });

  it('does not reschedule an unchanged state/strength pair', () => {
    const event = model();
    const state = event.createState();
    const output: EventOutput = { changed: true, state: ZERO, strength: STRONG, delay: 0, load: 0 };
    const call = { analysis: 'tran' as const, init: false, time: 7, previousTime: 6,
      state, previous: state, outputs: [output], inputState: () => ONE,
      inputValue() { throw new Error('unused'); }, probeExternal() { throw new Error('unused'); },
      setBreakpoint() {}, setTemporaryBreakpoint: () => false, scheduleOutput() {},
    };
    event.event(call);
    expect(output.changed).toBe(true);
    event.event({ ...call, time: 8 });
    expect(output.changed).toBe(false);
  });

  it('preserves typed rejection of other unsupported models', () => {
    expect(() => prepareXspiceInstance(parseXspiceInstance('a1 in out unsupported', 1),
      parseXspiceModelCard('.model unsupported d_cosim', 2), false, '0')).toThrow(UnsupportedCodeModelError);
  });

  it('simulates enabled and disabled buffers through the public API', async () => {
    const result = await simulate(`tristate public API
v1 supply 0 1
apull high up
alow low down
.model up d_pullup
.model down d_pulldown
aenabled high high driven tri
adisabled high low floating tri
.model tri d_tristate(delay=2n input_load=3p enable_load=4p)
.tran 1n 5n
.end`);
    expect(result.transient!.digital('driven')).toEqual([{ time: 0, state: '1', strength: 's' }]);
    expect(result.transient!.digital('floating')).toEqual([{ time: 0, state: '1', strength: 'z' }]);
  });
});
