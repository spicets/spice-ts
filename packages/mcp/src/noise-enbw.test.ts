import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const spectrum = (f: number[], out: number[]) => new NoiseResult(f, 'out', 'V1', out, out.map(() => 1), undefined, undefined);

describe('output equivalent noise bandwidth', () => {
  it('computes flat and clipped bandwidth at any in-sweep reference', () => {
    const s = spectrum([10, 30, 110], [2, 2, 2]);
    const args = noiseMetricsArgs({ netlist: 'test', outputNoiseBandwidthAtHz: 100, bandHz: [20, 70], bandsHz: [[10, 110]] });
    expect(noiseMetrics(s, args)).toMatchObject({ outputNoiseBandwidthReferenceHz: 100, outputEquivalentNoiseBandwidthHz: 50, bandResults: [{ outputNoiseBandwidthReferenceHz: 100, outputEquivalentNoiseBandwidthHz: 100 }] });
  });
  it('integrates nonuniform piecewise-linear PSD and interpolates reference ASD in log frequency', () => {
    const s = spectrum([10, 30, 110], [1, 3, 5]);
    const result = noiseMetrics(s, { outputNoiseBandwidthAtHz: 30, bandsHz: [[10, 30], [30, 110]] });
    expect(result.outputEquivalentNoiseBandwidthHz).toBeCloseTo(1460 / 9, 12);
    expect(result.bandResults![0].outputEquivalentNoiseBandwidthHz).toBeCloseTo(100 / 9, 12);
    expect(result.bandResults![1].outputEquivalentNoiseBandwidthHz).toBeCloseTo(1360 / 9, 12);
    const intermediate = noiseMetrics(s, { outputNoiseBandwidthAtHz: Math.sqrt(300) });
    expect(intermediate.outputEquivalentNoiseBandwidthHz).toBeCloseTo(1460 / 4, 10);
  });
  it('is invariant to extreme density scales without squaring PSD or RMS', () => {
    for (const scale of [1e-200, 1, 1e200]) {
      const s = spectrum([10, 30, 110], [scale, 3 * scale, 5 * scale]);
      expect(noiseMetrics(s, { outputNoiseBandwidthAtHz: 30 }).outputEquivalentNoiseBandwidthHz).toBeCloseTo(1460 / 9, 10);
    }
  });
  it('reports zero reference and nonrepresentable bandwidth explicitly', () => {
    expect(noiseMetrics(spectrum([10, 110], [0, 0]), { outputNoiseBandwidthAtHz: 10 })).toMatchObject({ outputEquivalentNoiseBandwidthHz: null, outputEquivalentNoiseBandwidthReason: 'zero reference density' });
    expect(noiseMetrics(spectrum([10, 110], [0, 1]), { outputNoiseBandwidthAtHz: 10 })).toMatchObject({ outputEquivalentNoiseBandwidthHz: null, outputEquivalentNoiseBandwidthReason: 'zero reference density' });
    expect(noiseMetrics(spectrum([10, 110], [1e-200, 1]), { outputNoiseBandwidthAtHz: 10 })).toMatchObject({ outputEquivalentNoiseBandwidthHz: null, outputEquivalentNoiseBandwidthReason: 'nonrepresentable bandwidth' });
  });
  it('preserves the previous result when omitted', () => {
    const s = spectrum([10, 110], [2, 2]);
    const plain = noiseMetrics(s, { bandsHz: [[20, 70]] });
    expect(plain).not.toHaveProperty('outputEquivalentNoiseBandwidthHz');
    expect(plain.bandResults![0]).not.toHaveProperty('outputEquivalentNoiseBandwidthHz');
    const { outputNoiseBandwidthReferenceHz: _ref, outputEquivalentNoiseBandwidthHz: _bw, bandResults, ...rest } = noiseMetrics(s, { bandsHz: [[20, 70]], outputNoiseBandwidthAtHz: 10 });
    const { outputNoiseBandwidthReferenceHz: _bandRef, outputEquivalentNoiseBandwidthHz: _bandBw, ...band } = bandResults![0];
    expect({ ...rest, bandResults: [band] }).toEqual(plain);
  });
});
