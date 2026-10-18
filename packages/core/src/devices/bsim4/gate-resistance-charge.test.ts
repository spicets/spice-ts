import { describe, expect, it } from 'vitest';
import type { ChargeIntegration, StampContext } from '../device.js';
import { BSIM4 } from './device.js';

function context(voltage: number[]) {
  const G = new Float64Array(25), B = new Float64Array(5);
  const ctx: StampContext = {
    stampG: (r, c, x) => { G[r * 5 + c] += x; },
    stampB: (r, x) => { B[r] += x; },
    stampC: () => { throw new Error('Charge integration must not stamp C'); },
    getVoltage: n => voltage[n], getCurrent: () => 0,
    time: 0, dt: 1e-12, numNodes: 5, sourceScale: 1, useDcSourceValue: false,
  };
  return { ctx, G, B };
}

// A four-terminal charge adapter connected directly to GP is the mapping
// oracle: RGATEMOD=1 only adds the static G-GP resistor, not external-G charge.
describe('BSIM4 RGATEMOD=1 intrinsic transient charge mapping', () => {
  for (const polarity of [1, -1] as const) for (const vds of [0.7, -0.7]) {
    for (const method of ['euler', 'trapezoidal', 'gear2'] as const) {
      it(`maps charge, Jacobian, history and accepted current: type=${polarity}, Vds=${vds}, ${method}`, () => {
        const geometry = { l: 1e-6, w: 10e-6, m: 3, mult_q: 2 };
        const actual = new BSIM4('M1', [0, 1, 2, 3, 4], { level: 54, rgatemod: 1, rshg: 1e6 }, geometry, polarity);
        const expected = new BSIM4('M0', [0, 4, 2, 3], { level: 54 }, geometry, polarity);
        actual.assertAnalyses(['tran']);
        const voltage = [0.4 + polarity * vds, 0.4 + polarity * 1.5, 0.4, 0.4 - polarity * 0.2, 0.4 + polarity * 0.2];
        actual.acceptTransientStep(context(voltage).ctx);
        expected.acceptTransientStep(context(voltage).ctx);
        const integration: ChargeIntegration = { method, dt: 1e-12, prevDt: 1e-12 };
        // Change GP alone, then external G alone, then GP again. History must
        // follow GP too, including accepted currents used in branch recovery.
        for (const [gate, intrinsicGate] of [[1.5, 1.4], [0.1, 1.4], [0.1, 0.8]]) {
          voltage[1] = 0.4 + polarity * gate;
          voltage[4] = 0.4 + polarity * intrinsicGate;
          const a = context(voltage), e = context(voltage);
          actual.stampTransientCharge(a.ctx, integration);
          expected.stampTransientCharge(e.ctx, integration);
          expect(a.G).toEqual(e.G);
          expect(a.B).toEqual(e.B);
          expect(Math.abs(a.G[4 * 5 + 4])).toBeGreaterThan(1e-6);
          expect(Array.from(a.G.slice(5, 10))).toEqual([0, 0, 0, 0, 0]);
          for (let row = 0; row < 5; row++) expect(a.G[row * 5 + 1]).toBe(0);
          expect(a.B[1]).toBe(0);
          actual.acceptTransientStep(a.ctx);
          expected.acceptTransientStep(e.ctx);
          const accepted = context(voltage), reference = context(voltage);
          actual.stampAcceptedChargeCurrent(accepted.ctx);
          expected.stampAcceptedChargeCurrent(reference.ctx);
          expect(accepted.B).toEqual(reference.B);
          expect(accepted.B[1]).toBe(0);
          if (gate === 1.5) expect(Math.abs(accepted.B[4])).toBeGreaterThan(1e-6);
        }
      });
    }
  }
});
