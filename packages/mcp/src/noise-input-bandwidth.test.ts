import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const spectrum = (f: number[], input: number[], source = 'V1') => new NoiseResult(f, 'out', source, input.map(() => 1), input, undefined, undefined);

describe('input equivalent noise bandwidth', () => {
  it('reports flat full and clipped bands', () => {
    const args = noiseMetricsArgs({ netlist: 'test', inputNoiseBandwidthAtHz: 100, bandHz: [20, 70], bandsHz: [[10, 110]] });
    expect(noiseMetrics(spectrum([10, 30, 110], [2, 2, 2]), args)).toMatchObject({ inputNoiseBandwidthReferenceHz: 100, inputEquivalentNoiseBandwidthHz: 50, bandResults: [{ inputNoiseBandwidthReferenceHz: 100, inputEquivalentNoiseBandwidthHz: 100 }] });
  });
  it.each(['V1', 'I1'])('integrates nonuniform PSD and interpolates spots for %s', source => {
    for (const scale of [1e-200, 1, 1e200]) {
      const s = spectrum([10, 30, 110], [scale, 3 * scale, 5 * scale], source);
      const r = noiseMetrics(s, { inputNoiseBandwidthAtHz: 30, outputNoiseBandwidthAtHz: 10, bandsHz: [[10, 30], [30, 110]] });
      expect(r.inputUnit).toBe(source === 'I1' ? 'A' : 'V');
      expect(r.inputEquivalentNoiseBandwidthHz).toBeCloseTo(1460 / 9, 10);
      expect(r.outputEquivalentNoiseBandwidthHz).toBe(100);
      expect(r.bandResults![0].inputEquivalentNoiseBandwidthHz).toBeCloseTo(100 / 9, 10);
      expect(r.bandResults![1].inputEquivalentNoiseBandwidthHz).toBeCloseTo(1360 / 9, 10);
      expect(noiseMetrics(s, { inputNoiseBandwidthAtHz: Math.sqrt(300) }).inputEquivalentNoiseBandwidthHz).toBeCloseTo(365, 10);
    }
  });
  it('preserves legacy shape and reports zero and unrepresentable references', () => {
    const s = spectrum([10, 110], [0, 1]);
    const legacy = noiseMetrics(s, { bandsHz: [[10, 110]] });
    expect(legacy).not.toHaveProperty('inputEquivalentNoiseBandwidthHz');
    expect(legacy.bandResults![0]).not.toHaveProperty('inputEquivalentNoiseBandwidthHz');
    expect(noiseMetrics(s, { inputNoiseBandwidthAtHz: 10 })).toMatchObject({ inputEquivalentNoiseBandwidthHz: null, inputEquivalentNoiseBandwidthReason: 'zero reference density' });
    expect(noiseMetrics(spectrum([10, 110], [1e-200, 1]), { inputNoiseBandwidthAtHz: 10 })).toMatchObject({ inputEquivalentNoiseBandwidthHz: null, inputEquivalentNoiseBandwidthReason: 'nonrepresentable bandwidth' });
  });
});
