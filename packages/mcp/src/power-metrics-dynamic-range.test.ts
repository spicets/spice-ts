import { describe, expect, it } from 'vitest';
import { powerMetrics, powerPlan } from './power-metrics.js';
import { executeTool } from './server.js';

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

  it('retains the smallest subnormal current across many segments', () => {
    const plan = powerPlan({ netlist: 'V1 in 0 0\n.tran 1 10', elements: ['V1'] });
    if ('error' in plan) throw new Error('Expected a plan');
    const times = Array.from({ length: 11 }, (_, i) => i);
    const report = powerMetrics({ status: 'complete', analyses: [{
      type: 'tran', analysisIndex: 0, timeS: times,
      voltagesV: { in: times.map(() => 1) }, currentsA: { V1: times.map(() => Number.MIN_VALUE) },
    }] }, plan);
    expect(report.elements[0].rmsCurrentA).toBe(Number.MIN_VALUE);
  });

  it.each([1e200, 1e-200])('integrates a clipped nonuniform linear ramp at scale %s', current => {
    for (const timeScale of [1e-100, 1, 1e100]) {
      const times = [0, 0.2, 0.7, 1].map(t => t * timeScale);
      const plan = powerPlan({ netlist: 'V1 in 0 0\n.tran 1 1', elements: ['V1'], window: [0.1 * timeScale, 0.9 * timeScale] });
      if ('error' in plan) throw new Error('Expected a plan');
      const metric = powerMetrics({ status: 'complete', analyses: [{
        type: 'tran', analysisIndex: 0, timeS: times,
        voltagesV: { in: times.map(() => 0) }, currentsA: { V1: [0, 0.2, 0.7, 1].map(t => t * current) },
      }] }, plan).elements[0];
      expect(metric.rmsCurrentA / Math.abs(current)).toBeCloseTo(Math.sqrt((0.9 ** 3 - 0.1 ** 3) / (3 * 0.8)), 12);
    }
  });

  it.each([1e200, 1e-200])('integrates a zero-to-I ramp at scale %s', current => {
    const plan = powerPlan({ netlist: 'V1 in 0 0\n.tran 1 1', elements: ['V1'] });
    if ('error' in plan) throw new Error('Expected a plan');
    const report = powerMetrics({ status: 'complete', analyses: [{
      type: 'tran', analysisIndex: 0, timeS: [0, 1],
      voltagesV: { in: [0, 0] }, currentsA: { V1: [0, current] },
    }] }, plan);
    expect(report.elements[0].rmsCurrentA / Math.abs(current)).toBeCloseTo(1 / Math.sqrt(3), 12);
  });

  it('rejects unrepresentable power rather than serializing null', () => {
    expect(() => measure(1e200, 1e200)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('reports normal current through a real public-tool transient', async () => {
    const response = await executeTool('spice_power_metrics', {
      netlist: 'V1 in 0 10\nR1 in 0 1k\n.tran 1u 10u\n.end', elements: ['R1'],
    });
    expect(response.isError).not.toBe(true);
    const report = response.structuredContent as unknown as { elements: { rmsCurrentA: number; averagePowerW: number }[] };
    expect(report.elements[0].rmsCurrentA).toBeCloseTo(0.01, 12);
    expect(report.elements[0].averagePowerW).toBeCloseTo(0.1, 12);
  });
});
