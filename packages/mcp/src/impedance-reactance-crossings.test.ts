import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { impedanceArgs, impedanceReport } from './impedance.js';
import { executeTool, MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const request = { apiVersion: '1', input: { format: 'spice', source: '* series RLC\nR1 in a 10\nL1 a b 10m\nC1 b 0 1u\nRleak b 0 1g\n.ac dec 10 100 10000\n.end' } };
const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
const validate = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const spectrum = (frequencyHz: number[], x: number[]) => ({ frequencyHz, positive: x.map(v => ({ magnitude: Math.abs(v), phaseDegrees: v < 0 ? -90 : 90 })), negative: x.map(() => ({ magnitude: 0, phaseDegrees: 0 })) });
const run = (frequencyHz: number[], x: number[], levels: number[], variation: 'lin' | 'dec' | 'oct' = 'lin') => impedanceReport(spectrum(frequencyHz, x), impedanceArgs({ port, sweep: { variation, points: 2, startFreq: 1, stopFreq: 100 }, reactanceLevelsOhm: levels }));

describe('sampled reactance crossings', () => {
  it('uses the first crossing in traversal order and preserves duplicate and missing levels', () => {
    const result = run([10, 20, 30, 40], [-2, 2, -2, 2], [0, 1, 0, 3]);
    expect(result.reactanceCrossings).toEqual([{ reactanceOhm: 0, frequencyHz: 15 }, { reactanceOhm: 1, frequencyHz: 17.5 }, { reactanceOhm: 0, frequencyHz: 15 }, { reactanceOhm: 3, frequencyHz: null }]);
  });

  it('handles first and later exact hits, plateaus and a one-point spectrum', () => {
    expect(run([10, 20, 30], [2, 2, -2], [2, -2]).reactanceCrossings).toEqual([{ reactanceOhm: 2, frequencyHz: 10 }, { reactanceOhm: -2, frequencyHz: 30 }]);
    expect(run([10], [2], [2, 0]).reactanceCrossings).toEqual([{ reactanceOhm: 2, frequencyHz: 10 }, { reactanceOhm: 0, frequencyHz: null }]);
  });

  it.each(['lin', 'dec', 'oct'] as const)('interpolates in the %s sweep coordinate', variation => {
    const result = run([10, 100], [-2, 2], [-1], variation);
    const expected = variation === 'lin' ? 32.5 : 10 * 10 ** 0.25;
    expect(Math.abs(result.reactanceCrossings![0].frequencyHz! / expected - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('interpolates finite extreme reactances and frequencies without overflow', () => {
    const linear = run([1e-300, 1e300], [-1e308, 1e308], [0], 'lin');
    expect(Math.abs(linear.reactanceCrossings![0].frequencyHz! / 5e299 - 1)).toBeLessThanOrEqual(1e-12);
    const logarithmic = run([1e-300, 1e300], [-1e308, 1e308], [0], 'dec');
    expect(Math.abs(logarithmic.reactanceCrossings![0].frequencyHz! - 1)).toBeLessThanOrEqual(1e-12);
  });

  it.each([null, [], [NaN], [Infinity], [-Infinity], ['1'], new Array(129).fill(0), '0'])('rejects malformed levels %s with structured errors', async levels => {
    const response = await executeTool('spice_impedance', { request, port, reactanceLevelsOhm: levels });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } });
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
  });

  it('roundtrips the public schema and matches independent interpolation of a series RLC sweep', async () => {
    const args = { request, port, reactanceLevelsOhm: [0] };
    expect(validate(tool.inputSchema, args)).toBe(true);
    expect(validate(tool.inputSchema, { ...args, reactanceLevelsOhm: [] })).toBe(false);
    const response = await executeTool('spice_impedance', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    const report = response.structuredContent as { points: { frequencyHz: number; reactanceOhm: number }[]; reactanceCrossings: { frequencyHz: number }[] };
    const index = report.points.findIndex((point, i) => i > 0 && point.reactanceOhm >= 0 && report.points[i - 1].reactanceOhm < 0);
    expect(index).toBeGreaterThan(0);
    const a = report.points[index - 1]; const b = report.points[index];
    const t = -a.reactanceOhm / (b.reactanceOhm - a.reactanceOhm);
    const expected = a.frequencyHz * (b.frequencyHz / a.frequencyHz) ** t;
    const relativeError = Math.abs(report.reactanceCrossings[0].frequencyHz / expected - 1);
    console.log('RLC sampled interpolation relative error:', relativeError);
    expect(relativeError).toBeLessThanOrEqual(1e-10);
  });

  it('does not change existing metrics when omitted or requested', async () => {
    const args = { request, port, includeQualityFactor: true, includeAdmittance: true, includeSeriesEquivalent: true, includeParallelEquivalent: true, referenceResistanceOhm: 50, includeMatchingMetrics: true, spotFrequenciesHz: [200] };
    const baseline = await executeTool('spice_impedance', args);
    const enabled = await executeTool('spice_impedance', { ...args, reactanceLevelsOhm: [0] });
    expect(baseline.isError).not.toBe(true);
    expect(enabled.isError).not.toBe(true);
    expect(baseline.structuredContent).not.toHaveProperty('reactanceCrossings');
    const { reactanceCrossings, ...rest } = enabled.structuredContent as Record<string, unknown>;
    expect(reactanceCrossings).toBeDefined();
    expect(rest).toEqual(baseline.structuredContent);
  });
});
