import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parseXspiceModelCard } from '../../parser/xspice-parser.js';
import { XSPICE_BEHAVIORS, type CodeModelCall, type ResolvedXspiceParams } from './models.js';

function source(fraction: boolean, limit: boolean) {
  const params: ResolvedXspiceParams = new Map([
    ['x_array', [0, 1, 3]], ['y_array', [0, 2, 0]],
    ['input_domain', [0.2]], ['fraction', [fraction]], ['limit', [limit]],
  ]);
  parseXspiceModelCard(`.model p pwlts(x_array=[0 1 3] y_array=[0 2 0] fraction=${fraction} limit=${limit})`, 1);
  const factory = XSPICE_BEHAVIORS.get('pwlts')!;
  return factory(params, { connections: [], netlist: { capacitance: () => 0, inductance: () => 0 } });
}

function value(model: ReturnType<typeof source>, time: number, analysis: CodeModelCall['analysis'] = 'tran') {
  const outputs = new Float64Array(1);
  model.load({ analysis, init: false, time, delta: 0.1, inputs: new Float64Array(0),
    outputs, partials: new Float64Array(0), notConverged: () => { throw new Error('time must not be limited'); } });
  return outputs[0];
}

describe('XSPICE pwlts time source', () => {
  it('uses absolute parabolic smoothing, extrapolation and no Newton input limiter', () => {
    const model = source(false, false);
    for (const [time, expected] of [[-1, -2], [0, 0], [0.5, 1], [0.8, 1.6], [0.9, 1.7625],
      [1, 1.85], [1.1, 1.8625], [1.2, 1.8], [2, 1], [3, 0], [4, -1]]) {
      expect(value(model, time)).toBeCloseTo(expected, 12);
    }
  });

  it('scales fractional smoothing by the shorter adjacent segment and limits endpoints', () => {
    const model = source(true, true);
    for (const [time, expected] of [[-1, 0], [0, 0.1], [0.1, 0.225], [0.2, 0.4],
      [1, 1.85], [2.6, 0.4], [2.8, 0.225], [3, 0.1], [3.2, 0.025], [3.4, 0], [4, 0]]) {
      expect(value(model, time)).toBeCloseTo(expected, 12);
    }
    expect(model.breakpoints!()).toEqual([0.8, 1, 1.2, 2.6, 3, 3.4]);
  });

  it('schedules absolute smoothing boundaries and evaluates DC at zero', () => {
    const model = source(false, false);
    expect(model.breakpoints!()).toEqual([0.8, 1, 1.2, 2.8, 3, 3.2]);
    expect(value(model, 0, 'dc')).toBe(0);
  });

  it('runs the unchanged upstream pwlts1 fixture and lands on its corners', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/xspice/various/pwlts1.cir', import.meta.url), 'utf8');
    const tran = (await simulate(deck)).transient!;
    expect(tran.time.at(-1)).toBeCloseTo(1.5, 12);
    for (const time of [0.08, 0.09, 0.1, 0.11, 0.12, 0.2, 0.8, 0.9, 1, 1.1]) {
      expect(Array.from(tran.time).some(t => Math.abs(t - time) < 1e-12)).toBe(true);
    }
    expect(tran.voltage('3').at(-1)).toBeCloseTo(1, 10);
    expect(tran.voltage('4').at(-1)).toBeCloseTo(0.2, 10);
  });

  it.each([
    'x_array=[0 1 1] y_array=[0 2 0]',
    'x_array=[0 1 3] y_array=[0 2]',
    'x_array=[0 0.1 3] y_array=[0 2 0] input_domain=0.2 fraction=false',
  ])('rejects invalid time arrays or overlapping smoothing: %s', async params => {
    await expect(simulate(`invalid pwlts\na1 out p\n.model p pwlts(${params})\n.op\n.end`)).rejects.toThrow(/XSPICE pwlts/);
  });

  it('stamps a differential current output in DC and has zero AC excitation', async () => {
    const result = await simulate('pwlts current\na1 %id(out 0) p\nr1 out 0 2\n.model p pwlts(x_array=[0 1] y_array=[3 3])\n.op\n.ac lin 1 1 1\n.end');
    expect(Math.abs(result.dc!.voltage('out'))).toBeCloseTo(6, 10);
    expect(result.ac!.voltage('out')[0].magnitude).toBe(0);
  });
});
