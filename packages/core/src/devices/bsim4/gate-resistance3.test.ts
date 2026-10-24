import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';

const base = new URL('./__fixtures__/rgatemod3/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as {
  cases: { deck: string; sha256: string; op: number[]; dc: number[][]; ac: number[][] }[];
};
const quantities = ['d', 'g', 's', 'b', 'M1.gate', 'M1.midgate', 'Vdd', 'Vg', 'Vs', 'Vb'];

describe('BSIM4 RGATEMOD=3 static and AC gate network', () => {
  for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) {
    it(`conserves six-node KCL and Jacobian: polarity=${polarity}, Vds=${vds}`, () => {
      const device = new BSIM4('M1', [0, 1, 2, 3, 4, 5],
        { LEVEL: 54, RGATEMOD: 3, RSHG: 1e6, IGCMOD: 1, TOXE: 1e-9 },
        { L: 1e-6, W: 10e-6, NF: 2, M: 3, MULT_I: 2 }, polarity);
      const voltage = [0.4 + polarity * vds, 0.4 + polarity * 1.5, 0.4, 0.2,
        0.4 + polarity * 1.4, 0.4 + polarity * 1.45];
      function stamp(v: number[]) {
        let G = new Float64Array(36), B = new Float64Array(6);
        const ctx: StampContext = {
          stampG: (r, c, x) => { G[r * 6 + c] += x; }, stampB: (r, x) => { B[r] += x; },
          stampC: () => { throw new Error('DC must not stamp C'); }, getVoltage: n => v[n], getCurrent: () => 0,
          time: 0, dt: 0, numNodes: 6, sourceScale: 1, useDcSourceValue: true,
        };
        for (let n = 0; n < 20; n++) { G = new Float64Array(36); B = new Float64Array(6); device.stamp(ctx); }
        expect(device.limitedLastStamp()).toBe(false);
        return { G, current: v.map((_, r) => v.reduce((sum, x, c) => sum + G[r * 6 + c] * x, -B[r])) };
      }
      const { G, current } = stamp(voltage);
      expect(current.reduce((sum, x) => sum + x, 0)).toBeCloseTo(0, 13);
      for (let c = 0; c < 6; c++) {
        const h = 1e-5, hi = [...voltage], lo = [...voltage]; hi[c] += h; lo[c] -= h;
        const high = stamp(hi).current, low = stamp(lo).current;
        for (let r = 0; r < 6; r++) {
          const fd = (high[r] - low[r]) / (2 * h);
          expect(Math.abs(fd - G[r * 6 + c]) / Math.max(Math.abs(fd), 1e-10)).toBeLessThan(2e-5);
        }
      }
    });
  }
  for (const item of reference.cases) it(`${item.deck}: identical-deck ngspice-47 OP/DC/AC`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
    const result = await simulate(deck);
    const errors = { op: 0, dc: 0, ac: 0 };
    const absolute = { op: 0, dc: 0, ac: 0 };
    function check(actual: number, expected: number, analysis: keyof typeof errors, label: string) {
      const abs = Math.abs(actual - expected), rel = abs / Math.max(Math.abs(expected), 1e-30);
      errors[analysis] = Math.max(errors[analysis], rel);
      absolute[analysis] = Math.max(absolute[analysis], abs);
      expect(analysis === 'ac' ? abs <= 1e-12 || rel <= 1e-6 : expected === 0 ? abs <= 1e-20 : rel <= 1e-6,
        `${analysis} ${label}: actual=${actual}, expected=${expected}, rel=${rel}`).toBe(true);
    }
    quantities.forEach((name, index) => {
      check(index < 6 ? result.dc!.voltage(name) : result.dc!.current(name), item.op[index], 'op', name);
      const dc = index < 6 ? result.dcSweep!.voltage(name) : result.dcSweep!.current(name);
      expect(dc).toHaveLength(item.dc.length);
      item.dc.forEach((row, n) => check(dc[n], row[index + 1], 'dc', `${name} ${row[0]}`));
      const ac = index < 6 ? result.ac!.voltage(name) : result.ac!.current(name);
      expect(ac).toHaveLength(item.ac.length);
      item.ac.forEach((row, n) => {
        check(result.ac!.frequencies[n], row[0], 'ac', 'frequency');
        const phase = ac[n].phase * Math.PI / 180;
        check(ac[n].magnitude * Math.cos(phase), row[1 + 2 * index], 'ac', `${name} real ${row[0]}`);
        check(ac[n].magnitude * Math.sin(phase), row[2 + 2 * index], 'ac', `${name} imag ${row[0]}`);
      });
    });
    expect(Math.abs(result.dc!.voltage('g') - result.dc!.voltage('M1.gate'))).toBeGreaterThan(1e-6);
    console.info(`${item.deck}: max relative ${JSON.stringify(errors)}, max absolute ${JSON.stringify(absolute)}`);
  });
  for (const item of reference.cases) it(`${item.deck}: supports transient with split overlap charge`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8').replace('.ac dec 3 1k 1g', '.tran 1n 10n');
    const result = (await simulate(deck)).transient!;
    expect(result.time.at(-1)).toBeCloseTo(10e-9, 18);
    expect(Array.from(result.voltage('M1.midgate')).every(Number.isFinite)).toBe(true);
  });
});
