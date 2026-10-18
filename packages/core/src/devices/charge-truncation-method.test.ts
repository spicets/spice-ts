import { describe, expect, it } from 'vitest';
import { TransientChargeState } from './charge-state.js';

describe('CKTterr integration-method coefficients', () => {
  it.each([
    ['gear2', 0.2222222222],
    ['trapezoidal', 0.08333333333],
  ] as const)('uses %s coefficients when trialling order two after BE', (method, coefficient) => {
    const state = new TransientChargeState(1);
    for (const q of [-1, 0, 1, 8]) {
      state.begin({ method: 'euler', dt: 1 });
      state.acceptAll(new Float64Array([q]));
    }
    state.begin({ method: 'euler', dt: 1 });
    const options = {
      deltas: [1, 1, 1] as const, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14,
      trtol: 7, order: 2 as const, method,
    };
    // ngspice-47 cktterr.c:24-35,60-74 selects by the run method, not
    // the BE companion. q=t^3 has third divided difference 1. Its current
    // remains the BE current (27-8), not a recomputed order-two current.
    const expected = Math.sqrt(7 * 0.027 / coefficient);
    expect(state.truncationTimestepAll(options, new Float64Array([27]))).toBeCloseTo(expected, 12);
    expect(state.truncationTimestep(options, () => state.accept(0, 27))).toBeCloseTo(expected, 12);
  });
});
