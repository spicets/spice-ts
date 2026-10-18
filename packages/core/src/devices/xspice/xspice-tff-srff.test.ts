import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { DIGITAL_MODELS } from './digital-models.js';
import { ONE, STRONG, UNKNOWN, ZERO, type EventOutput } from './event-network.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';

const invert = (value: number) => value === UNKNOWN ? UNKNOWN : 1 - value;
const states = [ZERO, ONE, UNKNOWN];
function harness(model: string, ic: number, omitted: string[] = []) {
  const names = [...(model === 'd_tff' ? ['t'] : ['s', 'r']), 'clk', 'set', 'reset', 'out', 'nout'];
  const params = new Map(XSPICE_CODE_MODEL_SPECS.get(model)!.params.map(p => [p.name, p.defaultValue!]));
  for (const [name, value] of Object.entries({ ic, clk_delay: 10, set_delay: 20, reset_delay: 30, rise_delay: 2, fall_delay: 3 })) params.set(name, [value]);
  const connections = names.map(name => ({ name, direction: (['out', 'nout'].includes(name) ? 'out' : 'in') as 'out' | 'in', isNull: omitted.includes(name), ports: omitted.includes(name) ? [] : [{ type: 'd' as const, positive: name }] }));
  const event = DIGITAL_MODELS.get(model)!(params, { connections, given: new Set(params.keys()) }).event;
  let state = event.createState();
  const inputs: Record<string, number> = Object.fromEntries(names.map(name => [name, ZERO]));
  return (changes: Record<string, number>, time = 1) => {
    Object.assign(inputs, changes);
    const previous = state;
    state = structuredClone(state);
    const outputs: EventOutput[] = connections.filter(c => c.direction === 'out' && !c.isNull).map(() => ({ changed: true, state: UNKNOWN, strength: STRONG, delay: 0, load: 0 }));
    event.event({ analysis: time === 0 ? 'dc' : 'tran', init: time === 0, time, state, previous, outputs,
      inputState: i => inputs[connections.filter(c => c.direction === 'in' && !c.isNull)[i].name],
      inputValue() { throw new Error('unused'); }, probeExternal() { throw new Error('unused'); },
      previousTime: 0, setTemporaryBreakpoint: () => false,
      setBreakpoint() {}, scheduleOutput() {} });
    return outputs;
  };
}

