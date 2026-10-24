import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';
import { BSIM4 } from './device.js';
import type { StampContext } from '../device.js';

function fixture(nodes: number[], polarity: 1 | -1, vds: number) {
  const device = new BSIM4('M1', nodes,
    { level: 54, rgatemod: nodes.length === 5 ? 1 : 0, rshg: 1e6 },
    { l: 1e-6, w: 10e-6, m: 2, mult_q: 3 }, polarity);
  const voltage = [polarity * vds, polarity * 1.5, 0, polarity * -0.2, polarity * 0.2];
  const G = new Float64Array(25), B = new Float64Array(5);
  const ctx: StampContext = {
    stampG: (r, c, x) => { G[5 * r + c] += x; }, stampB: (r, x) => { B[r] += x; },
    stampC: () => { throw new Error('charge must use its integrated companion'); },
    getVoltage: n => voltage[n], getCurrent: () => 0,
    time: 1e-12, dt: 1e-12, numNodes: 5, sourceScale: 1, useDcSourceValue: false,
  };
  return { device, voltage, ctx, G, B, clear: () => { G.fill(0); B.fill(0); } };
}

const integration = { method: 'euler', dt: 1e-12 } as const;

describe('BSIM4 RGATEMOD=1 transient intrinsic gate mapping', () => {
  const errors: Record<string, number> = {};
  beforeAll(async () => {
    const base = new URL('./__fixtures__/rgatemod1/', import.meta.url);
    const deck = readFileSync(new URL('transient.cir', base), 'utf8');
    const reference = JSON.parse(readFileSync(new URL('transient-ngspice-47.json', base), 'utf8')) as {
      sha256: string; grid: number[]; signals: Record<string, number[]>;
    };
    expect(createHash('sha256').update(deck).digest('hex')).toBe(reference.sha256);
    const result = (await simulate(deck)).transient!;
    expect(result.time.at(-1)).toBeCloseTo(100e-9, 18);
    for (const [signal, expected] of Object.entries(reference.signals)) {
      const values = signal === 'Vg' ? result.current(signal) : result.voltage(signal);
      const peak = Math.max(...expected.map(Math.abs), signal === 'Vg' ? 1e-12 : 1e-4);
      let maxError = 0, j = 0;
      for (let i = 0; i < reference.grid.length; i++) {
        const t = reference.grid[i];
        while (j + 1 < result.time.length - 1 && result.time[j + 1] < t) j++;
        const weight = (t - result.time[j]) / (result.time[j + 1] - result.time[j]);
        const value = values[j] + weight * (values[j + 1] - values[j]);
        expect(Number.isFinite(value)).toBe(true);
        maxError = Math.max(maxError, Math.abs(value - expected[i]) / peak);
      }
      errors[signal] = maxError;
    }
    console.info(`RGATEMOD=1 native RC peak-normalized errors: ${JSON.stringify(errors)}`);
    // With a gate resistor, GP lags the externally forced pulse by a visible
    // amount. Charging at G instead makes these voltages nearly identical.
    const sample = result.time.findIndex(t => t >= 11e-9);
    expect(result.voltage('g')[sample] - result.voltage('M1.gate')[sample]).toBeGreaterThan(0.1);
  });
  it.each(['g', 'Vg'])('matches native %s within the shared 1% peak bound', signal => {
    expect(errors[signal]).toBeLessThanOrEqual(0.01);
  });
  // Native fringe preprocessing also repairs the former GP waveform loss.
  it('matches native GP within the shared 1% peak bound', () => {
    expect(errors['M1.gate']).toBeLessThanOrEqual(0.01);
  });
  for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) {
    it(`maps charges, Jacobian and accepted currents to GP: polarity=${polarity}, Vds=${vds}`, () => {
      const actual = fixture([0, 1, 2, 3, 4], polarity, vds);
      // A four-terminal device wired directly to GP is the charge-only oracle;
      // only the static stamp should distinguish it from the resistive gate.
      const expected = fixture([0, 4, 2, 3], polarity, vds);
      for (const f of [actual, expected]) {
        expect(() => f.device.assertAnalyses(['tran'])).not.toThrow();
        f.device.acceptTransientStep(f.ctx);
        f.voltage[4] = polarity * 1.4;
        f.device.stampTransientCharge(f.ctx, integration);
      }
      expect(Array.from(actual.G)).toEqual(Array.from(expected.G));
      expect(Array.from(actual.B)).toEqual(Array.from(expected.B));
      expect(actual.G[24]).toBeGreaterThan(0);
      expect(Array.from(actual.G.slice(5, 10))).toEqual([0, 0, 0, 0, 0]);
      for (let row = 0; row < 5; row++) expect(actual.G[5 * row + 1]).toBe(0);
      expect(actual.B[1]).toBe(0);
      const matrix = Array.from(actual.G), rhs = Array.from(actual.B);
      actual.clear();
      actual.voltage[1] += polarity * 0.5;
      actual.device.stampTransientCharge(actual.ctx, integration);
      expect(Array.from(actual.G)).toEqual(matrix);
      expect(Array.from(actual.B)).toEqual(rhs);
      for (const f of [actual, expected]) {
        f.device.acceptTransientStep(f.ctx);
        f.clear();
        f.device.stampAcceptedChargeCurrent(f.ctx);
      }
      expect(Array.from(actual.B)).toEqual(Array.from(expected.B));
      expect(actual.B[1]).toBe(0);
      expect(Math.abs(actual.B[4])).toBeGreaterThan(0);
      expect(actual.B.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 14);
      // Re-stamping the accepted point must have zero BE current: acceptance
      // must evaluate the same GP charge as the Newton companion.
      actual.clear();
      actual.device.stampTransientCharge(actual.ctx, integration);
      for (let row = 0; row < 5; row++) {
        const current = actual.voltage.reduce((sum, v, col) => sum + actual.G[5 * row + col] * v, -actual.B[row]);
        expect(current).toBeCloseTo(0, 14);
      }
    });
  }
});
