import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';
import { microstrip, dispersion, mlin } from './mlin.js';
import type { CodeModelCall } from './models.js';

const deck = (load: number, params = '') => `microstrip
v1 in 0 dc 1 ac 1
r1 out 0 ${load}
a1 %hd(in 0) %hd(out 0) %vd(in 0) %vd(out 0) m
.model m mlin(w=1e-3 h=1e-3 er=9.8 l=.01 t=0 rho=0 tand=0 ${params})
`;

describe('XSPICE mlin', () => {
  it('matches Hammerstad-Jensen quasi-static values', () => {
    const { z0, epsilon } = microstrip(1e-3, 1e-3, 0, 9.8);
    expect(z0).toBeCloseTo(49.322921851615675, 11);
    expect(epsilon).toBeCloseTo(6.579026554066487, 12);
    expect(microstrip(1e-3, 1e-3, 35e-6, 9.8)).toEqual({ z0: 48.489978895053405, epsilon: 6.436312364522074 });
  });
  it('is an ideal DC short like ngspice-47, including finite rho', async () => {
    const result = await simulate(`${deck(50, 't=35u rho=22n')}.op\n.end`);
    expect(result.dc!.voltage('out')).toBeCloseTo(1, 10);
    expect(result.dc!.current('v1')).toBeCloseTo(-.02, 10);
  });
  const quasi = microstrip(.001, .001, 0, 9.8);
  const lossless = dispersion(1, 1, 9.8, quasi.z0, quasi.epsilon);
  for (const load of [lossless.z0, 1000]) {
    it(`matches hand-computed lossless input impedance, load=${load}`, async () => {
      const { z0, epsilon } = lossless;
      const result = await simulate(`${deck(load)}.ac lin 1 1g 1g\n.end`);
      const i = result.ac!.current('v1')[0];
      const phase = i.phase * Math.PI / 180;
      const actual = { re: -Math.cos(phase) / i.magnitude, im: Math.sin(phase) / i.magnitude };
      const q = Math.tan(2 * Math.PI * 1e9 / 299792458 * Math.sqrt(epsilon) * .01);
      const d = z0 * z0 + load * load * q * q;
      expect(actual.re).toBeCloseTo(z0 * z0 * load * (1 + q * q) / d, 7);
      expect(actual.im).toBeCloseTo(z0 * (z0 * z0 - load * load) * q / d, 7);
    });
  }
  it.each([0, 1])('preserves a DC bias in transient mode %i', async tranmodel => {
    const result = await simulate(`${deck(50, `tranmodel=${tranmodel}`)}.tran 1p 100p\n.end`);
    for (const voltage of result.transient!.voltage('out')) expect(voltage).toBeCloseTo(1, 8);
  });
  it('propagates a step after the analytic microstrip delay', async () => {
    const delay = .01 * Math.sqrt(quasi.epsilon) / 299792458;
    const timestep = 1e-12;
    const result = await simulate(`delayed step
v1 source 0 pulse(0 1 200p 1p 1p 500p 2n)
rs source in ${quasi.z0}
rload out 0 ${quasi.z0}
a1 %hd(in 0) %hd(out 0) %vd(in 0) %vd(out 0) m
.model m mlin(w=1m h=1m er=9.8 l=.01 t=0 rho=0 tand=0 tranmodel=1)
.tran 1p 400p 0 1p
.end`);
    const times = result.transient!.time;
    const crossing = (node: string) => times[result.transient!.voltage(node).findIndex(v => v >= .25)];
    expect(Math.abs(crossing('out') - crossing('in') - delay)).toBeLessThanOrEqual(2 * timestep);
  });
  it('rejects unknown transient modes with a typed error', async () => {
    await expect(simulate(`${deck(50, 'tranmodel=2')}.tran 1p 10p\n.end`)).rejects.toMatchObject({ code: 'UNSUPPORTED_XSPICE_MLIN' });
  });
  it('keeps ceiling-sampled bidirectional history isolated from rejected trials and resets', () => {
    const delay = .01 * Math.sqrt(quasi.epsilon) / 299792458;
    const behavior = mlin(new Map(Object.entries({ w: .001, h: .001, t: 0, er: 9.8, l: .01,
      rho: 0, tand: 0, d: 0, model: 0, disp: 0, tranmodel: 1 }).map(([k, v]) => [k, [v]])));
    const call = (time: number, v1 = 0, v2 = 0): CodeModelCall => ({ time, delta: delay / 10,
      analysis: 'tran', init: false, inputs: Float64Array.of(0, 0, v1, v2),
      outputs: new Float64Array(2), partials: new Float64Array(8), notConverged() {} });
    behavior.accept!(call(0));
    behavior.accept!(call(.2 * delay, 2, 3));
    behavior.load(call(.5 * delay, 999, 999)); // rejected future trial
    const trial = call(1.1 * delay);
    behavior.load(trial);
    behavior.load(trial); // repeated Newton loads must not advance history
    expect([...trial.outputs]).toEqual([3, 2]);
    expect([...trial.partials]).toEqual([quasi.z0, 0, 0, 0, 0, quasi.z0, 0, 0]);
    behavior.accept!(call(.2 * delay, 4, 5)); // replace rolled-back point
    behavior.load(trial);
    expect([...trial.outputs]).toEqual([5, 4]);
    behavior.reset!();
    behavior.load(trial);
    expect([...trial.outputs]).toEqual([0, 0]);
  });
  it('runs the unchanged ngspice mlin_tran.cir fixture', async () => {
    const input = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/xspice/transmission_lines/mlin_tran.cir', import.meta.url), 'utf8');
    const result = await simulate(input);
    expect(result.transient!.time.at(-1)).toBeCloseTo(5e-9, 18);
    expect(result.transient!.voltage('out').every(Number.isFinite)).toBe(true);
    expect(Math.max(...result.transient!.voltage('out'))).toBeGreaterThan(1);
  });
  it('rejects unsupported dispersion', async () => {
    await expect(simulate(`${deck(50, 'disp=1')}.op\n.end`)).rejects.toThrow('disp=0');
  });
});
