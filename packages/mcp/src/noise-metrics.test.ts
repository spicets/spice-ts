import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { NoiseResult } from '@spice-ts/core';
import { noiseMetrics } from './noise-metrics.js';

const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
// Original MIT-licensed analytic probe, no external fixture.
const rc = 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n.temp 27\n.noise V(out) V1 dec 100 1 1e10\n.end';
const validator = new AjvJsonSchemaValidator();
async function run(extra = {}) {
  const response = await executeTool('spice_noise_metrics', { request: request(rc), ...extra });
  expect(response.isError).not.toBe(true);
  expect(validator.getValidator(MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as {
    integratedOutputNoiseVrms: number; integratedInputNoiseRms: number;
    spots: { frequencyHz: number; outputNoiseVPerSqrtHz: number | null; inputNoisePerSqrtHz: number | null; outOfRange: boolean }[];
    method: string; inputUnit: string;
  };
}

describe('spice_noise_metrics', () => {
  it('integrates PSD rather than amplitude and clips edges before trapezoids', () => {
    const spectrum = new NoiseResult([1, 3], 'out', 'I1', [1, 3], [2, 6], undefined, undefined);
    const m = noiseMetrics(spectrum, { bandHz: [1.5, 2.5], spotFrequenciesHz: [1, Math.sqrt(3), 3] });
    expect(m.integratedOutputNoiseVrms).toBeCloseTo(Math.sqrt(5), 12);
    expect(m.integratedInputNoiseRms).toBeCloseTo(2 * Math.sqrt(5), 12);
    expect(m.inputUnit).toBe('A');
    expect(m.spots.map(s => s.outputNoiseVPerSqrtHz)).toEqual([1, 2, 3]);
  });

  it('supports zero densities and rejects malformed spectra', () => {
    const spectrum = new NoiseResult([1, 3], 'out', 'V1', [0, 0], [0, 0], undefined, undefined);
    expect(noiseMetrics(spectrum, { spotFrequenciesHz: [2] }).spots[0].outputNoiseVPerSqrtHz).toBe(0);
    expect(() => noiseMetrics({ ...spectrum, frequencies: [1, 1] }, {})).toThrow();
    expect(() => noiseMetrics({ ...spectrum, inputNoiseDensity: [NaN, 0] }, {})).toThrow();
  });

  it('matches sqrt(kT/C) within 2% and sqrt(4kTR) at 10 Hz within 1%', async () => {
    const m = await run({ spotFrequenciesHz: [10, Math.sqrt(10 * 10 ** 1.01), 0.1, 1e11] });
    expect(Math.abs(m.integratedOutputNoiseVrms / Math.sqrt(1.380649e-23 * 300.15 / 1e-9) - 1)).toBeLessThan(0.02);
    expect(Math.abs(m.spots[0].outputNoiseVPerSqrtHz! / Math.sqrt(4 * 1.380649e-23 * 300.15 * 1000) - 1)).toBeLessThan(0.01);
    expect(Math.abs(m.integratedInputNoiseRms / Math.sqrt(4 * 1.380649e-23 * 300.15 * 1000 * (1e10 - 1)) - 1)).toBeLessThan(0.01);
    expect(m.spots[2]).toMatchObject({ outOfRange: true, outputNoiseVPerSqrtHz: null, inputNoisePerSqrtHz: null });
    expect(m.spots[3].outOfRange).toBe(true);
    expect(m.method).toContain('trapezoidal');
    expect(m.inputUnit).toBe('V');
  });

  it('integrates clipped bands in linear frequency without extrapolating', async () => {
    const m = await run({ bandHz: [15, 12345] });
    const expected = Math.sqrt(4 * 1.380649e-23 * 300.15 * 1000 * (12345 - 15));
    expect(Math.abs(m.integratedInputNoiseRms / expected - 1)).toBeLessThan(0.001);
  });

  it.each([
    { request: request('V1 out 0 1\nR1 out 0 1k\n.op') },
    { bandHz: [0.1, 100] }, { bandHz: [1, 1e11] }, { bandHz: [100, 10] },
    { bandHz: [1, Infinity] }, { spotFrequenciesHz: [0] }, { unknown: true },

    { request: request(rc.replace('.end', '.noise V(out) V1 dec 10 1 100\n.end')) },
  ])('returns structured errors for missing noise and invalid bands/selectors', async extra => {
    const response = await executeTool('spice_noise_metrics', { request: request(rc), ...extra });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('preserves point limits and advertises capabilities', async () => {
    expect(await executeTool('spice_noise_metrics', { request: request('.param x=1\n' + rc.replace('.end', '.step param x LIST 1 2\n.end')) })).toMatchObject({ isError: true, structuredContent: { error: { code: 'PARSE_ERROR' } } });
    expect(await executeTool('spice_noise_metrics', { request: { ...request(rc), options: { limits: { maxResultPoints: 0 } } } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_noise_metrics']) });
  });
});
