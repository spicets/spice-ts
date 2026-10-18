import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StampContext } from './device.js';
import { VBIC } from './vbic.js';

// Baseline stamp bytes include signed zeros, limiting, temperature, charge,
// polarity, excess phase, avalanche, high injection and instance scaling.
function exercise(): { hash: string; allocations: number } {
  const hash = createHash('sha256');
  let allocations = 0;
  const OriginalArray = Array;
  const CountingArray = new Proxy(OriginalArray, {
    construct(target, args) {
      if (args.length === 1 && typeof args[0] === 'number') allocations++;
      return Reflect.construct(target, args);
    },
  });
  vi.stubGlobal('Array', CountingArray);
  try {
    const record = (...values: number[]) => {
      for (const value of values) {
        const bytes = Buffer.allocUnsafe(8);
        bytes.writeDoubleLE(value);
        hash.update(bytes);
      }
    };
    for (const polarity of [1, -1]) for (const TD of [0, 2e-12]) {
      const nodes = OriginalArray.from({ length: TD > 0 ? 9 : 7 }, (_, i) => i);
      const device = new VBIC('Q', nodes, {
        TD, CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12,
        TF: 1e-12, TR: 2e-12, VEF: 50, VER: 10, IKF: 0.01,
        IKR: 0.02, ISP: 1e-16, IBEIP: 1e-18, IBENP: 1e-19,
        AVC1: 0.1, AVC2: 5, GAMM: 0.01, VO: 1, QCO: 1e-13,
        ITF: 0.01, XTF: 2, VTF: 10, WBE: 0.4, WSP: 0.3,
      }, polarity, 2);
      const voltage = [0.2, 0.3, 0.1, 0.15, 0, 0.05, 0.2, 0.01, 0.02];
      const ctx: StampContext = {
        stampG: (r, c, v) => record(0, r, c, v),
        stampB: (r, v) => record(1, r, v),
        stampC: (r, c, v) => record(2, r, c, v),
        getVoltage: n => polarity * voltage[n], getCurrent: () => 0,
        time: 0, dt: 1e-12, numNodes: nodes.length, sourceScale: 1, useDcSourceValue: false,
      };
      for (const temperature of [0, 27, 75]) {
        device.setTemperature(temperature);
        device.resetTransient();
        for (const bias of [0.15, 0.65, -0.1, 2.5, -3]) {
          voltage[3] = bias;
          device.stamp(ctx);
          device.stampTransientCharge(ctx, { method: 'euler', dt: 1e-12 });
          device.acceptTransientStep(ctx);
          device.stampDynamic(ctx);
          for (const source of device.noiseOperatingPoint(Float64Array.from(voltage))) {
            record(source.conductance, source.shotCurrent, source.flickerCoefficient);
          }
        }
      }
    }
  } finally { vi.unstubAllGlobals(); }
  return { hash: hash.digest('hex'), allocations };
}

describe('VBIC derivative allocation (#1310 round 5)', () => {
  it('preserves baseline numeric output and every stamp bit for bit', () => {
    expect(exercise().hash).toBe('3324cdb29c46ea0b0be79f64b9a06a767eba5549d997e193df9221f0634944db');
  });
  it('avoids temporary derivative arrays in diode evaluation and local accumulation', () => {
    expect(exercise().allocations).toBeLessThan(60000);
  });
});
