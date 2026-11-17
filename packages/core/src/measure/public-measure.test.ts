import { describe, expect, it } from 'vitest';
import { evaluateMeasureCards, measureCard, measurePlot, TransientResult } from '../index.js';

describe('public waveform measurement API', () => {
  it('evaluates a measurement against a caller-supplied transient waveform', () => {
    const transient = new TransientResult([0, 1], new Map([['out', [2, 2]]]), new Map());
    const plot = measurePlot({ type: 'tran', timestep: 1, stopTime: 1 }, { transient, warnings: [] });
    expect(plot).toBeDefined();
    const result = evaluateMeasureCards([measureCard('.meas tran sample find v(out) at=0.5', 1, 0)], 'tran', plot!, new Map());
    expect(result).toMatchObject([{ name: 'sample', status: 'ok', value: 2 }]);
  });
});
