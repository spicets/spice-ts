import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\n.noise V(out) V1 dec 10 1 1e4\n.end';
const spectrum = (f: number[], out: number[]) => new NoiseResult(f, 'out', 'V1', out, out.map(() => 1), undefined, undefined);
const validator = new AjvJsonSchemaValidator();
const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
const entries = (f: number[], out: number[], percentages: number[], bandHz?: [number, number]) =>
  noiseMetrics(spectrum(f, out), { outputNoisePercentiles: percentages, bandHz }).outputNoisePercentileFrequencies!;

describe('output noise percentiles', () => {
  it('locates white noise cumulative power in linear frequency', () => {
    const args = noiseMetricsArgs({ netlist: 'test', outputNoisePercentiles: [25, 50, 75] });
    expect(noiseMetrics(spectrum([1, 101], [2, 2]), args)).toMatchObject({ outputNoisePercentileFrequencies: [
      { percent: 25, frequencyHz: 26 }, { percent: 50, frequencyHz: 51 }, { percent: 75, frequencyHz: 76 },
    ] });
  });
  it('inverts linearly rising PSD rather than density', () => {
    expect(entries([1, 101], [0, 2], [50])[0].frequencyHz).toBeCloseTo(1 + 100 / Math.sqrt(2), 8);
    expect(entries([1, 101], [0, 2], [50], [26, 76])[0].frequencyHz).toBeCloseTo(1 + 100 * Math.sqrt((0.25 ** 2 + 0.75 ** 2) / 2), 8);
  });
  it('clips nonuniform grids and retains order and duplicates', () => {
    const result = entries([1, 3, 10, 101], [2, 2, 2, 2], [75, 25, 75, 50], [2, 82]);
    expect(result.map(x => x.percent)).toEqual([75, 25, 75, 50]);
    result.forEach((x, i) => expect(x.frequencyHz).toBeCloseTo([62, 22, 62, 42][i], 9));
  });
  it('handles zero power plateaus and defines the first crossing', () => {
    const result = entries([1, 2, 3, 4, 5, 6], [1, 0, 0, 0, 0, 1], [50]);
    expect(result[0].frequencyHz).toBeCloseTo(2, 7);
    expect(entries([1, 2], [0, 0], [25, 75])).toEqual([
      { percent: 25, frequencyHz: null, reason: 'zero integrated output noise' },
      { percent: 75, frequencyHz: null, reason: 'zero integrated output noise' },
    ]);
  });
  it.each([1e-200, 1e150])('handles density scale %s', density => {
    expect(entries([1, 101], [density, density], [50])[0].frequencyHz).toBeCloseTo(51, 9);
  });
  it('keeps finite frequencies at extreme density and subnormal frequency widths', () => {
    const f = [Number.MIN_VALUE, 101 * Number.MIN_VALUE];
    expect(entries(f, [1e300, 1e300], [50])[0].frequencyHz).toBe(51 * Number.MIN_VALUE);
  });
  it('inverts very small clipped PSD relative to the far endpoint', () => {
    const x = entries([1, 1e200], [0, 1e100], [50], [1, 2])[0].frequencyHz!;
    expect(x).toBeCloseTo(1 + Math.SQRT1_2, 12);
  });
  it('supports extreme finite percent values without extrapolation', () => {
    const xs = entries([1, 101], [1, 1], [Number.MIN_VALUE, 99.99999999999999]);
    for (const x of xs) expect(x.frequencyHz).toBeGreaterThanOrEqual(1);
    for (const x of xs) expect(x.frequencyHz).toBeLessThanOrEqual(101);
  });
  it('keeps omitted output and SNR unchanged', () => {
    const s = spectrum([1, 101], [1, 1]);
    const baseline = noiseMetrics(s, { signalRms: 2, outputSignalRms: 3 });
    expect(baseline).not.toHaveProperty('outputNoisePercentileFrequencies');
    const withOption = noiseMetrics(s, { signalRms: 2, outputSignalRms: 3, outputNoisePercentiles: [50] });
    const { outputNoisePercentileFrequencies: _, ...rest } = withOption;
    expect(rest).toEqual(baseline);
  });
  it.each([[], Array(33).fill(50), [0], [100], [-1], [NaN], [Infinity], ['50'], null, undefined, 50])('rejects invalid selector %s', async value => {
    const args = { netlist, outputNoisePercentiles: value };
    expect(await executeTool('spice_noise_metrics', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    if (value !== undefined) expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(false);
  });
  it('validates discovery schemas and public resistor noise results', async () => {
    const args = { netlist, bandHz: [15, 1234], outputNoisePercentiles: [75, 25, 50, 25] };
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    expect(validator.getValidator(tool.inputSchema)({ ...args, extra: true }).valid).toBe(false);
    expect(await executeTool('spice_noise_metrics', { ...args, extra: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    const response = await executeTool('spice_noise_metrics', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const result = response.structuredContent as unknown as { outputNoisePercentileFrequencies: { percent: number; frequencyHz: number }[] };
    for (const x of result.outputNoisePercentileFrequencies) expect(x.frequencyHz).toBeCloseTo(15 + (1234 - 15) * x.percent / 100, 7);
    const first = result.outputNoisePercentileFrequencies[0];
    expect(validator.getValidator(tool.outputSchema!)({ ...response.structuredContent, outputNoisePercentileFrequencies: [{ ...first, extra: true }] }).valid).toBe(false);
    const omitted = await executeTool('spice_noise_metrics', { netlist, bandHz: [15, 1234] });
    const { outputNoisePercentileFrequencies: _ignored, ...rest } = response.structuredContent!;
    expect(rest).toEqual(omitted.structuredContent);
  });
});
