import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics } from './noise-metrics.js';

describe('input PSD spectral crest', () => {
  it('uses clipped, nonuniform input PSD rather than output PSD', () => {
    const spectrum = new NoiseResult([1, 3, 7], 'out', 'V1', [2, 2, 2], [1, 2, 4], undefined, undefined);
    const result = noiseMetrics(spectrum, { bandHz: [2, 5], includeInputNoiseCrest: true, includeOutputNoiseCrest: true }) as unknown as { inputNoiseSpectralCrest: number; outputNoiseSpectralCrest: number };
    // Clipped input PSDs are 2.5, 4 and 10. Their area is 17.25 over 3 Hz.
    expect(result.inputNoiseSpectralCrest).toBeCloseTo(40 / 23, 12);
    expect(result.outputNoiseSpectralCrest).toBeCloseTo(1, 12);
  });

  it.each([1e-200, 1, 1e200])('handles flat and sloped densities at scale %s', scale => {
    const flat = new NoiseResult([1, 2, 5], 'out', 'V1', [1, 1, 1], [scale, scale, scale], undefined, undefined);
    const slope = new NoiseResult([1, 5], 'out', 'V1', [1, 1], [0, 2 * scale], undefined, undefined);
    expect(noiseMetrics(flat, { includeInputNoiseCrest: true })).toMatchObject({ inputNoiseSpectralCrest: 1 });
    const r = noiseMetrics(slope, { bandHz: [2, 4], bandsHz: [[1, 3], [3, 5]], includeInputNoiseCrest: true }) as unknown as { inputNoiseSpectralCrest: number; bandResults: { inputNoiseSpectralCrest: number }[] };
    expect(r.inputNoiseSpectralCrest).toBeCloseTo(1.5, 12);
    expect(r.bandResults[0].inputNoiseSpectralCrest).toBeCloseTo(2, 12);
    expect(r.bandResults[1].inputNoiseSpectralCrest).toBeCloseTo(4 / 3, 12);
  });

  it('reports zero and nonrepresentable input crests without changing output crest', () => {
    const zero = new NoiseResult([1, 2], 'out', 'V1', [1, 1], [0, 0], undefined, undefined);
    expect(noiseMetrics(zero, { includeInputNoiseCrest: true, bandsHz: [[1, 2]] })).toMatchObject({ inputNoiseSpectralCrest: null, inputNoiseSpectralCrestReason: 'zero integrated input noise', bandResults: [{ inputNoiseSpectralCrest: null, inputNoiseSpectralCrestReason: 'zero integrated input noise' }] });
    const spike = new NoiseResult([1e-300, 2e-300, 3e-300, 1e100], 'out', 'V1', [1, 1, 1, 1], [0, 1, 0, 0], undefined, undefined);
    expect(noiseMetrics(spike, { includeInputNoiseCrest: true })).toMatchObject({ inputNoiseSpectralCrest: null, inputNoiseSpectralCrestReason: 'nonrepresentable crest' });
  });

  it('preserves all legacy values when omitted or false', () => {
    const spectrum = new NoiseResult([1, 2], 'out', 'V1', [1, 2], [2, 1], undefined, undefined);
    const args = { bandsHz: [[1, 2]] as [number, number][], includeOutputNoiseCrest: true };
    expect(JSON.stringify(noiseMetrics(spectrum, { ...args, includeInputNoiseCrest: false }))).toBe(JSON.stringify(noiseMetrics(spectrum, args)));
  });
});
