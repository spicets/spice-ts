import { describe, expect, it } from 'vitest';
import { powerMetrics, powerPlan } from './power-metrics.js';

describe('signed transient energy', () => {
  it('integrates a quadratic product on clipped nonuniform segments', () => {
    const plan = powerPlan({ netlist: 'V1 in 0 0\n.tran 1 3', elements: ['V1'], window: [0.5, 2] });
    if ('error' in plan) throw new Error('Expected a plan');
    const metric = powerMetrics({ status: 'complete', analyses: [{
      type: 'tran', analysisIndex: 0, timeS: [0, 1, 3],
      voltagesV: { in: [0, 1, 3] }, currentsA: { V1: [0, 1, 3] },
    }] }, plan).elements[0];
    // v(t)=i(t)=t; integral from 0.5 to 2 is (2^3 - 0.5^3)/3.
    expect(metric.energyJ).toBeCloseTo(2.625, 12);
    expect(metric.energyJ).toBeCloseTo(metric.averagePowerW * 1.5, 12);
  });

  it.each([
    { name: 'C1', voltage: [0, 1, 0], current: [1, 0, -1] },
    { name: 'L1', voltage: [1, 0, -1], current: [0, 1, 0] },
  ])('retains energy returned by $name and zero net energy', ({ name, voltage, current }) => {
    const netlist = `${name} in 0 1\n.tran 1 2`;
    const measure = (window: [number, number]) => {
      const plan = powerPlan({ netlist, elements: [name], window });
      if ('error' in plan) throw new Error('Expected a plan');
      return powerMetrics({ status: 'complete', analyses: [{
        type: 'tran', analysisIndex: 0, timeS: [0, 1, 2],
        voltagesV: { in: voltage }, currentsA: { [plan.probes[0].branch]: current },
      }] }, plan).elements[0].energyJ;
    };
    expect(measure([0, 1])).toBeCloseTo(1 / 6, 12);
    expect(measure([1, 2])).toBeCloseTo(-1 / 6, 12);
    expect(measure([0, 2])).toBeCloseTo(0, 12);
  });
});
