import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { DIGITAL_MODELS } from './digital-models.js';
import { ONE, STRONG, UNKNOWN, ZERO, type EventOutput } from './event-network.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';

// Literal expectations from ngspice-47 digital/{d_jkff,d_dff}/cfunc.mod.
const invert = (value: number) => value === UNKNOWN ? UNKNOWN : 1 - value;
function harness(model: string, ic = ZERO, omitted: string[] = []) {
  const names = [...(model === 'd_jkff' ? ['j', 'k'] : ['data']), 'clk', 'set', 'reset', 'out', 'nout'];
  const params = new Map(XSPICE_CODE_MODEL_SPECS.get(model)!.params.map(p => [p.name, p.defaultValue!]));
  for (const [name, value] of Object.entries({ ic, clk_delay: 10, set_delay: 20, reset_delay: 30, rise_delay: 2, fall_delay: 3 })) params.set(name, [value]);
  const connections = names.map(name => ({ name, direction: (['out', 'nout'].includes(name) ? 'out' : 'in') as 'out' | 'in', isNull: omitted.includes(name), ports: omitted.includes(name) ? [] : [{ type: 'd' as const, positive: name }] }));
  const event = DIGITAL_MODELS.get(model)!(params, { connections, given: new Set(params.keys()) }).event;
  let state = event.createState();
  const inputs: Record<string, number> = Object.fromEntries(names.map(name => [name, ZERO]));
  let initial = true;
  return (changes: Record<string, number>, time = 1) => {
    Object.assign(inputs, changes);
    const previous = state;
    state = structuredClone(state);
    const outputs: EventOutput[] = connections.filter(c => c.direction === 'out' && !c.isNull).map(() => ({ changed: true, state: UNKNOWN, strength: STRONG, delay: 0, load: 0 }));
    event.event({ analysis: time === 0 ? 'dc' : 'tran', init: initial, time, state, previous, outputs,
      inputState: i => inputs[connections.filter(c => c.direction === 'in' && !c.isNull)[i].name],
      inputValue() { throw new Error('unused'); }, probeExternal() { throw new Error('unused'); },
      previousTime: 0, setTemporaryBreakpoint: () => false,
      setBreakpoint() {}, scheduleOutput() {} });
    initial = false;
    return outputs;
  };
}

