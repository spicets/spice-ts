import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';

const base = new URL('./__fixtures__/rgatemod2/', import.meta.url);

describe('BSIM4 RGATEMOD=2 common-source transient', () => {
  for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) {
    it(`integrates native AC charge at GP: polarity=${polarity}, Vds=${vds}`, () => {
      const device = new BSIM4('M1', [0, 1, 2, 3, 4], { level: 54, rgatemod: 2, rshg: 1000 },
        { l: 1e-6, w: 10e-6, m: 2, mult_q: 3 }, polarity);
      const voltage = [polarity * vds, polarity * 1.5, 0, polarity * -0.2, polarity * 0.8];
      const G = new Float64Array(25), C = new Float64Array(25), B = new Float64Array(5);
      const ctx: StampContext = {
        stampG: (r, c, x) => { G[5 * r + c] += x; },
        stampC: (r, c, x) => { C[5 * r + c] += x; },
        stampB: (r, x) => { B[r] += x; },
        getVoltage: n => voltage[n], getCurrent: () => 0,
        time: 1e-12, dt: 1e-12, numNodes: 5, sourceScale: 1, useDcSourceValue: false,
      };
      device.stampDynamic(ctx);
      device.acceptTransientStep(ctx);
      device.stampTransientCharge(ctx, { method: 'euler', dt: ctx.dt });
      for (let i = 0; i < 25; i++) expect(G[i] * ctx.dt).toBeCloseTo(C[i], 25);
      expect(G[24]).toBeGreaterThan(0);
      for (let row = 0; row < 5; row++) expect(G[5 * row + 1]).toBe(0);
      expect(Array.from(G.slice(5, 10))).toEqual([0, 0, 0, 0, 0]);
      voltage[4] += polarity * 0.1;
      G.fill(0); B.fill(0);
      device.stampTransientCharge(ctx, { method: 'euler', dt: ctx.dt });
      device.acceptTransientStep(ctx);
      B.fill(0);
      device.stampAcceptedChargeCurrent(ctx);
      expect(B[1]).toBe(0);
      expect(Math.abs(B[4])).toBeGreaterThan(0);
      expect(B.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 14);
    });
  }
  it('matches ngspice-47 output voltage and supply current within 1% of peak', async () => {
    const deck = readFileSync(new URL('transient.cir', base), 'utf8');
    const reference = JSON.parse(readFileSync(new URL('transient-ngspice-47.json', base), 'utf8')) as {
      sha256: string; nativePoints: number; grid: number[]; signals: Record<string, number[]>;
    };
    expect(createHash('sha256').update(deck).digest('hex')).toBe(reference.sha256);
    const result = (await simulate(deck)).transient!;
    expect(result.time.at(-1)).toBeCloseTo(200e-9, 18);
    const errors: Record<string, { max: number; rms: number }> = {};
    for (const [signal, expected] of Object.entries(reference.signals)) {
      const values = signal === 'i(vdd)' ? result.current('Vdd') : result.voltage('out');
      const peak = Math.max(...expected.map(Math.abs));
      let max = 0, squares = 0, j = 0;
      for (let i = 0; i < reference.grid.length; i++) {
        const t = reference.grid[i];
        while (j + 1 < result.time.length - 1 && result.time[j + 1] < t) j++;
        const weight = (t - result.time[j]) / (result.time[j + 1] - result.time[j]);
        const value = values[j] + weight * (values[j + 1] - values[j]);
        expect(Number.isFinite(value)).toBe(true);
        const error = Math.abs(value - expected[i]) / peak;
        max = Math.max(max, error);
        squares += error * error;
      }
      errors[signal] = { max, rms: Math.sqrt(squares / reference.grid.length) };
    }
    console.info(`RGATEMOD=2 transient: ${JSON.stringify({ errors, spiceTsPoints: result.time.length, ngspicePoints: reference.nativePoints })}`);
    for (const error of Object.values(errors)) expect(error.max).toBeLessThanOrEqual(0.01);
  });
});
