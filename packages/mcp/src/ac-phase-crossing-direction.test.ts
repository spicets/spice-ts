import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { acMetrics } from './ac-metrics.js';

const sweep = (phases: number[], magnitudes = phases.map(() => 1)): SimulationResultV1 => ({ status: 'complete', analyses: [{
  type: 'ac', analysisIndex: 0, frequencyHz: phases.map((_, i) => 10 ** (2 * i + 1)), currentPhasors: {},
  voltagePhasors: { out: phases.map((phaseDegrees, i) => ({ magnitude: magnitudes[i], phaseDegrees })) },
}] });

describe('directional phase crossings', () => {
  it('selects the first crossing in the requested direction', () => {
    const trace = sweep([0, -90, 0]);
    const query = (phaseCrossingDirection: 'ascending' | 'descending' | 'either') => acMetrics(trace, { output: 'out', phaseCrossingsDeg: [-45], phaseCrossingDirection }).phaseCrossings![0].frequencyHz;
    expect(query('descending')).toBeCloseTo(100);
    expect(query('ascending')).toBeCloseTo(10000);
    expect(query('either')).toBeCloseTo(100);
  });
  it('counts endpoints but ignores flat segments, including target plateaus', () => {
    const trace = sweep([0, 0, 45, 45]);
    const query = (direction: 'ascending' | 'descending' | 'either', target: number) => acMetrics(trace, { output: 'out', phaseCrossingsDeg: [target], phaseCrossingDirection: direction }).phaseCrossings![0];
    expect(query('ascending', 0).frequencyHz).toBeCloseTo(1000);
    expect(query('either', 45).frequencyHz).toBeCloseTo(100000);
    expect(query('descending', 0)).toEqual({ targetDeg: 0, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
    expect(acMetrics(sweep([0, 0]), { output: 'out', phaseCrossingsDeg: [0], phaseCrossingDirection: 'either' }).phaseCrossings![0].frequencyHz).toBeNull();
  });
  it('unwraps ascending crossings and does not bridge undefined or zero magnitude', () => {
    expect(acMetrics(sweep([135, -135]), { output: 'out', phaseCrossingsDeg: [180], phaseCrossingDirection: 'ascending' }).phaseCrossings![0].frequencyHz).toBeCloseTo(100);
    expect(acMetrics(sweep([-90, 0, 90], [1, 0, 1]), { output: 'out', phaseCrossingsDeg: [0], phaseCrossingDirection: 'ascending' }).phaseCrossings![0]).toEqual({ targetDeg: 0, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
    expect(acMetrics(sweep([135, 170]), { output: 'out', phaseCrossingsDeg: [-180], phaseCrossingDirection: 'ascending' }).phaseCrossings![0].frequencyHz).toBeNull();
  });
  it('retains default and gain margin semantics', () => {
    const trace = sweep([-135, 135, -135]);
    const base = acMetrics(trace, { output: 'out', phaseCrossingsDeg: [-180] });
    const descending = acMetrics(trace, { output: 'out', phaseCrossingsDeg: [-180], phaseCrossingDirection: 'descending' });
    const ascending = acMetrics(trace, { output: 'out', phaseCrossingsDeg: [-180], phaseCrossingDirection: 'ascending' });
    expect(descending).toEqual(base);
    expect(ascending.gainMarginDb).toEqual(base.gainMarginDb);
    expect(ascending.phaseMarginDeg).toEqual(base.phaseMarginDeg);
  });
});
