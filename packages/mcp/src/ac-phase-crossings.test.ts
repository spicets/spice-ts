import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { acMetrics } from './ac-metrics.js';

const sweep = (phases: number[], magnitudes = phases.map(() => 1)): SimulationResultV1 => ({ status: 'complete', analyses: [{
  type: 'ac', analysisIndex: 0, frequencyHz: phases.map((_, i) => 10 ** (2 * i + 1)), currentPhasors: {},
  voltagePhasors: { out: phases.map((phaseDegrees, i) => ({ magnitude: magnitudes[i], phaseDegrees })) },
}] });

describe('requested phase crossings', () => {
  it('interpolates phase against log frequency and preserves duplicate targets', () => {
    const result = acMetrics(sweep([-45, -135]), { output: 'out', phaseCrossingsDeg: [-90, -90] });
    expect(result.phaseCrossings).toEqual([{ targetDeg: -90, frequencyHz: expect.closeTo(100, 10) }, { targetDeg: -90, frequencyHz: expect.closeTo(100, 10) }]);
  });
  it('accepts endpoints, selects the first descending crossing and reports misses', () => {
    const result = acMetrics(sweep([0, -90, -45, -135]), { output: 'out', phaseCrossingsDeg: [0, -90, -135, -160] }).phaseCrossings!;
    expect(result[0].frequencyHz).toBeCloseTo(10);
    expect(result[1].frequencyHz).toBeCloseTo(1000);
    expect(result[2].frequencyHz).toBeCloseTo(1e7);
    expect(result[3]).toEqual({ targetDeg: -160, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
  });
  it('unwraps phase across the principal boundary', () => {
    const result = acMetrics(sweep([-135, 135]), { output: 'out', phaseCrossingsDeg: [-180] });
    expect(result.phaseCrossings![0].frequencyHz).toBeCloseTo(100);
  });
  it('does not cross through a zero output', () => {
    const result = acMetrics(sweep([-45, -90, -135], [1, 0, 1]), { output: 'out', phaseCrossingsDeg: [-90] });
    expect(result.phaseCrossings![0]).toEqual({ targetDeg: -90, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
  });
  it('restarts unwrapping after zero magnitude regardless of its undefined phase', () => {
    const targets = [165, -195, -180];
    const query = (zeroPhase: number) => acMetrics(sweep([-170, zeroPhase, 170, 160], [1, 0, 1, 1]), {
      output: 'out', phaseCrossingsDeg: targets,
    }).phaseCrossings!;
    const expected = query(0);
    expect(query(-170)).toEqual(expected);
    expect(expected[0].frequencyHz).toBeCloseTo(1e6);
    expect(expected[1]).toEqual({ targetDeg: -195, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
    expect(expected[2]).toEqual({ targetDeg: -180, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
  });
  it('preserves legacy response when omitted', () => {
    const trace = sweep([-45, -135]);
    const legacy = acMetrics(trace, { output: 'out' });
    const { phaseCrossings: _crossings, ...rest } = acMetrics(trace, { output: 'out', phaseCrossingsDeg: [-90] });
    expect(JSON.stringify(rest)).toBe(JSON.stringify(legacy));
  });
});
