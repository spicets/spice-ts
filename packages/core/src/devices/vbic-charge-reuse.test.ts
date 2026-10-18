import { describe, expect, it, vi } from 'vitest';
import type { StampContext } from './device.js';
import { VBIC } from './vbic.js';

function setup(excessPhase: boolean, polarity: number) {
  const nodes = Array.from({ length: excessPhase ? 9 : 7 }, (_, i) => i);
  const device = new VBIC('Q', nodes, {
    CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12,
    TF: 1e-12, TD: excessPhase ? 1e-12 : 0, VEF: 50, VER: 10,
  }, polarity);
  const stamps: number[][] = [];
  const voltages = [0.2, 0.3, 0.1, 0.15, 0, 0.05, 0.2, 0.01, 0.02];
  const ctx: StampContext = {
    stampG: (r, c, value) => { stamps.push([r, c, value]); },
    stampB: (r, value) => { stamps.push([r, value]); }, stampC: () => {},
    getVoltage: n => polarity * voltages[n], getCurrent: () => 0,
    time: 0, dt: 1e-12, numNodes: nodes.length, sourceScale: 1, useDcSourceValue: false,
  };
  const charge = () => {
    stamps.length = 0;
    device.stampTransientCharge(ctx, { method: 'euler', dt: 1e-12 });
    return stamps.map(row => [...row]);
  };
  return { device, ctx, charge, voltages };
}

describe('VBIC static/transient charge evaluation reuse (#1310)', () => {
  for (const excessPhase of [false, true]) for (const polarity of [1, -1]) {
    it(`reuses the limited load charge without another exponential, TD=${excessPhase}, polarity=${polarity}`, () => {
      const { device, ctx, charge } = setup(excessPhase, polarity);
      device.stamp(ctx);
      const exp = vi.spyOn(Math, 'exp');
      try {
        charge();
        expect(exp).not.toHaveBeenCalled();
        device.setTemperature(75);
        charge();
        expect(exp).toHaveBeenCalled();
        device.stamp(ctx);
        exp.mockClear();
        charge();
        expect(exp).not.toHaveBeenCalled();
        device.resetTransient();
        charge();
        expect(exp).toHaveBeenCalled();
      } finally { exp.mockRestore(); }
    });

    it(`matches re-evaluation bit for bit across loads, temperature and reset, TD=${excessPhase}, polarity=${polarity}`, () => {
      const { device, ctx, charge, voltages } = setup(excessPhase, polarity);
      for (const temperature of [0, 27, 75]) {
        device.setTemperature(temperature);
        for (const bias of [0.15, 0.65, -0.1]) {
          voltages[3] = bias;
          device.stamp(ctx);
          // gmin only affects static residuals, never the stored charges.
          ctx.gmin = 1e-8;
          const cached = charge();
          // Re-setting temperature invalidates reuse but preserves the load voltages.
          device.setTemperature(temperature);
          expect(charge()).toEqual(cached);
          device.resetTransient();
          const fresh = setup(excessPhase, polarity);
          fresh.device.setTemperature(temperature);
          fresh.voltages[3] = bias;
          expect(charge()).toEqual(fresh.charge());
        }
      }
    });
  }
});
