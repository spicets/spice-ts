import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';

const base = new URL('./__fixtures__/rbodymod1/', import.meta.url);

describe('BSIM4 RBODYMOD=1 transient', () => {
  for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) {
    it(`integrates junction charges at DB/SB: polarity=${polarity}, Vds=${vds}`, () => {
      const device = new BSIM4('M1', [0, 1, 2, 3, 4, 5, 6], { level: 54, rbodymod: 1 },
        { l: 1e-6, w: 10e-6, ad: 1e-12, as: 2e-12, m: 2, mult_q: 3 }, polarity);
      const voltage = [polarity * vds, polarity * 0.8, 0, 0, polarity * -0.3, polarity * -0.2, polarity * -0.1];
      const G = new Float64Array(49), C = new Float64Array(49), B = new Float64Array(7);
      const ctx: StampContext = {
        stampG: (r, c, x) => { G[7 * r + c] += x; },
        stampC: (r, c, x) => { C[7 * r + c] += x; },
        stampB: (r, x) => { B[r] += x; },
        getVoltage: n => voltage[n], getCurrent: () => 0,
        time: 1e-12, dt: 1e-12, numNodes: 7, sourceScale: 1, useDcSourceValue: false,
      };
      device.stampDynamic(ctx);
      device.acceptTransientStep(ctx);
      device.stampTransientCharge(ctx, { method: 'euler', dt: ctx.dt });
      for (let i = 0; i < 49; i++) expect(G[i] * ctx.dt).toBeCloseTo(C[i], 25);
      expect(G[7 * 4 + 4]).toBeGreaterThan(0);
      expect(G[7 * 6 + 6]).toBeGreaterThan(0);
      voltage[4] += polarity * 0.1;
      voltage[6] -= polarity * 0.1;
      G.fill(0); B.fill(0);
      device.stampTransientCharge(ctx, { method: 'euler', dt: ctx.dt });
      device.acceptTransientStep(ctx);
      B.fill(0);
      device.stampAcceptedChargeCurrent(ctx);
      expect(Math.abs(B[4])).toBeGreaterThan(0);
      expect(Math.abs(B[6])).toBeGreaterThan(0);
      expect(B[3]).toBe(0);
      expect(B.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 14);
      device.resetTransient();
      B.fill(0);
      device.stampAcceptedChargeCurrent(ctx);
      expect(Array.from(B)).toEqual(Array(7).fill(0));
    });
  }

  it('matches identical-deck ngspice-47 voltage and supply current within 1e-3 of peak', async () => {
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
    console.info(`RBODYMOD=1 transient: ${JSON.stringify({ errors, spiceTsPoints: result.time.length, ngspicePoints: reference.nativePoints })}`);
    for (const error of Object.values(errors)) expect(error.max).toBeLessThanOrEqual(1e-3);
  });
});
