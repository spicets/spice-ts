import { describe, expect, it } from 'vitest';
import { DIGITAL_MODELS } from './digital-models.js';
import { ONE, STRONG, UNKNOWN, ZERO, type EventOutput } from './event-network.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';

function harness(model: string, overrides: Record<string, number> = {}, omitted: string[] = []) {
  const spec = XSPICE_CODE_MODEL_SPECS.get(model)!;
  const params = new Map(spec.params.map(p => [p.name, p.defaultValue!]));
  for (const [name, value] of Object.entries({ data_delay: 10, sr_delay: 10, enable_delay: 20, set_delay: 30, reset_delay: 40, rise_delay: 2, fall_delay: 3, ...overrides })) params.set(name, [value]);
  const connections = spec.connections.map(c => ({ name: c.name, direction: c.direction, isNull: omitted.includes(c.name), ports: omitted.includes(c.name) ? [] : [{ type: 'd' as const, positive: c.name }] }));
  const event = DIGITAL_MODELS.get(model)!(params, { connections, given: new Set(params.keys()) }).event;
  let state = event.createState();
  const inputs: Record<string, number> = Object.fromEntries(connections.map(c => [c.name, ZERO]));
  return (changes: Record<string, number>, time = 1) => {
    Object.assign(inputs, changes);
    const previous = state;
    state = structuredClone(state);
    const outputs: EventOutput[] = connections.filter(c => c.direction === 'out' && !c.isNull).map(() => ({ changed: true, state: UNKNOWN, strength: STRONG, delay: 0, load: 0 }));
    event.event({ analysis: time === 0 ? 'dc' : 'tran', init: time === 0, time, state, previous, outputs,
      inputState: i => inputs[connections.filter(c => c.direction === 'in' && !c.isNull)[i].name],
      inputReal: () => 0, queue() {}, inputValue() { throw new Error('unused'); }, probeExternal() { throw new Error('unused'); },
      previousTime: 0, setTemporaryBreakpoint: () => false, setBreakpoint() {}, scheduleOutput() {} });
    return outputs;
  };
}

const states = [ZERO, ONE, UNKNOWN];
describe('ngspice-47 transparent latches', () => {
  for (const model of ['d_dlatch', 'd_srlatch']) {
    for (const ic of states) for (const s of states) for (const r of states) {
      it(`${model} truth table ic=${ic} data/S=${s} R=${r}`, () => {
        const step = harness(model, { ic });
        expect(step({}, 0).map(o => o.state)).toEqual([ic, ic === UNKNOWN ? UNKNOWN : 1 - ic]);
        const expected = model === 'd_dlatch' ? s : s === UNKNOWN || r === UNKNOWN || (s === ONE && r === ONE) ? UNKNOWN : s === ONE ? ONE : r === ONE ? ZERO : ic;
        const out = step({ enable: ONE, data: s, s, r });
        expect(out[0].changed).toBe(expected !== ic);
        if (expected !== ic) expect(out.map(o => o.state)).toEqual([expected, expected === UNKNOWN ? UNKNOWN : 1 - expected]);
      });
    }
    it(`${model} holds disabled, propagates enabled data, and prioritizes asynchronous controls`, () => {
      const step = harness(model);
      step({}, 0);
      expect(step({ data: ONE, s: ONE }).every(o => !o.changed)).toBe(true);
      expect(step({ enable: ONE }).map(o => [o.state, o.delay])).toEqual([[ONE, 22], [ZERO, 23]]);
      expect(step({ data: ZERO, s: ZERO, r: ONE }).map(o => [o.state, o.delay])).toEqual([[ZERO, 13], [ONE, 12]]);
      expect(step({ set: ONE }).map(o => [o.state, o.delay])).toEqual([[ONE, 32], [ZERO, 33]]);
      expect(step({ reset: ONE }).map(o => [o.state, o.delay])).toEqual([[UNKNOWN, 43], [UNKNOWN, 42]]);
      expect(step({ set: ZERO }).map(o => [o.state, o.delay])).toEqual([[ZERO, 33], [ONE, 32]]);
      expect(step({ reset: ZERO }).every(o => !o.changed)).toBe(true);
      expect(step({ enable: UNKNOWN, data: ONE, s: ONE, r: ZERO }).every(o => !o.changed)).toBe(true);
    });
    for (const control of ['set', 'reset']) for (const released of [ZERO, UNKNOWN]) {
      for (const enable of states) {
        it(`${model} ${control} release=${released} enable=${enable} reevaluates only when transparent`, () => {
          const step = harness(model);
          const value = control === 'set' ? ZERO : ONE;
          step({ enable, data: value, s: value, r: 1 - value }, 0);
          step({ [control]: ONE });
          const out = step({ [control]: released });
          if (enable !== ONE) {
            expect(out.every(o => !o.changed)).toBe(true);
          } else {
            const delay = control === 'set' ? 30 : 40;
            expect(out.map(o => [o.changed, o.state, o.delay])).toEqual([
              [true, value, delay + (value === ONE ? 2 : 3)],
              [true, 1 - value, delay + (value === ONE ? 3 : 2)],
            ]);
          }
        });
      }
      it(`${model} ${control} release=${released} propagates unknown synchronous input`, () => {
        const step = harness(model);
        step({ enable: ONE, data: UNKNOWN, s: UNKNOWN }, 0);
        step({ [control]: ONE });
        const delay = control === 'set' ? 30 : 40;
        expect(step({ [control]: released }).map(o => [o.changed, o.state, o.delay])).toEqual([
          [true, UNKNOWN, delay + (control === 'set' ? 3 : 2)],
          [true, UNKNOWN, delay + (control === 'set' ? 2 : 3)],
        ]);
      });
    }
    it(`${model} supports NULL controls and complementary output`, () => {
      const step = harness(model, { ic: ONE }, ['set', 'reset', 'out']);
      expect(step({}, 0).map(o => o.state)).toEqual([ZERO]);
    });
  }
  it('D latch is transparent at DC', () => {
    expect(harness('d_dlatch')({ enable: ONE, data: ONE }, 0).map(o => [o.state, o.delay])).toEqual([[ONE, 0], [ZERO, 0]]);
  });
});

