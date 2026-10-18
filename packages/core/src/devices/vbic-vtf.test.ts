import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';
import type { StampContext } from './device.js';
import { VBIC, resolveVBICParams } from './vbic.js';

// Local nodes CX CI BX BI EI BP SI. Record the public DC/AC/TRAN stamps.
function stamps(params: Record<string, number>, vbe: number, vbc: number, polarity = 1, temperature = 27, area = 1) {
  const v = [vbe - vbc, vbe - vbc, vbe, vbe, 0, 0, 0].map(x => x * polarity);
  const g = Array.from({ length: 7 }, () => new Float64Array(7));
  const cap = Array.from({ length: 7 }, () => new Float64Array(7));
  const rhs = new Float64Array(7);
  const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], params, polarity, area);
  device.setTemperature(temperature);
  const ctx: StampContext = {
    stampG: (r, c, x) => { g[r][c] += x; }, stampC: (r, c, x) => { cap[r][c] += x; },
    stampB: (r, x) => { rhs[r] += x; }, getVoltage: n => v[n], getCurrent: () => 0,
    time: 0, dt: 1, numNodes: 7, sourceScale: 1, useDcSourceValue: false, gmin: 0,
  };
  for (let i = 0; i < 12; i++) {
    g.forEach(row => row.fill(0)); rhs.fill(0); device.stamp(ctx);
  }
  const dc = [g.map(row => [...row]), [...rhs]];
  device.stampDynamic(ctx);
  device.resetTransient();
  const bias = [...v]; v.fill(0); device.acceptTransientStep(ctx);
  v.splice(0, v.length, ...bias);
  g.forEach(row => row.fill(0)); rhs.fill(0);
  device.stampTransientCharge(ctx, { method: 'euler', dt: 1 });
  const q = polarity * (g[3].reduce((sum, x, col) => sum + x * v[col], 0) - rhs[3]);
  return { q, cap, g, all: [dc, cap.map(row => [...row]), g.map(row => [...row]), [...rhs]] };
}

const baselineParams = { TF: 1.1e-12, XTF: 21.5423, ITF: 0.0175231, CJE: 2e-15, CJC: 3e-15, VEF: 100, VER: 10 };
function fingerprint(extra: Record<string, number>) {
  const results = [1, -1].flatMap(polarity => [0, 27, 75].flatMap(temperature =>
    [-0.2, 0, 0.65].map(vbe => stamps({ ...baselineParams, ...extra }, vbe, -0.4, polarity, temperature).all)));
  return createHash('sha256').update(JSON.stringify(results)).digest('hex');
}

