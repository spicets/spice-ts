import { describe, expect, it } from 'vitest';
import { powerMetrics, powerPlan } from './power-metrics.js';

function measure(current: number, voltage: number) {
  const plan = powerPlan({ netlist: 'V1 in 0 0\n.tran 1 1', elements: ['V1'] });
  if ('error' in plan) throw new Error('Expected a plan');
  return powerMetrics({ status: 'complete', analyses: [{
    type: 'tran', analysisIndex: 0, timeS: [0, 1],
    voltagesV: { in: [voltage, voltage] }, currentsA: { V1: [current, current] },
  }] }, plan).elements[0];
}

describe('power RMS dynamic range', () => {
  it.each([1e200, 1e-200, -1e200, -1e-200])('preserves constant current %s', current => {
    const metric = measure(current, Math.abs(current) > 1 ? 1e-200 : 1e200);
    expect(metric.rmsCurrentA / Math.abs(current)).toBeCloseTo(1, 12);
    expect(metric.averagePowerW).toBeCloseTo(Math.sign(current), 12);
    expect(metric.energyJ).toBeCloseTo(Math.sign(current), 12);
  });
});
