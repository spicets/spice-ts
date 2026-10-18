import { describe, expect, it } from 'vitest';
import { chargeTruncatedNodes } from '../analysis/transient-node-truncation.js';
import type { ChargeIntegration, ChargeTruncation, DeviceModel, StampContext } from './device.js';
import { VBIC } from './vbic.js';

// Local nodes CX CI BX BI EI BP SI XF1 XF2. Activate one varying
// branch charge at a time; the other QCO branch may hold a constant offset.
const cases: [string, Record<string, number>, number][] = [
  ['qbe', { CJE: 1e-9 }, 3],
  ['qbe (TF)', { TF: 1e-9, IS: 1e-9 }, 3],
  ['qbex', { CJE: 1e-9, WBE: 0 }, 2],
  ['qbc', { CJC: 1e-9 }, 1],
  ['qbc (TR)', { TR: 1e-9, IS: 1e-9 }, 1],
  ['qbc (QCO)', { QCO: 1e-9, GAMM: 1 }, 1],
  ['qbcx', { QCO: 1e-9, GAMM: 1 }, 0],
  ['qbep', { CJEP: 1e-9 }, 5],
  ['qbep (TR)', { TR: 1e-3, ISP: 1e-9 }, 5],
  ['qbcp', { CJCP: 1e-9 }, 6],
  ['qxf1', { TD: 1e-9 }, 7],
  ['qxf2', { TD: 1e-9 }, 8],
];

function setup(params: Record<string, number>, polarity: number) {
  const count = params.TD ? 9 : 7;
  const v = new Float64Array(count);
  const device = new VBIC('Q', Array.from({ length: count }, (_, n) => n), params, polarity);
  const ctx: StampContext = {
    stampG: () => {}, stampB: () => {}, stampC: () => {},
    getVoltage: n => v[n], getCurrent: () => 0, time: 0, dt: 1e-9,
    numNodes: count, sourceScale: 1, useDcSourceValue: false, gmin: 0,
  };
  return { device, ctx, v };
}

const truncation: ChargeTruncation = {
  deltas: [1e-9, 1e-9, 1e-9], reltol: 1e-4, abstol: 1e-12, chgtol: 1e-14, trtol: 7,
};

describe('VBIC complete charge truncation (#1310)', () => {
  it('declares coverage and exempts its listed nodes from fallback voltage LTE', () => {
    const { device } = setup({ TD: 1e-9 }, 1);
    expect((device as DeviceModel).truncationCoversCharges).toBe(true);
    expect([...chargeTruncatedNodes(9, [device])]).toEqual(Array(9).fill(1));
  });

  for (const method of ['euler', 'trapezoidal', 'gear2'] as const) {
    for (const polarity of [1, -1]) {
      it.each(cases)(`bounds %s independently with ${method}, polarity ${polarity}`, (_name, params, node) => {
        const { device, ctx, v } = setup(params, polarity);
        const integration: ChargeIntegration = { method, dt: 1e-9, prevDt: 1e-9 };
        device.acceptTransientStep(ctx);
        for (let i = 0; i < 2; i++) {
          device.stampTransientCharge(ctx, integration);
          device.acceptTransientStep(ctx);
        }
        device.stampTransientCharge(ctx, integration);
        const resting = device.truncateTransientStep(ctx, truncation);
        // Vary only the named branch (including each excess-phase row).
        // Forward diffusion uses a forward Vbe; the others move this node down.
        v[node] = (_name.includes('(TF)') ? 0.2 : -0.2) * polarity;
        const bound = device.truncateTransientStep(ctx, truncation);
        expect(bound).toBeGreaterThan(0);
        expect(bound).toBeLessThan(1e-9);
        expect(bound).toBeLessThan(resting);
        expect(device.truncateTransientStep(ctx, truncation)).toBe(bound);
        // Trial evaluation must not commit history, even across retries.
        v[node] = 0;
        expect(device.truncateTransientStep(ctx, truncation)).toBe(resting);
      });
    }
  }
});