describe('VBIC VTF forward transit-time Vbc dependence (#1300)', () => {
  it('matches ngspice-47 AC and transient on identical netlist bytes', async () => {
    type Plot = { grid: number[]; signals: Record<string, { re: number; im: number }[]> };
    const reference = JSON.parse(readFileSync('../../benchmarks/vbic-vtf/ngspice-47.json', 'utf8')) as {
      sha256: string; ac: Plot; transient: Plot;
    };
    const deck = readFileSync('../../benchmarks/vbic-vtf/vtf.cir', 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(reference.sha256);
    const result = await simulate(deck);
    expect(result.ac!.frequencies).toHaveLength(reference.ac.grid.length);
    const tran = result.transient!;
    expect(tran.time[0]).toBeLessThanOrEqual(reference.transient.grid[0]);
    expect(tran.time.at(-1)).toBeGreaterThanOrEqual(reference.transient.grid.at(-1)!);
    for (const node of ['c', 'b']) {
      const complex = result.ac!.voltage(node);
      const expectedAc = reference.ac.signals[`v(${node})`];
      const peakAc = Math.max(...expectedAc.map(x => Math.hypot(x.re, x.im)));
      const acErrors = expectedAc.map((x, i) => {
        expect(result.ac!.frequencies[i] / reference.ac.grid[i]).toBeCloseTo(1, 12);
        const phase = complex[i].phase * Math.PI / 180;
        return Math.hypot(complex[i].magnitude * Math.cos(phase) - x.re, complex[i].magnitude * Math.sin(phase) - x.im);
      });
      const expectedTran = reference.transient.signals[`v(${node})`];
      const peakTran = Math.max(...expectedTran.map(x => Math.abs(x.re)));
      const values = tran.voltage(node);
      let upper = 0;
      const tranErrors = reference.transient.grid.map((time, i) => {
        while (tran.time[upper] < time) upper++;
        const lower = Math.max(0, upper - 1);
        const weight = upper === lower ? 0 : (time - tran.time[lower]) / (tran.time[upper] - tran.time[lower]);
        return Math.abs(values[lower] + weight * (values[upper] - values[lower]) - expectedTran[i].re);
      });
      console.info(`VTF ${node}: AC max absolute ${Math.max(...acErrors)} V, peak-normalized ${Math.max(...acErrors) / peakAc}; TRAN max absolute ${Math.max(...tranErrors)} V, peak-normalized ${Math.max(...tranErrors) / peakTran}`);
      expect(Math.max(...acErrors) / peakAc).toBeLessThan(0.001);
      expect(Math.max(...tranErrors) / peakTran).toBeLessThan(0.001);
    }
  });
  it('captures the pre-VTF default DC/AC/transient stamp fingerprint', () => {
    console.info(`VTF default stamp hash ${fingerprint({})}`);
    expect(fingerprint({})).toBe('bd942ae769ac72c14e81f01dc017fcc2eb2405613f1d1865dbccf12d42c06eea');
  });
  it.each([0, -1, -100])('VTF=%s disables the exponent exactly like omission', VTF => {
    expect(resolveVBICParams({ VTF }, 1).VTF).toBe(VTF);
    expect(fingerprint({ VTF })).toBe(fingerprint({}));
  });
  it('defaults VTF to zero', () => { expect(resolveVBICParams({}, 1).VTF).toBe(0); });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite VTF=%s with a typed error', VTF => {
    expect(() => resolveVBICParams({ VTF }, 1)).toThrow(InvalidCircuitError);
    expect(() => resolveVBICParams({ VTF }, 1)).toThrow("Invalid bounded VBIC DC model parameter: 'VTF'");
  });
  for (const polarity of [1, -1]) for (const ITF of [0, 0.0175231]) {
    for (const vbe of [-0.1, 0, 0.65]) for (const vbc of [-0.8, 0.1]) {
      it(`matches hand Qbe and AC/Euler derivatives: polarity=${polarity}, ITF=${ITF}, Vbe=${vbe}, Vbc=${vbc}`, () => {
        // No depletion, Early effect or rolloff: qb is the smoothed constant q1.
        const TF = 1.1e-12; const XTF = 21.5423; const VTF = 12.4758677; const area = 3;
        const actual = stamps({ TF, XTF, VTF, ITF }, vbe, vbc, polarity, 27, area);
        const vt = 1.380662e-23 * 300.15 / 1.602189e-19;
        const current = 1e-16 * Math.expm1(vbe / vt);
        const slope = 1e-16 * Math.exp(vbe / vt) / vt;
        const qb = 0.5 * (Math.sqrt((1 - 1e-4) ** 2 + 1e-8) + 1 - 1e-4) + 1e-4;
        const positive = current > 0 ? 1 : 0;
        const r = ITF > 0 ? current * positive / ITF : 0;
        const m = r / (1 + r);
        const bias = Math.exp(vbc / (1.44 * VTF));
        const enhancement = XTF * bias * positive;
        const h = (ITF > 0 ? 0 : 1) + m * m;
        const tff = TF * (1 + enhancement * h);
        const dtbe = ITF > 0 ? TF * enhancement * 2 * m * slope * positive / ITF / (1 + r) ** 2 : 0;
        // ngspice's generated Jacobian intentionally rounds 1/1.44 here.
        const dtbc = TF * enhancement * h * 0.6944444 / VTF;
        const q = area * tff * current / qb;
        const dbe = area * (tff * slope + dtbe * current) / qb;
        const dbc = area * dtbc * current / qb;
        expect(actual.q).toBeCloseTo(q, 25);
        expect(actual.cap[3][1]).toBeCloseTo(-dbc, 25);
        expect(actual.cap[3][4]).toBeCloseTo(-dbe, 25);
        expect(actual.cap[3][3]).toBeCloseTo(dbe + dbc, 25);
        for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
          expect(actual.g[row][col]).toBe(actual.cap[row][col]);
        }
        for (let col = 0; col < 7; col++) {
          expect(actual.cap.reduce((sum, row) => sum + row[col], 0)).toBe(0);
        }
      });
    }
  }
});
