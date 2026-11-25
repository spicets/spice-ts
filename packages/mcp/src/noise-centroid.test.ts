import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics } from './noise-metrics.js';

const centroid = (lo: number, hi: number) => ((2 / 3) * (hi ** 3 - lo ** 3) + 1.5 * (hi ** 2 - lo ** 2)) / ((hi ** 2 - lo ** 2) + 3 * (hi - lo));
const make = (scale: number) => new NoiseResult([2, 7, 19, 40], 'out', 'V1', [2, 7, 19, 40].map(f => Math.sqrt(2 * f + 3) * scale), [1, 1, 1, 1], undefined, undefined);

describe('output noise centroid', () => {
  it('returns the midpoint of a constant PSD for primary and clipped bands', () => {
    const spectrum = new NoiseResult([10, 17, 30], 'out', 'V1', [2, 2, 2], [2, 2, 2], undefined, undefined);
    const result = noiseMetrics(spectrum, { includeOutputNoiseCentroid: true, bandsHz: [[12, 26]] });
    expect(result.outputNoiseCentroidHz).toBeCloseTo(20, 12);
    expect(result.bandResults![0].outputNoiseCentroidHz).toBeCloseTo(19, 12);
  });
  it.each([1, 1e-100, 1e100])('matches independent linear-PSD integrals at density scale %s', scale => {
    const result = noiseMetrics(make(scale), { bandHz: [4, 31], bandsHz: [[3, 13], [11, 37]], includeOutputNoiseCentroid: true });
    const values = [result.outputNoiseCentroidHz!, ...result.bandResults!.map(row => row.outputNoiseCentroidHz!)];
    const expected = [centroid(4, 31), centroid(3, 13), centroid(11, 37)];
    values.forEach((value, i) => expect(Math.abs(value / expected[i] - 1)).toBeLessThan(1e-12));
    console.log('linear PSD expected / actual', expected, values, 'scale', scale);
  });
  it('returns null with a reason for zero noise and leaves defaults unchanged', () => {
    const zero = new NoiseResult([10, 30], 'out', 'V1', [0, 0], [0, 0], undefined, undefined);
    const plain = noiseMetrics(zero, { bandsHz: [[12, 20]] });
    expect(plain).not.toHaveProperty('outputNoiseCentroidHz');
    expect(plain.bandResults![0]).not.toHaveProperty('outputNoiseCentroidHz');
    const selected = noiseMetrics(zero, { bandsHz: [[12, 20]], includeOutputNoiseCentroid: true });
    expect(selected).toMatchObject({ outputNoiseCentroidHz: null, outputNoiseCentroidReason: 'zero integrated output noise', bandResults: [{ outputNoiseCentroidHz: null, outputNoiseCentroidReason: 'zero integrated output noise' }] });
  });
  it('retains a representable centroid in a tiny part of a huge band', () => {
    const spectrum = new NoiseResult([1, 1e100, 2e100, 3e100, 1e300], 'out', 'V1', [0, 0, 1, 0, 0], [0, 0, 0, 0, 0], undefined, undefined);
    const result = noiseMetrics(spectrum, { includeOutputNoiseCentroid: true });
    expect(Math.abs(result.outputNoiseCentroidHz! / 2e100 - 1)).toBeLessThan(1e-12);
  });
  it('rejects bands outside the simulated sweep', () => {
    expect(() => noiseMetrics(make(1), { bandHz: [1, 30], includeOutputNoiseCentroid: true })).toThrow();
    expect(() => noiseMetrics(make(1), { bandsHz: [[3, 41]], includeOutputNoiseCentroid: true })).toThrow();
  });
});
