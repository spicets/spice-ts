import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { DIGITAL_MODELS } from './digital-models.js';
import { STRONG, UNKNOWN, type EventOutput } from './event-network.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';

function harness(table = '00010111zx', outputs = 3) {
  const spec = XSPICE_CODE_MODEL_SPECS.get('d_genlut')!;
  const params = new Map(spec.params.map(p => [p.name, p.defaultValue!]));
  params.set('table_values', [table]);
  params.set('input_delay', [3, 5]);
  params.set('rise_delay', [7, 11]);
  params.set('fall_delay', [13]);
  const connections = spec.connections.map((c, i) => ({ name: c.name, direction: c.direction, isNull: false,
    ports: Array.from({ length: i === 0 ? 2 : outputs }, (_, j) => ({ type: 'd' as const, positive: `${c.name}${j}` })) }));
  const event = DIGITAL_MODELS.get('d_genlut')!(params, { connections, given: new Set(params.keys()) }).event;
  let state = event.createState();
  let init = true;
  return (inputs: number[], time = 0) => {
    const previous = state;
    state = structuredClone(state);
    const out: EventOutput[] = Array.from({ length: outputs }, () => ({ changed: true, state: UNKNOWN, strength: STRONG, delay: 0, load: 0 }));
    event.event({ analysis: time === 0 ? 'dc' : 'tran', init, time, previousTime: 0, state, previous, outputs: out,
      inputState: i => inputs[i], inputValue: i => ({ state: inputs[i], strength: STRONG }), inputReal: () => 0,
      queue() {}, probeExternal: i => ({ state: inputs[i], strength: STRONG }), setBreakpoint() {},
      setTemporaryBreakpoint: () => true, scheduleOutput() {} });
    init = false;
    return out;
  };
}

describe('ngspice-47 d_genlut', () => {
  it('uses output-major tables, LSB-first inputs, z and unknown/missing entries', () => {
    const step = harness();
    expect(step([0, 0]).map(o => [o.state, o.strength])).toEqual([[0, 0], [0, 0], [2, 2]]);
    expect(step([1, 0]).map(o => [o.state, o.strength])).toEqual([[0, 0], [1, 0], [2, 3]]);
    expect(step([0, 1]).map(o => [o.state, o.strength])).toEqual([[0, 0], [1, 0], [2, 3]]);
    expect(step([1, 1]).map(o => o.state)).toEqual([1, 1, 2]);
    expect(step([UNKNOWN, 0]).every(o => o.state === UNKNOWN && o.strength === 3)).toBe(true);
  });

  it('adds the maximum changed-input delay and repeats the last output delay', () => {
    const step = harness('000100010001');
    step([0, 0]);
    expect(step([1, 1], 1).map(o => o.delay)).toEqual([12, 16, 16]);
    expect(step([0, 1], 2).map(o => o.delay)).toEqual([16, 16, 16]);
    expect(step([0, 0], 3).every(o => !o.changed)).toBe(true);
  });

  it('executes the unchanged upstream vector parameter fixture', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/numparam/vector_param.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    const events = result.transient!.digital('node3');
    // ngspice-47 on the identical deck: eprint node3 (including drive strength).
    expect(events.map(e => e.state + e.strength)).toEqual(['0s', 'Uu', '1s', '0s', 'Uu', '1s', '0s', 'Uu', '1s', '0s']);
    const times = [0, .001425602, .001445602, .001685602, .002425602, .002445602, .002685602, .003425602, .003445602, .003685602];
    events.forEach((event, i) => expect(event.time).toBeCloseTo(times[i], 14));
    expect(result.transient!.voltage('sine').length).toBeGreaterThan(100);
  });
});
