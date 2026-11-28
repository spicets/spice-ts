import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it } from 'vitest';
import { impedanceArgs, impedanceReport } from './impedance.js';
import { executeTool, MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
const validate = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const request = { apiVersion: '1', input: { format: 'spice', source: '* two series RLC branches in parallel\nR1 in a 1\nL1 a b 1m\nC1 b 0 1u\nR2 in c 2\nL2 c d 10m\nC2 d 0 1u\nRleak1 b 0 1g\nRleak2 d 0 1g\n.ac dec 100 100 10000\n.end' } };
const trace = (frequencyHz: number[], x: number[], levels: number[], occurrence?: number, direction?: 'rising' | 'falling' | 'either', variation: 'lin' | 'dec' | 'oct' = 'lin') => {
  const spectrum = { frequencyHz, positive: x.map(v => ({ magnitude: Math.abs(v), phaseDegrees: v < 0 ? -90 : 90 })), negative: x.map(() => ({ magnitude: 0, phaseDegrees: 0 })) };
  return impedanceReport(spectrum, impedanceArgs({ port, sweep: { variation, points: frequencyHz.length, startFreq: Math.min(...frequencyHz), stopFreq: Math.max(...frequencyHz) }, reactanceLevelsOhm: levels, ...(occurrence === undefined ? {} : { reactanceCrossingOccurrence: occurrence }), ...(direction === undefined ? {} : { reactanceCrossingDirection: direction }) }));
};

describe('reactance crossing occurrence', () => {
  const f = [10, 20, 30, 40];
  const x = [-2, 2, -2, 2];
  it('selects all three analytic crossings and returns null when absent', () => {
    expect([1, 2, 3, 4].map(n => trace(f, x, [0], n).reactanceCrossings![0].frequencyHz)).toEqual([15, 25, 35, null]);
  });
  it('filters direction before counting each target independently', () => {
    expect(trace(f, x, [0, 1, 0, 3], 2, 'rising').reactanceCrossings).toEqual([{ reactanceOhm: 0, frequencyHz: 35 }, { reactanceOhm: 1, frequencyHz: 37.5 }, { reactanceOhm: 0, frequencyHz: 35 }, { reactanceOhm: 3, frequencyHz: null }]);
    expect([1, 2].map(n => trace(f, x, [0], n, 'falling').reactanceCrossings![0].frequencyHz)).toEqual([25, null]);
    expect(trace(f, x, [0], 3, 'either').reactanceCrossings![0].frequencyHz).toBe(35);
    expect(JSON.stringify(trace(f, x, [0, 1]))).toBe(JSON.stringify(trace(f, x, [0, 1], 1)));
  });
  it('counts shared exact endpoints and plateau runs once while preserving directional endpoints', () => {
    const frequencies = [1, 2, 3, 4, 5, 6, 7, 8];
    const values = [-1, 0, 0, -1, 0, 1, 0, -1];
    const get = (n: number, d?: 'rising' | 'falling') => trace(frequencies, values, [0], n, d).reactanceCrossings![0].frequencyHz;
    expect([1, 2, 3, 4].map(n => get(n))).toEqual([2, 5, 7, null]);
    expect([1, 2, 3].map(n => get(n, 'rising'))).toEqual([2, 5, null]);
    expect([1, 2, 3].map(n => get(n, 'falling'))).toEqual([3, 7, null]);
    expect(trace([1, 2, 3], [0, 0, 0], [0], 2).reactanceCrossings![0].frequencyHz).toBeNull();
    expect(trace([1, 2, 3], [0, 0, 0], [0], 1, 'rising').reactanceCrossings![0].frequencyHz).toBeNull();
    expect(trace([1, 2, 3], [-1, 0, 1], [0], 2, 'rising').reactanceCrossings![0].frequencyHz).toBeNull();
  });
  it.each(['lin', 'dec', 'oct'] as const)('uses %s interpolation for later crossings and finite extremes', variation => {
    const actual = trace([1, 4, 16, 64], x, [0], 3, 'either', variation).reactanceCrossings![0].frequencyHz!;
    const expected = variation === 'lin' ? 40 : 32;
    expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-12);
    const extreme = trace([1e-300, 1e300, 1e-300], [-1e308, 1e308, -1e308], [0], 2, 'either', variation).reactanceCrossings![0].frequencyHz!;
    expect(Math.abs(extreme / (variation === 'lin' ? 5e299 : 1) - 1)).toBeLessThan(1e-12);
  });
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 1001, null, '2'])('rejects invalid occurrence %s with structured output', async occurrence => {
    const args = { request, port, reactanceLevelsOhm: [0], reactanceCrossingOccurrence: occurrence };
    expect(validate(tool.inputSchema, args)).toBe(false);
    const response = await executeTool('spice_impedance', args);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } } });
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
  });
  it('requires targets and accepts occurrence 1000', async () => {
    expect(impedanceArgs({ port, reactanceLevelsOhm: [0], reactanceCrossingOccurrence: 1000 }).reactanceCrossingOccurrence).toBe(1000);
    const response = await executeTool('spice_impedance', { request, port, reactanceCrossingOccurrence: 1 });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } } });
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
  });
  it('selects the independently bracketed second reactance crossing of a passive multi-resonance RLC network', async () => {
    const args = { request, port, reactanceLevelsOhm: [0], reactanceCrossingOccurrence: 2 };
    expect(validate(tool.inputSchema, args)).toBe(true);
    const response = await executeTool('spice_impedance', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    const report = response.structuredContent as { points: { frequencyHz: number; reactanceOhm: number }[]; reactanceCrossings: { frequencyHz: number }[] };
    const brackets = report.points.slice(1).map((b, i) => ({ a: report.points[i], b })).filter(({ a, b }) => a.reactanceOhm * b.reactanceOhm < 0);
    expect(brackets.length).toBeGreaterThanOrEqual(3);
    const { a, b } = brackets[1];
    const t = -a.reactanceOhm / (b.reactanceOhm - a.reactanceOhm);
    const expected = Math.exp((1 - t) * Math.log(a.frequencyHz) + t * Math.log(b.frequencyHz));
    const actual = report.reactanceCrossings[0].frequencyHz;
    const residual = a.reactanceOhm + (Math.log(actual / a.frequencyHz) / Math.log(b.frequencyHz / a.frequencyHz)) * (b.reactanceOhm - a.reactanceOhm);
    console.log('RLC crossing evidence', JSON.stringify({ bracket: [a, b], expected, actual, frequencyErrorHz: actual - expected, interpolatedReactanceResidualOhm: residual }));
    expect(actual).toBeGreaterThan(a.frequencyHz);
    expect(actual).toBeLessThan(b.frequencyHz);
    expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-12);
    expect(Math.abs(residual)).toBeLessThan(1e-9);
  });
});
