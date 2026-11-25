import { describe, expect, it } from 'vitest';
import { powerMetrics, powerPlan } from './power-metrics.js';

function measure(times: number[], current: number[], window?: [number, number]) {
  const args = { netlist: 'V1 in 0 1\n.tran 0.1 4', elements: ['V1'], includeCharge: true, includeChargeFlow: true, window };
  const plan = powerPlan(args);
  if ('error' in plan) throw new Error('Expected plan');
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0,
    timeS: times, voltagesV: { in: times.map(() => 0) }, currentsA: { V1: current } }] }, plan).elements[0];
}

describe('directional charge flow', () => {
  it('splits a linear zero crossing into equal triangular areas', () => {
    expect(measure([0, 2], [-2, 2])).toMatchObject({ positiveChargeC: 1, negativeChargeC: 1, chargeC: 0 });
  });
  it('integrates nonuniform asymmetric segments and clipped edges', () => {
    const times = [0, 1, 3, 4]; const current = [-2, 2, -2, -2];
    expect(measure(times, current)).toMatchObject({ positiveChargeC: 1.5, negativeChargeC: 3.5, chargeC: -2 });
    expect(measure(times, current, [0.25, 3.5])).toMatchObject({ positiveChargeC: 1.5, negativeChargeC: 2.125, chargeC: -0.625 });
    const reverse = measure(times, current.map(i => -i), [0.25, 3.5]);
    expect(reverse).toMatchObject({ positiveChargeC: 2.125, negativeChargeC: 1.5, chargeC: 0.625 });
  });
  it.each([
    [[2, 2], 4, 0], [[-2, -2], 0, 4], [[0, 0], 0, 0], [[0, 2], 2, 0], [[0, -2], 0, 2],
  ])('handles single sign and zero %j', (current, positiveChargeC, negativeChargeC) => {
    const result = measure([0, 2], current as number[]);
    expect(result).toMatchObject({ positiveChargeC, negativeChargeC });
    expect(result.chargeC).toBeCloseTo((positiveChargeC as number) - (negativeChargeC as number), 14);
  });
  it('rejects unrepresentable directional charge', () => {
    expect(() => measure([0, 2], [1e308, 1e308])).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
