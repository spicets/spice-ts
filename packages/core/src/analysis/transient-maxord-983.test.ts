import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { parse } from '../parser/index.js';
import { simulate, simulateStream } from '../simulate.js';
import { resolveOptions } from '../types.js';

const RC = `MAXORD regression
V1 in 0 PULSE(0 1 0 1n 1n 1m 2m)
R1 in out 1k
C1 out 0 1n
.tran 20n 1u
`;

const pump = readFileSync(new URL('../../../../benchmarks/corpus/corpus-k/fixtures/xyce/Netlists/CircuitSim90/MOS2/pump.cir', import.meta.url), 'utf8');

describe('ngspice MAXORD order cap (#983)', () => {
  it('admits the original corpus-k MOS charge pump', () => {
    expect(() => parse(pump)).not.toThrow();
  });

  it('runs the original MOS charge pump to its stop time with finite results', async () => {
    const result = (await simulate(pump)).transient!;
    expect(result.time[result.time.length - 1]).toBeCloseTo(100e-9, 15);
    expect(result.voltage('5').every(Number.isFinite)).toBe(true);
  });

  it.each([0, 7, 1.5, Infinity, NaN])('rejects invalid API order caps: %s', maxOrder => {
    expect(() => resolveOptions({ maxOrder })).toThrow('maxOrder must be an integer from 1 to 6');
  });

  it('rejects Gear API maxOrder=7 with a typed error', () => {
    expect(() => resolveOptions({ integrationMethod: 'gear2', maxOrder: 7 })).toThrow(InvalidCircuitError);
  });

  it.each([4, 5, 6])('runs an RLC with Gear maxord=%i through netlist and API', async maxOrder => {
    const rlc = `Gear RLC\nV1 in 0 PULSE(0 1 0 1n 1n 1u 2u)\nR1 in out 1k\nL1 out cap 1m\nC1 cap 0 1n\n.tran 20n 1u\n`;
    const netlist = (await simulate(`${rlc}.options method=gear maxord=${maxOrder}\n.end`)).transient!;
    const api = (await simulate(rlc, { integrationMethod: 'gear2', maxOrder })).transient!;
    const capped = (await simulate(rlc, { integrationMethod: 'gear2', maxOrder: 3 })).transient!;
    expect(netlist.time.at(-1)).toBeCloseTo(1e-6, 15);
    expect(netlist.voltage('cap').every(Number.isFinite)).toBe(true);
    expect(netlist.time).toEqual(api.time);
    expect(netlist.voltage('cap')).toEqual(api.voltage('cap'));
    expect(api.time).toEqual(capped.time);
    expect(api.voltage('cap')).toEqual(capped.voltage('cap'));
  });

  it('runs Gear with an order-three cap through public netlist and API boundaries', async () => {
    const netlist = (await simulate(`${RC}.options method=gear maxord=3\n.end`)).transient!;
    const api = (await simulate(RC, { integrationMethod: 'gear2', maxOrder: 3 })).transient!;
    expect(netlist.time.at(-1)).toBeCloseTo(1e-6, 15);
    expect(netlist.voltage('out').every(Number.isFinite)).toBe(true);
    expect(Array.from(netlist.time)).toEqual(Array.from(api.time));
    expect(netlist.voltage('out')).toEqual(api.voltage('out'));
  });

  it('treats MAXORD=3 as a cap, matching native order-two selection on RC', async () => {
    const rc = `RC order selection
V1 in 0 DC 1
R1 in out 1k
C1 out 0 1n
.tran 10n 2u 0 10n uic
.end`;
    const order2 = (await simulate(rc, { integrationMethod: 'gear2', maxOrder: 2 })).transient!;
    const order3 = (await simulate(rc, { integrationMethod: 'gear2', maxOrder: 3 })).transient!;
    expect(order3.time).toEqual(order2.time);
    expect(order3.voltage('out')).toEqual(order2.voltage('out'));
  });

  it.each(['', 'timeint '])('uses backward Euler for %sMAXORD=1 with either METHOD', async prefix => {
    const euler = (await simulate(RC, { integrationMethod: 'euler' })).transient!;
    for (const method of ['trap', 'gear']) {
      const result = (await simulate(`${RC}.options ${prefix}method=${method} maxord=1\n.end`)).transient!;
      expect(Array.from(result.time)).toEqual(Array.from(euler.time));
      expect(result.voltage('out')).toEqual(euler.voltage('out'));
    }
  });

  it.each(['trap', 'gear'] as const)('retains %s order two for MAXORD=2', async method => {
    const expected = (await simulate(RC, { integrationMethod: method === 'trap' ? 'trapezoidal' : 'gear2' })).transient!;
    const result = (await simulate(`${RC}.options method=${method} maxord=2\n.end`)).transient!;
    expect(Array.from(result.time)).toEqual(Array.from(expected.time));
    expect(result.voltage('out')).toEqual(expected.voltage('out'));
  });

  it.each([
    '.options maxord=1 method=gear',
    '.options maxord=1\n.options method=gear',
    '.options method=gear\n.options maxord=1',
    '.options maxord=2\n.options maxord=1 method=trap',
    '.options maxord=0 method=trap',
  ])('keeps the cap independent of METHOD ordering: %s', async options => {
    const expected = (await simulate(RC, { integrationMethod: 'euler' })).transient!;
    const result = (await simulate(`${RC}${options}\n.end`)).transient!;
    expect(result.voltage('out')).toEqual(expected.voltage('out'));
  });

  it('restores order two after a later MAXORD=2', async () => {
    const expected = (await simulate(RC)).transient!;
    const result = (await simulate(`${RC}.options maxord=1\n.options maxord=2\n.end`)).transient!;
    expect(result.voltage('out')).toEqual(expected.voltage('out'));
  });

  it('applies the cap to streaming and parsed Circuit inputs', async () => {
    const expected = (await simulate(RC, { integrationMethod: 'euler' })).transient!;
    const circuit = parse(`${RC}.options method=gear maxord=1\n.end`);
    const times: number[] = [];
    const values: number[] = [];
    for await (const step of simulateStream(circuit)) {
      if ('time' in step) {
        times.push(step.time);
        values.push(step.voltages.get('out')!);
      }
    }
    expect(times).toEqual(Array.from(expected.time));
    expect(values).toEqual(expected.voltage('out'));
  });

  it('allows an explicit caller order cap to override the netlist', async () => {
    const expected = (await simulate(RC)).transient!;
    const actual = (await simulate(`${RC}.options maxord=1\n.end`, { maxOrder: 2 })).transient!;
    expect(actual.voltage('out')).toEqual(expected.voltage('out'));
  });
});
