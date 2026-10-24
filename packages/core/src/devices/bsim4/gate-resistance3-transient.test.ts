import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';

const base = new URL('./__fixtures__/rgatemod3/', import.meta.url);
const hashes = [
  'eac369c3ba234f9c26d2889ef661e0e2088519ff86a0c711a1d7c04dd567522e',
  'd69d72672cbd1c5416a032424f8b37f85f8d821efdfe85dfea980cbb78a7d53d',
  '3de071391a8b23ef523106a127d53a774895d0c7cb7dbe2f368f9ca5f34e430f',
  'd82d8aa3bca06a0447f5a25ddb50df1208a65cdc892461e124fcb1b559e260aa',
];

function context(voltage: number[]) {
  const G = new Float64Array(36), C = new Float64Array(36), B = new Float64Array(6);
  const ctx: StampContext = {
    stampG: (r, c, x) => { G[6 * r + c] += x; },
    stampC: (r, c, x) => { C[6 * r + c] += x; },
    stampB: (r, x) => { B[r] += x; },
    getVoltage: n => voltage[n], getCurrent: () => 0,
    time: 1e-12, dt: 1e-12, numNodes: 6, sourceScale: 1, useDcSourceValue: false,
  };
  return { ctx, G, C, B };
}

describe('BSIM4 RGATEMOD=3 transient split overlap', () => {
  for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) {
    for (const method of ['euler', 'trapezoidal', 'gear2'] as const) {
      it(`AC Jacobian, physical GM pairs, accepted KCL and multiplicity: ${polarity}, ${vds}, ${method}`, () => {
        const model = { level: 54, rgatemod: 3, rshg: 1000, cgbo: 2e-10, cgsl: 1e-10, cgdl: 3e-10 };
        const device = new BSIM4('M1', [0, 1, 2, 3, 4, 5], model, { l: 1e-6, w: 10e-6, m: 2, mult_q: 3 }, polarity);
        const unit = new BSIM4('M0', [0, 1, 2, 3, 4, 5], model, { l: 1e-6, w: 10e-6 }, polarity);
        device.assertAnalyses(['tran']);
        const voltage = [polarity * vds, polarity * 1.5, 0, polarity * -0.2, polarity * 0.8, polarity * 1.1];
        const integration = { method, dt: 1e-12, prevDt: 1e-12 };
        // Two accepted points activate trapezoidal and Gear history.
        for (let i = 0; i < 2; i++) for (const d of [device, unit]) {
          d.stampTransientCharge(context(voltage).ctx, integration);
          d.acceptTransientStep(context(voltage).ctx);
        }
        const ac = context(voltage), tran = context(voltage);
        device.stampDynamic(ac.ctx);
        device.stampTransientCharge(tran.ctx, integration);
        const factor = method === 'euler' ? 1 : method === 'trapezoidal' ? 2 : 1.5;
        for (let i = 0; i < 36; i++) expect(tran.G[i] * integration.dt / factor).toBeCloseTo(ac.C[i], 25);
        for (const terminal of [0, 2, 3]) expect(ac.C[5 * 6 + terminal]).toBeLessThan(0);
        expect(ac.C[5 * 6 + 4]).toBe(0);
        voltage[5] += polarity * 0.1;
        const a = context(voltage), u = context(voltage);
        device.stampTransientCharge(a.ctx, integration); unit.stampTransientCharge(u.ctx, integration);
        device.acceptTransientStep(a.ctx); unit.acceptTransientStep(u.ctx);
        const accepted = context(voltage), single = context(voltage);
        device.stampAcceptedChargeCurrent(accepted.ctx); unit.stampAcceptedChargeCurrent(single.ctx);
        expect(accepted.B[1]).toBe(0);
        expect(accepted.B[4]).toBeCloseTo(0, 12); // GP did not move.
        expect(Math.abs(accepted.B[5])).toBeGreaterThan(0);
        expect(accepted.B.reduce((s, x) => s + x, 0)).toBeCloseTo(0, 13);
        for (let i = 0; i < 6; i++) expect(accepted.B[i]).toBeCloseTo(6 * single.B[i], 13);
        // Accepted replay must recover the nonlinear companion's physical currents.
        for (const terminal of [0, 2, 3, 5]) {
          const current = voltage.reduce((sum, v, col) => sum + a.G[6 * terminal + col] * v, -a.B[terminal]);
          expect(accepted.B[terminal]).toBeCloseTo(-current, 12);
          expect(Math.sign(accepted.B[terminal])).toBe(terminal === 5 ? -polarity : polarity);
        }
      });
    }
  }
  for (const [index, name] of ['nmos-forward', 'nmos-reverse', 'pmos-forward', 'pmos-reverse'].entries()) {
    it(`${name}: identical-byte ngspice-47 v(out)/i(vdd) within 1% of peak`, async () => {
      const deck = readFileSync(new URL(`transient-${name}.cir`, base), 'utf8');
      const reference = JSON.parse(readFileSync(new URL(`transient-${name}-ngspice-47.json`, base), 'utf8')) as {
        sha256: string; nativePoints: number; grid: number[]; signals: Record<string, number[]>;
      };
      expect(createHash('sha256').update(deck).digest('hex')).toBe(hashes[index]);
      expect(reference.sha256).toBe(hashes[index]);
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
          max = Math.max(max, error); squares += error * error;
        }
        errors[signal] = { max, rms: Math.sqrt(squares / reference.grid.length) };
      }
      console.info(`RGATEMOD=3 ${name}: ${JSON.stringify({ errors, spiceTsPoints: result.time.length, ngspicePoints: reference.nativePoints })}`);
      for (const error of Object.values(errors)) expect(error.max).toBeLessThanOrEqual(0.01);
    });
  }
});
