import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { noiseMetrics, noiseMetricsArgs, noiseMetricsOutputSchema } from './noise-metrics.js';

describe('noise signal-to-noise ratio', () => {
  it('accepts a signal and reports 20 dB for ten times the input noise', () => {
    const args = noiseMetricsArgs({ netlist: 'test', signalRms: 20 });
    const spectrum = new NoiseResult([1, 5], 'out', 'V1', [3, 3], [1, 1], undefined, undefined);
    expect(noiseMetrics(spectrum, args)).toMatchObject({ inputUnit: 'V', integratedInputNoiseRms: 2, signalToNoiseRatioDb: 20 });
  });
  it('uses clipped input noise and current-source units', () => {
    const spectrum = new NoiseResult([1, 5], 'out', 'I1', [10, 10], [2, 2], undefined, undefined);
    const m = noiseMetrics(spectrum, { bandHz: [2, 3], signalRms: 20 });
    expect(m).toMatchObject({ inputUnit: 'A', integratedInputNoiseRms: 2, integratedOutputNoiseVrms: 10, signalToNoiseRatioDb: 20 });
  });
  it('omits both SNR fields when no signal is supplied', () => {
    const spectrum = new NoiseResult([1, 5], 'out', 'V1', [1, 1], [1, 1], undefined, undefined);
    const result = noiseMetrics(spectrum, {});
    expect(Object.keys(result).sort()).toEqual(['bandHz', 'inputUnit', 'integratedInputNoiseRms', 'integratedOutputNoiseVrms', 'method', 'spots'].sort());
    expect(new AjvJsonSchemaValidator().getValidator(noiseMetricsOutputSchema)(result).valid).toBe(true);
  });
  it('explains zero input noise without emitting infinity', () => {
    const spectrum = new NoiseResult([1, 5], 'out', 'V1', [1, 1], [0, 0], undefined, undefined);
    const result = noiseMetrics(spectrum, { signalRms: 1 });
    expect(result).toMatchObject({ signalToNoiseRatioDb: null, signalToNoiseRatioReason: 'zero integrated input noise' });
    expect(new AjvJsonSchemaValidator().getValidator(noiseMetricsOutputSchema)(result).valid).toBe(true);
  });
  it.each([Number.MAX_VALUE, Number.MIN_VALUE])('avoids ratio overflow and underflow for signal %s', signalRms => {
    const density = signalRms === Number.MAX_VALUE ? 0.5 : 2;
    const spectrum = new NoiseResult([1, 2], 'out', 'V1', [1, 1], [density, density], undefined, undefined);
    expect(noiseMetrics(spectrum, { signalRms })).toMatchObject({ signalToNoiseRatioDb: expect.closeTo(20 * (Math.log10(signalRms) - Math.log10(density)), 10) });
  });
});