// Literal tables from ngspice-47 digital/{d_tff,d_srff}/cfunc.mod.
for (const model of ['d_tff', 'd_srff']) describe(model, () => {
  for (const ic of states) for (const a of states) for (const b of model === 'd_tff' ? [ZERO] : states) {
    it(`clock truth table ic=${ic}, inputs=${a},${b}`, () => {
      const step = harness(model, ic);
      const data: Record<string, number> = model === 'd_tff' ? { t: a } : { s: a, r: b };
      expect(step(data, 0).map(o => o.state)).toEqual([ic, invert(ic)]);
      expect(step(data).every(o => !o.changed)).toBe(true);
      expect(step({ clk: UNKNOWN }).every(o => !o.changed)).toBe(true);
      const expected = model === 'd_tff'
        ? a === UNKNOWN ? UNKNOWN : a === ZERO ? ic : invert(ic)
        : a === UNKNOWN || b === UNKNOWN || (a === ONE && b === ONE) ? UNKNOWN : a === ONE ? ONE : b === ONE ? ZERO : ic;
      const out = step({ clk: ONE });
      expect(out.every(o => o.changed)).toBe(expected !== ic);
      if (expected !== ic) {
        const rise = expected === ONE || (expected === UNKNOWN && ic === ZERO);
        expect(out.map(o => [o.state, o.delay])).toEqual([[expected, rise ? 12 : 13], [invert(expected), rise ? 13 : 12]]);
      }
      expect(step({ clk: ZERO }).every(o => !o.changed)).toBe(true);
    });
  }
  for (const ic of states) for (const set of states) for (const reset of states) {
    it(`DC ic=${ic} set=${set} reset=${reset}`, () => {
      const step = harness(model, ic);
      const expected = set === ONE && reset === ONE ? UNKNOWN : set === ONE && reset === ZERO ? ONE : set === ZERO && reset === ONE ? ZERO : ic;
      expect(step({ set, reset }, 0).map(o => o.state)).toEqual([expected, invert(expected)]);
    });
  }
  it('asynchronous priority, release, conflicts, inhibition and delays', () => {
    const step = harness(model, ZERO);
    step({}, 0);
    expect(step({ set: ONE }).map(o => [o.state, o.delay])).toEqual([[ONE, 22], [ZERO, 23]]);
    expect(step({ clk: ONE, t: ONE, s: ZERO, r: ONE }).every(o => !o.changed)).toBe(true);
    expect(step({ reset: ONE }).map(o => [o.state, o.delay])).toEqual([[UNKNOWN, 33], [UNKNOWN, 32]]);
    expect(step({ set: ZERO }).map(o => [o.state, o.delay])).toEqual([[ZERO, 23], [ONE, 22]]);
    expect(step({ reset: ZERO }).every(o => !o.changed)).toBe(true);
    expect(step({ set: ONE, reset: ONE }).map(o => [o.state, o.delay])).toEqual([[UNKNOWN, 22], [UNKNOWN, 23]]);
    expect(step({ set: UNKNOWN }).map(o => [o.state, o.delay])).toEqual([[ZERO, 23], [ONE, 22]]);
    expect(step({ reset: UNKNOWN }).every(o => !o.changed)).toBe(true);
  });
  it('unknown controls repost forced output without rise/fall delay', () => {
    const reset = harness(model, ZERO);
    reset({ reset: ONE }, 0);
    expect(reset({ set: UNKNOWN }).map(o => [o.changed, o.state, o.delay])).toEqual([[true, ZERO, 20], [true, ONE, 20]]);
    const set = harness(model, ZERO);
    set({ set: ONE }, 0);
    expect(set({ reset: UNKNOWN }).map(o => [o.changed, o.state, o.delay])).toEqual([[true, ONE, 30], [true, ZERO, 30]]);
  });
  it('NULL controls and either NULL output preserve flattened indices', () => {
    for (const omitted of [['set', 'reset', 'out'], ['set', 'reset', 'nout']]) {
      const step = harness(model, ZERO, omitted);
      expect(step({}, 0).map(o => o.state)).toEqual([omitted.includes('out') ? ONE : ZERO]);
      expect(step({ clk: ONE, t: ONE, s: ONE }).map(o => o.state)).toEqual([omitted.includes('out') ? ZERO : ONE]);
    }
  });
  it('parses and simulates through the public API', async () => {
    const data = model === 'd_tff' ? 'high' : 'high low';
    const result = await simulate(`flip flop
v1 clk 0 PULSE(0 1 1u 1n 1n 1u 2u)
aadc [clk] [c] adc
.model adc adc_bridge
apull high up
.model up d_pullup
alow low down
.model down d_pulldown
aff ${data} c NULL NULL q nq ff
.model ff ${model}
r1 clk 0 1k
.tran 10n 5u
.end`);
    expect(result.transient!.digital('q').map(e => e.state)).toContain('1');
  });
  it('matches committed ngspice-47 event states and edge times within 1 ps', async () => {
    const base = new URL(`../../../../../benchmarks/xspice-tff-srff-1254/${model}`, import.meta.url);
    const deck = readFileSync(new URL(`${base.href}.cir`), 'utf8');
    const reference = readFileSync(new URL(`${base.href}.ngspice.tsv`), 'utf8')
      .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(/\s+/));
    const result = await simulate(deck);
    for (const [column, signal] of ['q', 'nq'].entries()) {
      const expected = reference.filter((row, i) => i === 0 || row[column + 1] !== reference[i - 1][column + 1]);
      const actual = result.transient!.digital(signal);
      expect(actual.map(e => e.state)).toEqual(expected.map(row => row[column + 1][0]));
      const errors = actual.map((event, i) => Math.abs(event.time - Number(expected[i][0])));
      expect(Math.max(...errors)).toBeLessThanOrEqual(1e-12);
      console.info(`${model} ${signal}: ${actual.length - 1} edges, max timing error ${Math.max(...errors)} s`);
    }
  });
});
