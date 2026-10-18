import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parseXspiceInstance, parseXspiceModelCard } from '../../parser/xspice-parser.js';
import { buildXspiceEventNetwork, prepareXspiceInstance } from './compile.js';
import { XspiceEventNetwork, ONE, ZERO, STRONG } from './event-network.js';
import { REAL_MODELS } from './real-models.js';

function network(model: string, ports: string) {
  const prepared = prepareXspiceInstance(parseXspiceInstance(`a1 ${ports} m`, 0), parseXspiceModelCard(`.model m ${model}`, 0), false, '0');
  return buildXspiceEventNetwork([prepared])!.network;
}

describe('XSPICE real event nodes (ngspice-47 xtraevt)', () => {
  it('real nodes sum multiple drivers, negate inverted ports and reject mixed node types', () => {
    const net = new XspiceEventNetwork();
    for (const value of [2, 5]) net.addInstance({ name: `source${value}`, hybrid: false, inputs: [], outputs: [{ node: 'r', type: 'real', invert: false }], behavior: { createState: () => null, event(call) { call.outputs[0].real = value; } } });
    const view = net.addInstance({ name: 'read', hybrid: false, inputs: [{ node: 'r', type: 'real', invert: true }], outputs: [], behavior: { createState: () => null, event() {} } });
    net.operatingPoint(() => {});
    expect(view.inputReal(0)).toBe(-7);
    expect(() => net.addInstance({ name: 'bad', hybrid: false, inputs: [{ node: 'r', invert: false }], outputs: [], behavior: { createState: () => null, event() {} } })).toThrow('conflicting event types');
  });

  it('real_delay samples only rising clocks, delays its output and restores rejected events', () => {
    const net = new XspiceEventNetwork();
    net.addInstance({ name: 'source', hybrid: false, inputs: [], outputs: [{ node: 'r', type: 'real', invert: false }, { node: 'clk', invert: false }], behavior: {
      createState: () => null,
      event(call) {
        call.outputs[0].real = call.time < 2 ? 3 : 8;
        call.outputs[1].state = call.time === 1 || call.time === 3 ? ONE : ZERO;
        call.outputs[1].strength = STRONG;
        if (call.time < 3) call.queue(call.time + 1);
      },
    } });
    const event = REAL_MODELS.get('real_delay')!(new Map([['delay', [.25]]]), { connections: [], given: new Set() }).event;
    net.addInstance({ name: 'delay', hybrid: false, inputs: [{ node: 'r', type: 'real', invert: false }, { node: 'clk', invert: false }], outputs: [{ node: 'out', type: 'real', invert: false }], behavior: event });
    const view = net.addInstance({ name: 'read', hybrid: false, inputs: [{ node: 'out', type: 'real', invert: false }], outputs: [], behavior: { createState: () => null, event() {} } });
    net.operatingPoint(() => {});
    net.beginTransient(() => {}, 0);
    expect(view.inputReal(0)).toBe(0);
    const step = () => { const time = net.nextEventTime(); net.processEvents(time, 0); };
    step(); step(); // source and zero-delay output at t=1
    expect(view.inputReal(0)).toBe(0);
    expect(net.nextEventTime()).toBe(1.25);
    step();
    expect(view.inputReal(0)).toBe(3);
    net.backup(1);
    expect(view.inputReal(0)).toBe(0);
    step();
    expect(view.inputReal(0)).toBe(3);
    while (net.nextEventTime() <= 2) step();
    expect(view.inputReal(0)).toBe(3);
    while (net.nextEventTime() < Infinity) step();
    expect(view.inputReal(0)).toBe(8);
  });

  it.each([[ZERO, 1, -3], [ONE, 1, 5], [2, 1, 1], [ONE, ZERO, 0], [ONE, 2, 0]])('d_to_real maps state %s with enable %s to %s after its delay', (input, enable, expected) => {
    const prepared = prepareXspiceInstance(parseXspiceInstance('a1 d en r m', 0), parseXspiceModelCard('.model m d_to_real(zero=-3 one=5 delay=2n)', 0), false, '0');
    const model = REAL_MODELS.get('d_to_real')!(prepared.params, { connections: prepared.connections, given: new Set() });
    const out = { real: 0, state: ZERO, strength: STRONG, changed: true, delay: 0, load: 0 };
    model.event.event({ analysis: 'tran', init: false, time: 1, previousTime: 0, state: null, previous: null, outputs: [out], inputState: i => i === 0 ? input : enable, inputReal: () => 0, queue() {}, setBreakpoint() {}, scheduleOutput() {}, setTemporaryBreakpoint: () => false,
      inputValue() { throw new Error('unused'); }, probeExternal() { throw new Error('unused'); } });
    expect(out.real).toBe(expected);
    expect(out.delay).toBe(2e-9);
  });

  it('d_to_real maps digital zero to the configured real output', async () => {
    const { dc } = await simulate(['real bridge', 'a1 d pull', '.model pull d_pulldown', 'a2 d NULL r convert', '.model convert d_to_real(zero=-3 one=5)', 'a3 r out bridge', '.model bridge real_to_v', 'r1 out 0 1k', '.op', '.end'].join('\n'));
    expect(dc!.voltage('out')).toBe(-3);
  });

  it('real_gain applies offsets and gain after its delayed initial transient call', () => {
    const net = network('real_gain(ic=7 gain=3 in_offset=2 out_offset=-1 delay=2n)', 'r1 r2');
    const view = net.addInstance({ name: 'read', hybrid: false, inputs: [{ node: 'r2', type: 'real', invert: false }], outputs: [], behavior: { createState: () => null, event() {} } });
    net.operatingPoint(() => {});
    expect(view.inputReal(0)).toBe(7);
    net.beginTransient(() => {}, 0);
    net.processEvents(2e-9, 0);
    expect(view.inputReal(0)).toBe(7);
    net.processEvents(4e-9, 0);
    expect(view.inputReal(0)).toBe(5);
  });

  it('real_to_v interpolates and retargets overlapping transitions', () => {
    const prepared = prepareXspiceInstance(parseXspiceInstance('a1 r out m', 0), parseXspiceModelCard('.model m real_to_v(transition_time=2 gain=2)', 0), false, '0');
    const { network: net, analogHalves } = buildXspiceEventNetwork([prepared])!;
    const analog = analogHalves.get(prepared)!;
    net.addInstance({ name: 'source', hybrid: false, inputs: [], outputs: [{ node: 'r', type: 'real', invert: false }], behavior: {
      createState: () => null,
      event(call) { call.outputs[0].real = call.time === 0 ? 0 : call.time === 1 ? 4 : 8; if (call.time < 2) call.queue(call.time + 1); },
    } });
    const sample = (time: number) => {
      const outputs = new Float64Array(1);
      analog.load({ analysis: time === 0 ? 'dc' : 'tran', init: false, time, delta: 0, inputs: new Float64Array(), outputs, partials: new Float64Array(), notConverged() {} });
      return outputs[0];
    };
    net.operatingPoint(() => { sample(0); });
    net.beginTransient(() => {}, 0);
    net.processEvents(1, 0); net.processEvents(1, 0);
    expect(sample(1.5)).toBe(2);
    net.processEvents(2, 0); net.processEvents(2, 0);
    expect(sample(2)).toBe(4);
    expect(sample(3)).toBe(8); // ngspice-47 scales only the increment inside a ramp
    expect(sample(4)).toBe(16);
  });

  it('real_gain uses ic in DC and queues the initial transient evaluation', () => {
    const net = network('real_gain(ic=7 gain=3 delay=2n)', 'r1 r2');
    net.operatingPoint(() => {});
    net.beginTransient(() => {}, 0);
    expect(net.nextEventTime()).toBe(2e-9);
    net.processEvents(2e-9, 0);
    expect(net.nextEventTime()).toBe(4e-9);
  });

  it('real_delay has no DC output event without a rising clock', () => {
    const net = network('real_delay(delay=2n)', 'r clk out');
    net.operatingPoint(() => {});
    net.beginTransient(() => {}, 0);
    expect(net.nextEventTime()).toBe(Infinity);
  });

  it('real_to_v applies gain to real_gain DC ic on a differential analog output', async () => {
    const { dc } = await simulate(['real output', 'a1 r1 r2 gain', '.model gain real_gain(ic=4)', 'a2 r2 %vd out ref bridge', '.model bridge real_to_v(gain=99)', 'vref ref 0 2', 'r1 out 0 1k', '.op', '.end'].join('\n'));
    expect(dc!.voltage('out')).toBeCloseTo(398, 12);
  });
});
