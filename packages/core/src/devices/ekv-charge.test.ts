import { describe, expect, it } from 'vitest';
import { EKV26 } from './ekv.js';
import type { ChargeIntegration, StampContext } from './device.js';

describe('EKV 2.6 terminal charges', () => {
  it.each([1, -1])('uses EPFL eq.75 accumulation charge and oxide capacitance for polarity %s', polarity => {
    const model = new EKV26('m', [0, 1, 2, 3], {
      VTO: polarity * 0.5, WETA: 0, LETA: 0, Q0: 0,
      CGSO: 0, CGDO: 0, CGBO: 0,
    }, {}, polarity);
    const p = model.params;
    const vt = 8.617333262145e-5 * (p.TNOM + 273.15);
    const phi = 0.2 + 0.5 * (p.PHI - 0.2 + Math.hypot(p.PHI - 0.2, vt));
    const flatBand = 0.5 - phi - p.GAMMA * Math.sqrt(phi);
    const cox = p.COX * (p.W + p.DW) * (p.L + p.DL) * p.M;
    // Include shallow accumulation: testing the smoothed positive gate
    // instead of the unsmoothed V_G' must not suppress this branch.
    for (const gate of [flatBand - 0.01, -2, -5, -10]) {
      const point: [number, number, number, number] = [0, polarity * gate, 0, 0];
      const result = model.evaluateCharges(point);
      const effectiveGate = gate - flatBand;
      expect(result.charges[3] / (polarity * cox)).toBeCloseTo(-effectiveGate, 12);
      expect(result.jacobian[3][1] / cox).toBeCloseTo(-1, 12);
      if (gate <= -2) {
        expect(polarity * result.charges[1]).toBeLessThan(0);
        expect(result.jacobian[1][1] / cox).toBeCloseTo(1, 6);
        const h = 1e-5;
        const plus = model.evaluateCharges([0, point[1] + h, 0, 0]);
        const minus = model.evaluateCharges([0, point[1] - h, 0, 0]);
        expect((plus.charges[1] - minus.charges[1]) / (2 * h * cox)).toBeCloseTo(1, 6);
      }
    }
  });

  it.each([1, -1])('conserves charge and differentiates every terminal for polarity %s', polarity => {
    const model = new EKV26('m', [0, 1, 2, 3], { VTO: polarity * 0.5, CGSO: 2e-10, CGDO: 3e-10, CGBO: 1e-10 }, {}, polarity);
    for (const gate of [-2, -0.3, 0.3, 0.5, 1, 3]) {
      for (const drain of [-0.2, 0, 0.001, 0.1, 1, 3]) {
        const point = [drain, gate, 0, -0.2].map(v => polarity * v) as [number, number, number, number];
        const result = model.evaluateCharges(point);
        expect(Math.abs(result.charges.reduce((sum, q) => sum + q, 0))).toBeLessThan(1e-27);
        for (let row = 0; row < 4; row++) {
          expect(Number.isFinite(result.charges[row])).toBe(true);
          expect(Math.abs(result.jacobian[row].reduce((sum, c) => sum + c, 0))).toBeLessThan(1e-27);
          for (let col = 0; col < 4; col++) {
            const plus: typeof point = [...point], minus: typeof point = [...point];
            const h = 1e-5;
            plus[col] += h; minus[col] -= h;
            const fd = (model.evaluateCharges(plus).charges[row] - model.evaluateCharges(minus).charges[row]) / (2 * h);
            expect(Math.abs(result.jacobian[row][col] - fd), `g=${gate}, d=${drain}, row=${row}, col=${col}`)
              // Relative to the row norm: off-state cross terms can be
              // below the roundoff of the much larger overlap charge.
              .toBeLessThan(1e-6 * Math.max(...result.jacobian[row].map(Math.abs)));
          }
        }
      }
    }
  });

  it('scales with multiplicity and preserves polarity and common-mode symmetry', () => {
    // WETA contains M in the existing static narrow-width correction.
    const n = new EKV26('n', [0, 1, 2, 3], { WETA: 0 });
    const p = new EKV26('p', [0, 1, 2, 3], { WETA: 0, VTO: -0.5 }, {}, -1);
    const multiple = new EKV26('n', [0, 1, 2, 3], { WETA: 0, M: 3 });
    const base = n.evaluateCharges([1, 1.5, 0, -0.2]);
    const mirror = p.evaluateCharges([-1, -1.5, 0, 0.2]);
    const shifted = n.evaluateCharges([11, 11.5, 10, 9.8]);
    const scaled = multiple.evaluateCharges([1, 1.5, 0, -0.2]);
    for (let row = 0; row < 4; row++) {
      expect(mirror.charges[row]).toBeCloseTo(-base.charges[row], 26);
      expect(shifted.charges[row]).toBeCloseTo(base.charges[row], 26);
      expect(scaled.charges[row]).toBeCloseTo(3 * base.charges[row], 26);
    }
  });

  it.each<ChargeIntegration['method']>(['euler', 'trapezoidal', 'gear2'])('integrates actual charges with accepted-only history (%s)', method => {
    const model = new EKV26('m', [0, 1, 2, 3], {});
    let voltage: [number, number, number, number] = [1, 0.3, 0, -0.2];
    const rhs = new Float64Array(4);
    const matrix = Array.from({ length: 4 }, () => new Float64Array(4));
    const ctx = {
      getVoltage: (n: number) => voltage[n],
      stampG: (r: number, c: number, g: number) => { matrix[r][c] += g; },
      stampB: (r: number, b: number) => { rhs[r] += b; },
    } as StampContext;
    const initial = model.evaluateCharges(voltage);
    model.acceptTransientStep(ctx);
    const integration: ChargeIntegration = { method, dt: 1e-9 };
    // A rejected Newton trial must never update accepted charge history.
    voltage = [1, 2, 0, -0.2];
    model.stampTransientCharge(ctx, integration);
    rhs.fill(0); matrix.forEach(row => row.fill(0));
    voltage = [1, 0.8, 0, -0.2];
    const next = model.evaluateCharges(voltage);
    model.stampTransientCharge(ctx, integration);
    const factor = method === 'trapezoidal' ? 2e9 : 1e9;
    const currents = matrix.map((row, i) => row.reduce((sum, g, col) => sum + g * voltage[col], 0) - rhs[i]);
    currents.forEach((current, row) => expect(current).toBeCloseTo(factor * (next.charges[row] - initial.charges[row]), 15));
    expect(Math.abs(currents.reduce((sum, i) => sum + i, 0))).toBeLessThan(1e-18);
    model.acceptTransientStep(ctx);
    rhs.fill(0);
    model.stampAcceptedChargeCurrent(ctx);
    currents.forEach((current, row) => expect(-rhs[row]).toBeCloseTo(current, 15));
    model.resetTransient();
    model.acceptTransientStep(ctx);
    rhs.fill(0);
    model.stampAcceptedChargeCurrent(ctx);
    expect(Array.from(rhs)).toEqual([0, 0, 0, 0]);
  });
});
