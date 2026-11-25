import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics, noiseMetricsArgs, type NoiseMetricsArgs } from './noise-metrics.js';

const spectrum = (input: number[], output = input) => new NoiseResult([10, 60, 110], 'out', 'V1', output, input, undefined, undefined);
const selected = (args: object) => args as NoiseMetricsArgs;

describe('input noise band power fractions', () => {
  it('uses power rather than RMS at finite extreme scales', () => {
    for (const scale of [1, 1e-200, 1e200]) {
      const rows = noiseMetrics(spectrum([scale, scale, scale]), selected({ bandsHz: [[10, 35], [35, 110]], includeInputNoiseBandFractions: true })).bandResults!;
      expect(rows[0]).toHaveProperty('inputNoisePowerFraction', expect.closeTo(0.25, 12));
      expect(rows[1]).toHaveProperty('inputNoisePowerFraction', expect.closeTo(0.75, 12));
    }
  });
  it('integrates the input PSD independently, preserving duplicates and overlapping bands', () => {
    // Input PSD is 1, 9, 25. Its linear-frequency primitive is analytic.
    const primitive = (f: number) => f <= 60 ? (f - 10) + 0.08 * (f - 10) ** 2 : 250 + 9 * (f - 60) + 0.16 * (f - 60) ** 2;
    const bands: [number, number][] = [[20, 75], [40, 90], [20, 75], [75, 100]];
    const rows = noiseMetrics(spectrum([1, 3, 5], [2, 2, 2]), selected({ bandHz: [20, 100], bandsHz: bands, includeInputNoiseBandFractions: true, includeOutputNoiseBandFractions: true })).bandResults!;
    const total = primitive(100) - primitive(20);
    for (const [i, [a, b]] of bands.entries()) {
      expect(rows[i].bandHz).toEqual(bands[i]);
      expect((rows[i] as { inputNoisePowerFraction: number }).inputNoisePowerFraction).toBeCloseTo((primitive(b) - primitive(a)) / total, 12);
      expect(rows[i].outputNoisePowerFraction).toBeCloseTo((b - a) / 80, 12);
    }
    expect(rows[0]).toEqual(rows[2]);
    expect(rows.reduce((sum, row) => sum + (row as { inputNoisePowerFraction: number }).inputNoisePowerFraction, 0)).toBeGreaterThan(1);
  });
  it('returns a documented null for zero input power independently of output', () => {
    const row = noiseMetrics(spectrum([0, 0, 0], [1, 1, 1]), selected({ bandsHz: [[10, 35]], includeInputNoiseBandFractions: true, includeOutputNoiseBandFractions: true })).bandResults![0];
    expect(row).toMatchObject({ inputNoisePowerFraction: null, inputNoisePowerFractionReason: 'zero integrated input noise', outputNoisePowerFraction: expect.closeTo(0.25, 12) });
  });
  it('preserves the default shape and validates flag and band containment', () => {
    const s = spectrum([1, 1, 1]);
    const base = { bandHz: [20, 100] as [number, number], bandsHz: [[10, 30]] as [number, number][] };
    expect(noiseMetrics(s, selected({ ...base, includeInputNoiseBandFractions: false }))).toEqual(noiseMetrics(s, base));
    expect(noiseMetrics(s, base).bandResults![0]).not.toHaveProperty('inputNoisePowerFraction');
    for (const bad of [1, 'true', null]) expect(() => noiseMetricsArgs({ netlist: 'x', bandsHz: [[10, 20]], includeInputNoiseBandFractions: bad })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => noiseMetricsArgs({ netlist: 'x', includeInputNoiseBandFractions: true })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    for (const bandsHz of [[[10, 30]], [[90, 110]]] as [number, number][][]) expect(() => noiseMetrics(s, selected({ bandHz: [20, 100], bandsHz, includeInputNoiseBandFractions: true }))).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