const states = [ZERO, ONE, UNKNOWN];
describe('ngspice-47 d_jkff / d_dff', () => {
  for (const ic of states) for (const j of states) for (const k of states) {
    it(`JK truth table ic=${ic} J=${j} K=${k}`, () => {
      const step = harness('d_jkff', ic);
      expect(step({ j, k }, 0).map(o => o.state)).toEqual([ic, invert(ic)]);
      const expected = j === UNKNOWN || k === UNKNOWN ? UNKNOWN : j === ZERO ? k === ZERO ? ic : ZERO : k === ZERO ? ONE : invert(ic);
      const out = step({ clk: ONE });
      expect(out.every(o => o.changed)).toBe(expected !== ic);
      if (expected !== ic) expect(out.map(o => o.state)).toEqual([expected, invert(expected)]);
    });
  }
  for (const model of ['d_jkff', 'd_dff']) {
    for (const ic of states) for (const set of states) for (const reset of states) {
      it(`${model} DC ic=${ic} set=${set} reset=${reset}`, () => {
        const step = harness(model, ic);
        const expected = set === ONE && reset === ONE ? UNKNOWN : set === ONE && reset === ZERO ? ONE : set === ZERO && reset === ONE ? ZERO : ic;
        expect(step({ set, reset }, 0).map(o => o.state)).toEqual([expected, invert(expected)]);
      });
    }
    it(`${model} asynchronous priority, release, conflict and per-output delays`, () => {
      const step = harness(model);
      step({}, 0);
      expect(step({ set: ONE }).map(o => [o.state, o.delay])).toEqual([[ONE, 22], [ZERO, 23]]);
      expect(step({ reset: ONE }).map(o => [o.state, o.delay])).toEqual([[UNKNOWN, 33], [UNKNOWN, 32]]);
      expect(step({ set: ZERO }).map(o => [o.state, o.delay])).toEqual([[ZERO, 23], [ONE, 22]]);
      expect(step({ reset: ZERO }).every(o => !o.changed)).toBe(true);
      expect(step({ set: ONE, reset: ONE }).map(o => [o.state, o.delay])).toEqual([[UNKNOWN, 22], [UNKNOWN, 23]]);
      expect(step({ set: UNKNOWN }).map(o => [o.state, o.delay])).toEqual([[ZERO, 23], [ONE, 22]]);
      expect(step({ reset: UNKNOWN }).every(o => !o.changed)).toBe(true);
    });
    it(`${model} only edges ending at ONE capture; data alone does not`, () => {
      const step = harness(model);
      step({}, 0);
      expect(step({ data: ONE, j: ONE, k: ZERO }).every(o => !o.changed)).toBe(true);
      expect(step({ clk: UNKNOWN }).every(o => !o.changed)).toBe(true);
      expect(step({ clk: ONE }).map(o => [o.state, o.delay])).toEqual([[ONE, 12], [ZERO, 13]]);
      expect(step({ clk: ZERO, data: ZERO, j: ZERO, k: ONE }).every(o => !o.changed)).toBe(true);
      expect(step({ clk: ONE }).map(o => [o.state, o.delay])).toEqual([[ZERO, 13], [ONE, 12]]);
    });
    it(`${model} unknown controls hold, asserted controls inhibit clocks`, () => {
      const step = harness(model);
      step({}, 0);
      expect(step({ set: UNKNOWN }).every(o => !o.changed)).toBe(true);
      expect(step({ clk: ONE, data: ONE, j: ONE }).map(o => o.state)).toEqual([ONE, ZERO]);
      step({ set: ONE, clk: ZERO });
      expect(step({ clk: ONE, data: ZERO, j: ZERO, k: ONE }).every(o => !o.changed)).toBe(true);
    });
    it(`${model} null inputs and either null output retain flattened port indices`, () => {
      for (const omitted of [['set', 'reset', 'out'], ['set', 'reset', 'nout']]) {
        const step = harness(model, ZERO, omitted);
        expect(step({}, 0).map(o => o.state)).toEqual([omitted.includes('out') ? ONE : ZERO]);
        expect(step({ clk: ONE, data: ONE, j: ONE }).map(o => o.state)).toEqual([omitted.includes('out') ? ZERO : ONE]);
      }
    });
  }
  for (const model of ['d_jkff', 'd_dff']) {
    it(`${model} unknown control re-posts unchanged forced output without edge delay`, () => {
      const reset = harness(model);
      reset({ reset: ONE }, 0);
      expect(reset({ set: UNKNOWN }).map(o => [o.changed, o.state, o.delay])).toEqual([[true, ZERO, 20], [true, ONE, 20]]);
      const set = harness(model);
      set({ set: ONE }, 0);
      expect(set({ reset: UNKNOWN }).map(o => [o.changed, o.state, o.delay])).toEqual([[true, ONE, 30], [true, ZERO, 30]]);
    });
  }
  for (const ic of states) for (const data of states) {
    it(`DFF capture ic=${ic} D=${data}`, () => {
      const step = harness('d_dff', ic);
      step({ data }, 0);
      const out = step({ clk: ONE });
      expect(out.every(o => o.changed)).toBe(data !== ic);
      if (data !== ic) expect(out.map(o => o.state)).toEqual([data, invert(data)]);
    });
  }
  for (const model of ['d_jkff', 'd_dff']) {
    it(`${model} parses and runs through the public simulator`, async () => {
      const result = await simulate(`flip flop\nv1 clk 0 PULSE(0 1 1u 1n 1n 1u 2u)\naadc [clk] [c] adc\n.model adc adc_bridge\napull high up\n.model up d_pullup\naff ${model === 'd_jkff' ? 'high high' : 'high'} c NULL NULL q nq ff\n.model ff ${model}\nr1 clk 0 1k\n.tran 10n 5u\n.end`);
      expect(result).toBeDefined();
      expect(result.transient!.digital('q').map(e => e.state)).toContain('1');
    });
  }
});