for (const ic of states) it(`SR latch retains IC=${ic} with both synchronous inputs high at DC`, () => {
  expect(harness('d_srlatch', { ic })({ enable: ONE, s: ONE, r: ONE }, 0)[0].state).toBe(ic);
});

for (const model of ['d_dff', 'd_jkff', 'd_tff', 'd_srff']) {
  for (const control of ['set', 'reset']) for (const released of [ZERO, UNKNOWN]) {
    it(`${model} ${control} release=${released} does not capture without a new clock edge`, () => {
      const step = harness(model);
      const value = control === 'set' ? ZERO : ONE;
      step({ clk: ONE, data: value, j: value, k: 1 - value, t: ONE, s: value, r: 1 - value }, 0);
      step({ [control]: ONE });
      expect(step({ [control]: released }).every(o => !o.changed)).toBe(true);
    });
  }
}

describe('ngspice-47 frequency divider', () => {
  for (const factor of [1, 2, 4]) for (const high of [1, 2, 4]) {
    it(`divide factor ${factor}, high cycles ${high}`, () => {
      const step = harness('d_fdiv', { div_factor: factor, high_cycles: high });
      step({}, 0);
      let expected = ZERO;
      for (let edge = 1; edge <= 12; edge++) {
        step({ freq_in: ZERO });
        const count = (edge - 1) % factor + 1;
        const changed = count === 1 || count === high + 1;
        if (count === 1) expected = ONE;
        else if (count === high + 1) expected = ZERO;
        const out = step({ freq_in: ONE })[0];
        expect(out.changed).toBe(changed);
        if (changed) expect(out.state).toBe(expected);
      }
    });
  }
  it('counts rising edges, holds across unknown/falling inputs and wraps', () => {
    const step = harness('d_fdiv', { div_factor: 3, high_cycles: 2 });
    expect(step({}, 0)[0].state).toBe(ZERO);
    expect(step({ freq_in: ONE })[0]).toMatchObject({ changed: true, state: ONE, delay: 2 });
    expect(step({ freq_in: UNKNOWN })[0].changed).toBe(false);
    expect(step({ freq_in: ONE })[0].changed).toBe(false);
    step({ freq_in: ZERO });
    expect(step({ freq_in: ONE })[0]).toMatchObject({ changed: true, state: ZERO, delay: 3 });
    step({ freq_in: ZERO });
    expect(step({ freq_in: ONE })[0]).toMatchObject({ changed: true, state: ONE, delay: 2 });
  });
  for (const count of [0, 1, 2, 3, 4]) it(`initial count ${count}`, () => {
    const step = harness('d_fdiv', { div_factor: 4, high_cycles: 2, i_count: count });
    expect(step({}, 0)[0].state).toBe(count === 1 || count === 2 ? ONE : ZERO);
  });
});
