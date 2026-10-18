import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { seegen, SEEGEN_SPEC } from './seegen.js';
import type { CodeModelCall, XspiceBehaviorContext } from './models.js';

function setup(values: Record<string, number | boolean | number[]> = {}, controlled = false) {
  const params = new Map(SEEGEN_SPEC.params.map(p => [p.name, p.defaultValue!]));
  params.set('tperiod', [4.5e-9]);
  params.set('tdelay', [5e-9]);
  for (const [key, value] of Object.entries(values)) params.set(key, Array.isArray(value) ? value : [value]);
  const context: XspiceBehaviorContext = {
    connections: [
      { name: 'ctrl', direction: 'in', isNull: !controlled, ports: controlled ? [{ type: 'v' }] : [] },
      { name: 'mon', direction: 'out', isNull: false, ports: [{ type: 'v' }] },
      { name: 'out', direction: 'out', isNull: false, ports: [{ type: 'id' }, { type: 'id' }] },
    ],
    netlist: { capacitance: () => 0, inductance: () => 0 },
  };
  const behavior = seegen(params, context);
  const load = (time: number, ctrl = 0, commit = false, analysis: CodeModelCall['analysis'] = 'tran') => {
    const call: CodeModelCall = { analysis, time, delta: 0, init: false, inputs: Float64Array.of(ctrl), outputs: new Float64Array(3), partials: new Float64Array(3), notConverged() {} };
    behavior.load(call);
    if (commit) behavior.accept!(call);
    return Array.from(call.outputs);
  };
  load(0, 0, true, 'dc');
  return { behavior, load };
}

describe('ngspice-47 seegen', () => {
  // ngspice-47 seegenerator/cfunc.mod:293-298, Qc=1.035e-14*let*cdepth/cos(angle).
  it.each([[0, 0], [20e-12, 0.00012784621831462743], [100e-12, 0.000175085948810762], [500e-12, 0.00007932400449959766], [1e-9, 0.000029181670447894614]])('matches the C formula at delay + %s', (dt, expected) => {
    const { load } = setup();
    expect(load(5e-9 + dt)[1]).toBeCloseTo(expected, 15);
    expect(load(5e-9 + dt)[0]).toBeCloseTo(expected, 15);
    expect(load(4e-9)[1]).toBe(0);
  });

  it('applies let, depth, angle and explicit inull', () => {
    expect(setup({ let: 20, cdepth: 2, angle: Math.PI / 3 }).load(5.1e-9)[1]).toBeCloseTo(8 * 0.000175085948810762, 15);
    expect(setup({ inull: 1 }).load(5.1e-9)[1]).toBeCloseTo(0.8119928060788963, 14);
  });

  it('sequences ports, retains previous tails, stops and resets', () => {
    const { load, behavior } = setup();
    const tail = load(9e-9, 0, true)[1];
    load(9.1e-9, 0, true);
    expect(load(9.6e-9, 0, true)[1]).toBe(tail);
    expect(load(9.6e-9)[2]).toBeCloseTo(0.000175085948810762, 15);
    load(13.6e-9, 0, true);
    expect(behavior.breakpoints!()[0]).toBe(1e12);
    behavior.reset!();
    expect(load(5.1e-9)[1]).toBeCloseTo(0.000175085948810762, 15);
  });

  it('repeats only with perlim=false', () => {
    const { load } = setup({ perlim: false });
    load(9.1e-9, 0, true);
    load(13.6e-9, 0, true);
    expect(load(14.1e-9)[1]).toBeCloseTo(0.000175085948810762, 15);
  });

  it('restarts on rising control and does not commit rejected loads', () => {
    const { load, behavior } = setup({}, true);
    expect(load(6e-9)[1]).toBe(0);
    load(1e-9, 1); // rejected trial must not consume the rising edge
    load(2e-9, 1, true);
    expect(behavior.breakpoints!()[0]).toBeCloseTo(7e-9, 20);
    expect(load(7.1e-9, 1)[1]).toBeCloseTo(0.000175085948810762, 15);
    load(7.1e-9, 0, true);
    load(8e-9, 1, true);
    expect(behavior.breakpoints!()[0]).toBeCloseTo(13e-9, 20);
    expect(load(13e-9, 1, false, 'ac')).toEqual([0, 0, 0]);
  });

  it('normalizes scaled pulses and schedules each start and maximum', () => {
    const { load, behavior } = setup({ scaling: [0.25, 0.75], scdelay: [0, 1e-9] });
    expect(load(5.1e-9)[1]).toBeCloseTo(0.000175085948810762 / 4, 15);
    expect(load(5.1e-9)[2]).toBe(0);
    expect(load(6.1e-9)[2]).toBeCloseTo(0.000175085948810762 * 0.75, 15);
    expect(behavior.breakpoints!()).toHaveLength(4);
    expect(() => setup({ scaling: [0, 0], scdelay: [0, 0] })).toThrow('nonzero sum');
    expect(() => setup({ tperiod: 1e-9 })).toThrow('tperiod');
  });

  it('runs a seegen_cm1-style differential current output vector', async () => {
    const result = await simulate(`Test of seegen code model
aseegen1 NULL mon [%id(n1 p1) %id(n2 p2) %id(n3 p3)] seemod1
.model seemod1 seegen(tdelay=5n tperiod=4.5n)
Rsee1 n1 0 1
Vmeas1 p1 0 0
Rsee2 n2 0 1
Vmeas2 p2 0 0
Rsee3 n3 0 1
Vmeas3 p3 0 0
.tran 10p 35n
.end`);
    expect(result.transient!.time.at(-1)).toBeCloseTo(35e-9, 18);
    for (const node of ['n1', 'n2', 'n3']) {
      expect(Math.min(...result.transient!.voltage(node))).toBeLessThan(-1e-4);
    }
  });
});
