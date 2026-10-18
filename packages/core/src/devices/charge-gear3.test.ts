import { describe, expect, it } from 'vitest';
import { TransientChargeState } from './charge-state.js';
import { gear3Coefficients } from './gear3.js';
import type { ChargeIntegration } from './device.js';

const rule = (dt: number, prevDt = dt, prevPrevDt = prevDt): ChargeIntegration => ({
  method: 'gear2', order: 3, dt, prevDt, prevPrevDt,
});

function history(times: number[], value: (t: number) => number, batched = false): TransientChargeState {
  const state = new TransientChargeState(1);
  for (let i = 0; i < times.length; i++) {
    if (i > 0) state.begin(rule(times[i] - times[i - 1]));
    if (batched) state.acceptAll(Float64Array.of(value(times[i])));
    else { state.accept(0, value(times[i])); state.commit(); }
  }
  return state;
}

describe('Gear-3 charge integration kernel (#1406)', () => {
  it('has the uniform BDF3 derivative weights', () => {
    const weights = gear3Coefficients(1, 1, 1);
    [11 / 6, -3, 1.5, -1 / 3].forEach((value, i) => expect(weights[i]).toBeCloseTo(value, 14));
  });

  it('differentiates polynomials through degree three on unequal steps', () => {
    const times = [0, -0.2, -0.9, -1.3];
    const weights = gear3Coefficients(0.2, 0.7, 0.4);
    for (let degree = 0; degree <= 3; degree++) {
      const derivative = weights.reduce((sum, weight, i) => sum + weight * times[i] ** degree, 0);
      expect(derivative).toBeCloseTo(degree === 1 ? 1 : 0, 12);
    }
  });

  it.each([false, true])('integrates the actual charge history (batched=%s)', batched => {
    const state = history([0, 0.4, 1.1], t => t ** 3, batched);
    state.begin(rule(0.2, 0.7, 0.4));
    expect(state.current(0, 1.3 ** 3)).toBeCloseTo(3 * 1.3 ** 2, 12);
    state.accept(0, 1.3 ** 3);
    state.commit();
    expect(state.acceptedChargeCurrent(0)).toBeCloseTo(3 * 1.3 ** 2, 12);
  });

  it('bootstraps with BE then BDF2 and clears third-order history on reset', () => {
    const state = history([0], t => t);
    state.begin(rule(1));
    expect(state.factor).toBe(1);
    state.accept(0, 1); state.commit();
    state.begin(rule(1));
    expect(state.factor).toBe(1.5);
    state.accept(0, 2); state.commit();
    state.begin(rule(1));
    expect(state.factor).toBeCloseTo(11 / 6, 14);
    state.reset();
    state.accept(0, 10); state.commit();
    state.begin(rule(1));
    expect(state.factor).toBe(1);
    expect(state.current(0, 11)).toBe(1);
  });

  it('uses the fourth divided difference, Gear-3 coefficient and cube root for CKTterr', () => {
    const state = history([0, 1, 2, 3], t => t ** 4);
    state.begin(rule(1));
    const truncation = { deltas: [1, 1, 1] as const, olderDelta: 1, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14, trtol: 7 };
    const expected = Math.cbrt(7 * 0.256 / 0.1363636364);
    expect(state.truncationTimestep(truncation, () => state.accept(0, 256))).toBeCloseTo(expected, 12);
    expect(state.truncationTimestepAll(truncation, Float64Array.of(256))).toBeCloseTo(expected, 12);
    expect(state.current(0, 256)).toBeCloseTo(250, 12);
  });

  it('converges at third order on the RC step equation with exact startup history', () => {
    // Kernel test, not an end-to-end transient-driver/MAXORD=3 claim.
    function error(steps: number): number {
      const dt = 1 / steps;
      const state = history([0, dt, 2 * dt], t => 1 - Math.exp(-t));
      let voltage = 0;
      for (let i = 3; i <= steps; i++) {
        state.begin(rule(dt));
        // C=R=1: dV/dt + V = 1. Solve its charge companion exactly.
        voltage = (1 - state.current(0, 0)) / (1 + state.factor);
        state.accept(0, voltage); state.commit();
      }
      return Math.abs(voltage - (1 - Math.exp(-1)));
    }
    const errors = [40, 80, 160].map(error);
    console.info('Gear-3 RC kernel errors at 40/80/160 steps:', errors);
    expect(errors[0] / errors[1]).toBeGreaterThan(7);
    expect(errors[1] / errors[2]).toBeGreaterThan(7);
    expect(errors[1] / errors[2]).toBeLessThan(9);
  });

  it('truncates a quartic on unequal steps without committing rejected trials', () => {
    const state = history([0, 0.4, 1.1, 1.3], t => t ** 4, true);
    state.begin(rule(0.3, 0.2, 0.7));
    const truncation = { deltas: [0.3, 0.2, 0.7] as const, olderDelta: 0.4,
      reltol: 0.001, abstol: 1e-12, chgtol: 1e-14, trtol: 7 };
    const charge = 1.6 ** 4;
    const current = state.current(0, charge);
    const tolerance = Math.max(1e-12 + 0.001 * Math.max(Math.abs(current), Math.abs(state.acceptedChargeCurrent(0))),
      0.001 * charge / 0.3);
    const expected = Math.cbrt(7 * tolerance / 0.1363636364);
    expect(state.truncationTimestep(truncation, () => state.accept(0, charge))).toBeCloseTo(expected, 11);
    expect(state.truncationTimestepAll(truncation, Float64Array.of(charge))).toBeCloseTo(expected, 11);
    expect(state.current(0, charge)).toBe(current);
    expect(state.truncationTimestep({ ...truncation, olderDelta: undefined }, () => state.accept(0, charge))).toBe(Infinity);
    state.begin(rule(0.1, 0.2, 0.7));
    const weights = gear3Coefficients(0.1, 0.2, 0.7);
    expect(state.current(0, 1.4 ** 4)).toBeCloseTo(weights[0] * 1.4 ** 4 + weights[1] * 1.3 ** 4
      + weights[2] * 1.1 ** 4 + weights[3] * 0.4 ** 4, 12);
  });
});
