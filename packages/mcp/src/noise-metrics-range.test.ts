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
    expect(result).toMatchObject({ signalToNoiseRatioDb: expect.closeTo(density === 1e200 ? -4000 : 4000, 10) });
  });
  it.each([1, 1e200, 1e-200])('integrates clipped nonconstant linear PSD at scale %s', scale => {
    // [2,3]: PSD 5..9, area 7. [3,4]: PSD 9..6.5, area 7.75.
    const spectrum = new NoiseResult([1, 3, 5], 'out', 'V1', [scale, 3 * scale, 2 * scale], [2 * scale, 6 * scale, 4 * scale], undefined, undefined);
    const result = noiseMetrics(spectrum, { bandHz: [2, 4] });
    for (const [actual, expected] of [[result.integratedOutputNoiseVrms, Math.sqrt(14.75) * scale], [result.integratedInputNoiseRms, 2 * Math.sqrt(14.75) * scale]]) {
      expect(Number.isFinite(actual)).toBe(true);
      expect(actual).toBeGreaterThan(0);
      expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-12);
    }
  });
  it('accumulates representable subnormal noise across multiple intervals', () => {
    const y = Array(5).fill(Number.MIN_VALUE);
    const spectrum = new NoiseResult([1, 1.25, 1.5, 1.75, 2], 'out', 'V1', y, y, undefined, undefined);
    expect(noiseMetrics(spectrum, {})).toMatchObject({ integratedOutputNoiseVrms: Number.MIN_VALUE, integratedInputNoiseRms: Number.MIN_VALUE });
  });
  it('does not let density outside a clipped band disable subnormal accumulation', () => {
    const y = [1, ...Array(5).fill(Number.MIN_VALUE)];
    const spectrum = new NoiseResult([0.5, 1, 1.25, 1.5, 1.75, 2], 'out', 'V1', y, y, undefined, undefined);
    expect(noiseMetrics(spectrum, { bandHz: [1, 2] }).integratedOutputNoiseVrms).toBe(Number.MIN_VALUE);
  });
  it('preserves a clipped PSD contribution when its normalized weight underflows', () => {
    const y = [0, 1e150];
    const spectrum = new NoiseResult([1e-100, 1e300], 'out', 'V1', y, y, undefined, undefined);
    const result = noiseMetrics(spectrum, { bandHz: [1e-100, 2e-100] });
    for (const actual of [result.integratedOutputNoiseVrms, result.integratedInputNoiseRms]) {
      expect(Math.abs(actual / 7.071067811865475e-101 - 1)).toBeLessThan(1e-12);
    }
  });
  it('reports genuinely unrepresentable overflow and underflow as structured errors', () => {
    const huge = new NoiseResult([1, 5], 'out', 'V1', [Number.MAX_VALUE, Number.MAX_VALUE], [1, 1], undefined, undefined);
    const tiny = new NoiseResult([1, 1.25], 'out', 'V1', [Number.MIN_VALUE, Number.MIN_VALUE], [1, 1], undefined, undefined);
    for (const spectrum of [huge, tiny]) {
      expect(() => noiseMetrics(spectrum, {})).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', phase: 'validation', retryable: false }));
    }
  });
});
