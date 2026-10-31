import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics } from './noise-metrics.js';

describe('noise integration numerical range', () => {
  it.each([1e200, 1e-200])('preserves constant density %s and its SNR', density => {
    const spectrum = new NoiseResult([1, 2], 'out', 'V1', [density, density], [density, density], undefined, undefined);
    const result = noiseMetrics(spectrum, { signalRms: 1 });
    for (const rms of [result.integratedOutputNoiseVrms, result.integratedInputNoiseRms]) {
      expect(Number.isFinite(rms)).toBe(true);
      expect(rms).toBeGreaterThan(0);
      expect(Math.abs(rms / density - 1)).toBeLessThan(1e-12);
    }
    expect(result.signalToNoiseRatioDb).toBeCloseTo(density === 1e200 ? -4000 : 4000, 10);
  });
});
