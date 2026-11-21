import { describe, expect, it } from 'vitest';
import { powerMetrics, powerPlan } from './power-metrics.js';

function measure(current: number[], window?: [number, number]) {
  const plan = powerPlan({ netlist: 'V1 in 0 1\n.tran 0.1 2', elements: ['V1'], includeCharge: true, window });
  if ('error' in plan) throw new Error('Expected plan');
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0,
    timeS: [0, 0.3, 1.2, 2], voltagesV: { in: [0, 0, 0, 0] }, currentsA: { V1: current } }] }, plan).elements[0];
}

describe('signed transported charge', () => {
  it('integrates a nonuniform linear ramp and clips both edges', () => {
    expect(measure([0, 0.3, 1.2, 2])).toMatchObject({ chargeC: 2, averageCurrentA: 1 });
    expect(measure([0, 0.3, 1.2, 2], [0.5, 1.5])).toMatchObject({ chargeC: 1, averageCurrentA: 1 });
  });
  it('preserves current sign and cancellation', () => {
    expect(measure([0, -0.3, -1.2, -2]).chargeC).toBeCloseTo(-2, 14);
    expect(measure([-1, -0.7, 0.2, 1]).chargeC).toBeCloseTo(0, 14);
    expect(measure([0, 0, 0, 0])).toMatchObject({ chargeC: 0, averageCurrentA: 0 });
  });
  it('rejects nonfinite charge rather than emitting invalid JSON', () => {
    expect(() => measure([1e308, 1e308, 1e308, 1e308])).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
