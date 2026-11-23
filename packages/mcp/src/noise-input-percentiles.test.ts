import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\n.noise V(out) V1 dec 10 1 1e4\n.end';
const spectrum = (f: number[], input: number[], output = input.map(() => 1)) => new NoiseResult(f, 'out', 'V1', output, input, undefined, undefined);
const entries = (f: number[], input: number[], percentages: number[], bandHz?: [number, number]) =>
  noiseMetrics(spectrum(f, input), { inputNoisePercentiles: percentages, bandHz }).inputNoisePercentileFrequencies!;
const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
const validator = new AjvJsonSchemaValidator();

describe('input noise percentiles', () => {
  it('locates white input noise power instead of output noise power', () => {
    const s = spectrum([1, 101], [2, 2], [0, 2]);
    const args = noiseMetricsArgs({ netlist: 'test', inputNoisePercentiles: [25, 50, 75], outputNoisePercentiles: [50] });
    const result = noiseMetrics(s, args);
    expect(result.inputNoisePercentileFrequencies).toEqual([
      { percent: 25, frequencyHz: 26 }, { percent: 50, frequencyHz: 51 }, { percent: 75, frequencyHz: 76 },
    ]);
    expect(result.outputNoisePercentileFrequencies![0].frequencyHz).toBeCloseTo(1 + 100 / Math.sqrt(2), 8);
  });
  it('inverts rising PSD, including clipped boundaries', () => {
    expect(entries([1, 101], [0, 2], [50])[0].frequencyHz).toBeCloseTo(1 + 100 / Math.sqrt(2), 8);
    expect(entries([1, 101], [0, 2], [50], [26, 76])[0].frequencyHz).toBeCloseTo(1 + 100 * Math.sqrt((0.25 ** 2 + 0.75 ** 2) / 2), 8);
  });
  it('clips a nonuniform grid and preserves order and duplicates', () => {
    const result = entries([1, 3, 10, 101], [2, 2, 2, 2], [75, 25, 75, 50], [2, 82]);
    expect(result.map(x => x.percent)).toEqual([75, 25, 75, 50]);
    result.forEach((x, i) => expect(x.frequencyHz).toBeCloseTo([62, 22, 62, 42][i], 9));
  });
  it('uses the first crossing at a zero plateau and explains zero input power', () => {
    expect(entries([1, 2, 3, 4, 5, 6], [1, 0, 0, 0, 0, 1], [50])[0].frequencyHz).toBeCloseTo(2, 7);
    expect(entries([1, 2], [0, 0], [25, 75])).toEqual([
      { percent: 25, frequencyHz: null, reason: 'zero integrated input noise' },
      { percent: 75, frequencyHz: null, reason: 'zero integrated input noise' },
    ]);
  });
  it.each([1e-200, 1e150])('handles finite density scale %s', density => {
    expect(entries([1, 101], [density, density], [50])[0].frequencyHz).toBeCloseTo(51, 9);
  });
  it('handles extreme widths and finite percentages without extrapolation', () => {
    expect(entries([Number.MIN_VALUE, 101 * Number.MIN_VALUE], [1e300, 1e300], [50])[0].frequencyHz).toBe(51 * Number.MIN_VALUE);
    const result = entries([1, 101], [1, 1], [Number.MIN_VALUE, 99.99999999999999]);
    for (const x of result) { expect(Number.isFinite(x.frequencyHz)).toBe(true); expect(x.frequencyHz).toBeGreaterThanOrEqual(1); expect(x.frequencyHz).toBeLessThanOrEqual(101); }
    expect(entries([1e-100, 1e308], [1, 1], [Number.MIN_VALUE])[0].frequencyHz! / 4.9406564584124655e-18).toBeCloseTo(1, 12);
  });
  it('locates a tiny percentile in a segment whose normalized power underflows', () => {
    const frequency = entries([1, 2 ** 332, 2 ** 1023], [2 ** -194, 2 ** -194, 1], [Number.MIN_VALUE])[0].frequencyHz!;
    expect(frequency).toBeLessThan(2 ** 332);
    expect(frequency / (2 ** 336 / 100)).toBeCloseTo(1, 11);
  });
  it('leaves existing output unchanged when the input option is omitted', () => {
    const s = spectrum([1, 101], [1, 1], [0, 2]);
    const baseline = noiseMetrics(s, { outputNoisePercentiles: [50], signalRms: 2 });
    expect(baseline).not.toHaveProperty('inputNoisePercentileFrequencies');
    const { inputNoisePercentileFrequencies: _, ...rest } = noiseMetrics(s, { outputNoisePercentiles: [50], signalRms: 2, inputNoisePercentiles: [50] });
    expect(rest).toEqual(baseline);
  });
  it.each([[], Array(33).fill(50), [0], [100], [-1], [NaN], [Infinity], ['50'], null, undefined, 50])('rejects invalid input selector %s', async value => {
    const args = { netlist, inputNoisePercentiles: value };
    expect(await executeTool('spice_noise_metrics', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    if (value !== undefined) expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(false);
  });
  it('validates discovery schemas and public resistor noise results', async () => {
    const args = { netlist, bandHz: [15, 1234], inputNoisePercentiles: [75, 25, 50, 25] };
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    expect(validator.getValidator(tool.inputSchema)({ ...args, extra: true }).valid).toBe(false);
    expect(await executeTool('spice_noise_metrics', { ...args, extra: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    const response = await executeTool('spice_noise_metrics', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const result = response.structuredContent as unknown as { inputNoisePercentileFrequencies: { percent: number; frequencyHz: number }[] };
    for (const x of result.inputNoisePercentileFrequencies) expect(x.frequencyHz).toBeCloseTo(15 + (1234 - 15) * x.percent / 100, 7);
    const first = result.inputNoisePercentileFrequencies[0];
    expect(validator.getValidator(tool.outputSchema!)({ ...response.structuredContent, inputNoisePercentileFrequencies: [{ ...first, extra: true }] }).valid).toBe(false);
    const omitted = await executeTool('spice_noise_metrics', { netlist, bandHz: [15, 1234] });
    const { inputNoisePercentileFrequencies: _ignored, ...rest } = response.structuredContent!;
    expect(rest).toEqual(omitted.structuredContent);
  });
});
