import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StampContext } from './device.js';
import { VBIC } from './vbic.js';

function fixture(TD = 0, polarity = 1) {
  const nodes = Array.from({ length: TD > 0 ? 9 : 7 }, (_, index) => index);
  const device = new VBIC('Q', nodes, {
    TD, CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12,
    TF: 1e-12, TR: 2e-12, VEF: 50, IKF: 0.01, ISP: 1e-16,
    AVC1: 0.1, AVC2: 5, GAMM: 0.01, QCO: 1e-13, WBE: 0.4,
  }, polarity, 2);
  const voltage = [0.2, 0.3, 0.1, 0.65, 0, 0.05, 0.2, 0.01, 0.02];
  const stamps: number[] = [];
  const ctx: StampContext = {
    stampG: (r, c, v) => { stamps.push(0, r, c, v); },
    stampB: (r, v) => { stamps.push(1, r, v); },
    stampC: (r, c, v) => { stamps.push(2, r, c, v); },
    getVoltage: n => polarity * voltage[n], getCurrent: () => 0,
    time: 0, dt: 1e-12, numNodes: nodes.length, sourceScale: 1, useDcSourceValue: false,
  };
  return { device, voltage, stamps, ctx };
}

function bytes(values: number[]): string {
  const hash = createHash('sha256');
  for (const value of values) {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(value);
    hash.update(buffer);
  }
  return hash.digest('hex');
}

describe('VBIC Dual workspaces (#1310 round 8)', () => {
  it('constructs no derivative arrays in repeated warmed VBIC loads', () => {
    const fixtures = [fixture(), fixture(2e-12, -1)];
    // Visit both depletion branches before measuring the workspace high-water mark.
    for (const f of fixtures) for (const bias of [0.15, 2.5, -3]) {
      f.voltage[3] = bias;
      for (let i = 0; i < 8; i++) f.device.stamp(f.ctx);
    }
    let allocations = 0;
    const OriginalArray = Array;
    vi.stubGlobal('Array', new Proxy(OriginalArray, {
      // Array.from creates result-row containers too. Keep those on the native
      // constructor so the counter measures explicit derivative allocations only.
      get(target, property) {
        return property === 'from' ? OriginalArray.from.bind(OriginalArray) : Reflect.get(target, property);
      },
      construct(target, args) {
        if (args.length === 1 && (args[0] === 9 || args[0] === 11)) allocations++;
        return Reflect.construct(target, args);
      },
    }));
    const OriginalFloat64Array = Float64Array;
    vi.stubGlobal('Float64Array', new Proxy(OriginalFloat64Array, {
      construct(target, args) {
        // The experimental workspace allocates slabs of 256 derivative rows.
        // Exclude the pre-existing per-node Jacobians (7 or 9 elements).
        if (args.length === 1 && (args[0] === 9 * 256 || args[0] === 11 * 256)) allocations++;
        return Reflect.construct(target, args);
      },
    }));
    try {
      for (let load = 0; load < 40; load++) for (const f of fixtures) {
        f.voltage[3] = [0.15, 2.5, -3][load % 3];
        f.device.stamp(f.ctx);
      }
    } finally { vi.unstubAllGlobals(); }
    // Every Dual owns exactly one derivative array. This counts those paired
    // constructions, not allocations of evaluation wrappers or typed Jacobians.
    expect(allocations).toBe(0);
  });

  it.each([0, 2e-12])('keeps cached load charges across other evaluations (TD=%s)', TD => {
    const reference = fixture(TD);
    const interleaved = fixture(TD);
    const unrelated = fixture(TD, -1);
    for (const temperature of [0, 75, 27]) {
      for (const f of [reference, interleaved]) {
        f.device.setTemperature(temperature);
        f.device.resetTransient();
      }
      for (const bias of [0.15, 0.65, -0.1, 2.5, -3]) {
        for (const f of [reference, interleaved]) {
          f.voltage[3] = bias;
          f.device.stamp(f.ctx);
          f.stamps.length = 0;
        }
        // Different voltages make accidental reuse of the load workspace visible.
        interleaved.voltage[3] = -bias;
        interleaved.device.stampDynamic(interleaved.ctx);
        interleaved.device.noiseOperatingPoint(Float64Array.from(interleaved.voltage));
        unrelated.device.stamp(unrelated.ctx);
        interleaved.voltage[3] = bias;
        interleaved.stamps.length = 0;
        for (const f of [reference, interleaved]) {
          f.device.stampTransientCharge(f.ctx, { method: 'euler', dt: 1e-12 });
        }
        expect(bytes(interleaved.stamps)).toBe(bytes(reference.stamps));
        for (const f of [reference, interleaved]) f.device.acceptTransientStep(f.ctx);
      }
    }
  });
});
