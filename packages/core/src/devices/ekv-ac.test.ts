import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import type { DeviceModel, StampContext } from './device.js';
import { EKV26 } from './ekv.js';

function context(voltage: readonly number[]) {
  const capacitance = Array.from({ length: 4 }, () => new Float64Array(4));
  const ctx: StampContext = {
    stampC: (r, c, value) => { capacitance[r][c] += value; },
    stampG: () => { throw new Error('AC capacitance load must not stamp G'); },
    stampB: () => { throw new Error('AC capacitance load must not stamp RHS'); },
    getVoltage: n => voltage[n] ?? 0, getCurrent: () => 0,
    time: 0, dt: 0, numNodes: 4, sourceScale: 1, useDcSourceValue: true,
  };
  return { ctx, capacitance };
}

const parameters = { E0: 0, Q0: 0, WETA: 0, LETA: 0, CGSO: 2e-10, CGDO: 3e-10, CGBO: 1e-10 };

describe('EKV 2.6 quasi-static AC charge matrix (#1613)', () => {
  it('rolls off a common-source stage through intrinsic gate charge', async () => {
    const result = await simulate(`EKV intrinsic AC roll-off
VDD vdd 0 3
VIN in 0 1 AC 1
RG in g 1meg
RD vdd d 10k
M1 d g 0 0 n W=10u L=10u
.model n NMOS LEVEL=260 E0=0 Q0=0 WETA=0 LETA=0
.op
.ac dec 1 1 1e9
.end`);
    const output = result.ac!.voltage('d');
    const low = output[0];
    const lowReal = low.magnitude * Math.cos(low.phase * Math.PI / 180);
    const high = output[output.length - 1];
    const model = new EKV26('m', [0, 1, -1, -1], { E0: 0, Q0: 0, WETA: 0, LETA: 0 });
    const bias = result.dc!.voltage('d');
    const { derivatives: [gds, gm] } = model.evaluate([bias, 1, 0, 0]);
    const expected = -gm / (1 / 1e4 + gds + 1e-12);
    const relativeError = Math.abs(lowReal - expected) / Math.abs(expected);
    console.info(JSON.stringify({ lowGain: lowReal, dcGain: expected, relativeError, highMagnitude: high.magnitude, lowMagnitude: low.magnitude }));
    expect(relativeError).toBeLessThan(1e-8);
    // Intrinsic drain/gate transcapacitance leaves finite HF feedthrough.
    expect(high.magnitude).toBeLessThan(low.magnitude * 1e-2);
    expect(lowReal).toBeLessThan(0);
    expect(result.warnings.some(w => w.message.includes('AC/NQS'))).toBe(false);
  });

  for (const polarity of [1, -1]) {
    for (const [region, gate] of [['weak', 0.3], ['moderate', 0.6], ['strong', 1.5]] as const) {
      it(`matches every charge finite difference in ${region} inversion, polarity=${polarity}`, () => {
        const model: DeviceModel = new EKV26('m', [0, 1, 2, 3], { ...parameters, VTO: polarity * 0.5 }, {}, polarity);
        const ekv = model as EKV26;
        const point = [0.1, gate, 0, -0.2].map(v => polarity * v);
        const { ctx, capacitance } = context(point);
        model.stampDynamic?.(ctx);
        let maxRelativeError = 0;
        for (let col = 0; col < 4; col++) {
          const plus = [...point] as [number, number, number, number];
          const minus = [...point] as typeof plus;
          const h = 1e-5;
          plus[col] += h; minus[col] -= h;
          const qp = ekv.evaluateCharges(plus).charges;
          const qm = ekv.evaluateCharges(minus).charges;
          for (let row = 0; row < 4; row++) {
            const fd = (qp[row] - qm[row]) / (2 * h);
            const relativeError = Math.abs(capacitance[row][col] - fd) / Math.abs(fd);
            maxRelativeError = Math.max(maxRelativeError, relativeError);
            expect(relativeError, `row=${row}, col=${col}, C=${capacitance[row][col]}, FD=${fd}`).toBeLessThanOrEqual(1e-6);
          }
        }
        console.info(JSON.stringify({ region, polarity, maxRelativeError }));
        const direct = context(point);
        model.stampAC?.(direct.ctx, 2 * Math.PI * 1e6);
        expect(direct.capacitance).toEqual(capacitance);
        for (let row = 0; row < 4; row++) {
          expect(Math.abs(capacitance[row].reduce((a, b) => a + b, 0))).toBeLessThan(1e-27);
          expect(Math.abs(capacitance.reduce((sum, values) => sum + values[row], 0))).toBeLessThan(1e-27);
        }
      });
    }
  }

  it('maps grounded and tied terminals without changing the charge matrix', () => {
    const nodes = [0, 1, -1, 0];
    const model: DeviceModel = new EKV26('m', nodes, parameters);
    const point: [number, number, number, number] = [0.1, 0.6, 0, 0.1];
    const expected = (model as EKV26).evaluateCharges(point).jacobian;
    const { ctx, capacitance } = context([0.1, 0.6]);
    model.stampDynamic?.(ctx);
    for (const r of [0, 1]) for (const c of [0, 1]) {
      let sum = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        if (nodes[i] === r && nodes[j] === c) sum += expected[i][j];
      }
      expect(capacitance[r][c]).toBe(sum);
    }
  });
});
