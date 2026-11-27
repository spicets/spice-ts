import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics, type NoiseMetricsArgs } from './noise-metrics.js';

const crest = (f: number[], y: number[], bandHz: [number, number], bandsHz?: [number, number][]) =>
  noiseMetrics(new NoiseResult(f, 'out', 'V1', y, y, undefined, undefined), { bandHz, bandsHz, includeOutputNoiseCrest: true } as NoiseMetricsArgs) as unknown as { outputNoiseSpectralCrest: number | null; outputNoiseSpectralCrestReason?: string; bandResults?: { outputNoiseSpectralCrest: number | null; outputNoiseSpectralCrestReason?: string }[] };

const close = (actual: number | null, expected: number) => {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual! / expected - 1)).toBeLessThan(1e-12);
  expect(actual!).toBeGreaterThanOrEqual(1);
};

describe('output PSD spectral crest', () => {
  it('gives one for flat PSD and two for a triangular PSD', () => {
    close(crest([1, 2, 5], [3, 3, 3], [1, 5]).outputNoiseSpectralCrest, 1);
    close(crest([1, 5], [0, 2], [1, 5]).outputNoiseSpectralCrest, 2);
  });
  it('uses clipped PSD edges for primary and independent sub-bands', () => {
    const r = crest([1, 5], [0, 2], [2, 4], [[1, 3], [3, 5]]);
    close(r.outputNoiseSpectralCrest, 1.5);
    close(r.bandResults![0].outputNoiseSpectralCrest, 2);
    close(r.bandResults![1].outputNoiseSpectralCrest, 4 / 3);
  });
  it.each([1e-200, 1, 1e200])('is invariant to density scale %s and collinear PSD samples', scale => {
    close(crest([1, 5], [0, 2 * scale], [2, 4]).outputNoiseSpectralCrest, 1.5);
    close(crest([1, 3, 5], [0, Math.SQRT2 * scale, 2 * scale], [2, 4]).outputNoiseSpectralCrest, 1.5);
  });
  it('handles extreme finite frequencies and densities', () => {
    close(crest([1, 1e308], [1e-155, 1e-155], [1, 1e308]).outputNoiseSpectralCrest, 1);
    close(crest([1e-200, 2e-200], [1e200, 1e200], [1e-200, 2e-200]).outputNoiseSpectralCrest, 1);
  });
  it('reports zero noise in each requested band', () => {
    expect(crest([1, 2, 4], [0, 0, 0], [1, 4], [[1, 2]])).toMatchObject({ outputNoiseSpectralCrest: null, outputNoiseSpectralCrestReason: 'zero integrated output noise', bandResults: [{ outputNoiseSpectralCrest: null, outputNoiseSpectralCrestReason: 'zero integrated output noise' }] });
  });
  it('preserves the default output byte-for-byte when explicitly disabled', () => {
    const result = new NoiseResult([1, 2], 'out', 'V1', [1, 1], [1, 1], undefined, undefined);
    const plain = noiseMetrics(result, { bandsHz: [[1, 2]] });
    const disabled = noiseMetrics(result, { bandsHz: [[1, 2]], includeOutputNoiseCrest: false } as NoiseMetricsArgs);
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(plain));
    expect(plain).not.toHaveProperty('outputNoiseSpectralCrest');
  });
});
