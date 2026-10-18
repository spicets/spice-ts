import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { DIGITAL_MODELS } from './digital-models.js';
import { HI_IMPEDANCE, STRONG, UNKNOWN, type EventOutput } from './event-network.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';

function harness(ic = 2, selectValue = 1) {
  const spec = XSPICE_CODE_MODEL_SPECS.get('d_ram')!;
  const params = new Map(spec.params.map(p => [p.name, p.defaultValue!]));
  params.set('ic', [ic]);
  params.set('select_value', [selectValue]);
  params.set('read_delay', [10]);
  const sizes = [2, 2, 2, 1, 2];
  const connections = spec.connections.map((c, i) => ({ name: c.name, direction: c.direction, isNull: false,
    ports: Array.from({ length: sizes[i] }, (_, j) => ({ type: 'd' as const, positive: `${c.name}${j}` })) }));
  const event = DIGITAL_MODELS.get('d_ram')!(params, { connections, given: new Set(params.keys()) }).event;
  let state = event.createState();
  let init = true;
  const inputs = [0, 0, 0, 0, 0, 1, 0]; // data[2], address[2] (LSB first), write_en, select[2]
  return (changes: Record<number, number>, time = 1) => {
    for (const [index, value] of Object.entries(changes)) inputs[Number(index)] = value;
    const previous = state;
    state = structuredClone(state);
    const outputs: EventOutput[] = Array.from({ length: 2 }, () => ({ changed: true, state: UNKNOWN, strength: STRONG, delay: 0, load: 0 }));
    event.event({ analysis: time === 0 ? 'dc' : 'tran', init, time, state, previous, outputs,
      inputState: i => inputs[i], setBreakpoint() {}, scheduleOutput() {} });
    init = false;
    return outputs;
  };
}
const values = (out: EventOutput[]) => out.map(o => [o.state, o.strength, o.delay]);

describe('ngspice-47 d_ram', () => {
  it('initializes every address with ic and delays read, write and select edges', () => {
    const step = harness(0);
    expect(values(step({}, 0))).toEqual([[0, STRONG, 0], [0, STRONG, 0]]);
    expect(values(step({ 0: 1, 4: 1 }))).toEqual([[1, HI_IMPEDANCE, 10], [0, HI_IMPEDANCE, 10]]);
    step({ 0: 0, 1: 1, 2: 1 });
    expect(values(step({ 4: 0 }))).toEqual([[0, STRONG, 10], [1, STRONG, 10]]);
    expect(values(step({ 2: 0 }))).toEqual([[1, STRONG, 10], [0, STRONG, 10]]);
    expect(values(step({ 3: 1 }))).toEqual([[0, STRONG, 10], [0, STRONG, 10]]);
    expect(values(step({ 5: 0 }))).toEqual([[UNKNOWN, HI_IMPEDANCE, 10], [UNKNOWN, HI_IMPEDANCE, 10]]);
    expect(step({ 0: 1, 4: 1 }).every(o => !o.changed)).toBe(true);
    step({ 4: 0, 5: 1 });
    expect(values(step({ 2: 1, 3: 0 }))).toEqual([[0, STRONG, 10], [1, STRONG, 10]]);
  });

  it('matches select_value LSB first, unknown selects deselect, and ic defaults to U', () => {
    const step = harness(2, 2);
    expect(values(step({}, 0))).toEqual([[UNKNOWN, HI_IMPEDANCE, 0], [UNKNOWN, HI_IMPEDANCE, 0]]);
    expect(values(step({ 5: 0, 6: 1 }))).toEqual([[UNKNOWN, STRONG, 10], [UNKNOWN, STRONG, 10]]);
    expect(values(step({ 5: UNKNOWN }))).toEqual([[UNKNOWN, HI_IMPEDANCE, 10], [UNKNOWN, HI_IMPEDANCE, 10]]);
    expect(step({ 4: 1 }).every(o => !o.changed)).toBe(true);
  });

  it('unknown read addresses preserve memory; unknown write addresses poison all words', () => {
    const step = harness(1);
    step({}, 0);
    expect(values(step({ 2: UNKNOWN }))).toEqual([[UNKNOWN, STRONG, 10], [UNKNOWN, STRONG, 10]]);
    expect(step({ 2: 0 }).map(o => o.state)).toEqual([1, 1]);
    step({ 2: UNKNOWN, 4: 1 });
    expect(step({ 2: 0, 4: 0 }).map(o => o.state)).toEqual([UNKNOWN, UNKNOWN]);
    step({ 0: 0, 1: UNKNOWN, 4: 1 });
    expect(step({ 4: 0 }).map(o => o.state)).toEqual([0, UNKNOWN]);
    expect(step({ 2: 1 }).map(o => o.state)).toEqual([UNKNOWN, UNKNOWN]);
  });

  it('unknown write enable writes on selection but reads when selection is unchanged', () => {
    const step = harness(0);
    step({ 5: 0 }, 0);
    expect(values(step({ 0: 1, 4: UNKNOWN, 5: 1 }))).toEqual([[1, HI_IMPEDANCE, 10], [0, HI_IMPEDANCE, 10]]);
    expect(values(step({ 0: 0 }))).toEqual([[1, STRONG, 10], [0, STRONG, 10]]);
  });

  it('parses a RAM deck and records the read_delay edge through the public simulator', async () => {
    const result = await simulate(`RAM\nvwe we 0 PULSE(0 1 1u 1n 1n 1u 4u)\naadc [we] [w] adc\n.model adc adc_bridge\napull high up\n.model up d_pullup\nalow low down\n.model down d_pulldown\naram [high low] [q0 q1] [low] w [high] ram\n.model ram d_ram(ic=0 read_delay=100n)\nr1 we 0 1k\n.tran 10n 4u\n.end`);
    const events = result.transient!.digital('q0');
    expect(events).toContainEqual(expect.objectContaining({ state: '1', strength: 's' }));
    const read = events.find(e => e.state === '1' && e.strength === 's')!;
    expect(read.time).toBeGreaterThan(2.1e-6);
    expect(read.time).toBeLessThan(2.11e-6);
  });
});
