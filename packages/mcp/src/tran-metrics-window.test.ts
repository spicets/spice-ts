import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end' } };
const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 1, 2, 3, 4, 5, 6, 7, 8], voltagesV: { out: [0, 4, 0, 0, 0, 2, 3, 2, 2] }, currentsA: {} }] };

describe('transient metric windows', () => {
  it('clips and interpolates a selected transition with absolute times', async () => {
    const response = await executeTool('spice_tran_metrics', { request, signal: 'v(out)', timeRangeS: [3.5, 7.5] }, { simulate: async () => result });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ initialValue: 0, finalValue: 2, peakValue: 3, peakTimeS: 6 });
    const metrics = response.structuredContent as Record<string, number>;
    expect(metrics.riseTimeS).toBeCloseTo(0.8, 12);
    expect(metrics.settlingTimeS).toBeCloseTo(6.96, 12);
  });

  it('interpolates both off-grid endpoints, including a window inside one segment', async () => {
    const response = await executeTool('spice_tran_metrics', { request, signal: 'v(out)', timeRangeS: [4.25, 4.75], settlingBandPercent: 30 }, { simulate: async () => result });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ initialValue: 0.5, finalValue: 1.5, peakValue: 1.5, peakTimeS: 4.75 });
    expect((response.structuredContent as Record<string, number>).riseTimeS).toBeCloseTo(0.4, 12);
  });

  it.each([[1, 1], [2, 1], [-1, 2], [1, 9], [NaN, 2], [0, Infinity], [], [1], [1, 2, 3], ['1', 2], [undefined, 2], Array(2), null].map(value => [value]))('rejects invalid window %j', async timeRangeS => {
    const response = await executeTool('spice_tran_metrics', { request, signal: 'v(out)', timeRangeS }, { simulate: async () => result });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('advertises the optional bounds in the public schema', () => {
    const schema = MCP_TOOLS.find(tool => tool.name === 'spice_tran_metrics')!.inputSchema;
    expect(schema.properties).toMatchObject({ timeRangeS: { type: 'array', minItems: 2, maxItems: 2 } });
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    expect(validate({ request, signal: 'v(out)', timeRangeS: [3.5, 7.5] }).valid).toBe(true);
    expect(validate({ request, signal: 'v(out)', timeRangeS: [3.5] }).valid).toBe(false);
  });

  it('applies analysis, step, differential and current selection with custom levels and thresholds', async () => {
    const base = result.analyses[0];
    if (base.type !== 'tran') throw new Error('expected transient');
    const samples = [0, 4, 0, 0, 0, 2, 3, 2, 2];
    const stepped: SimulationResultV1 = { status: 'complete', analyses: [
      { ...base, analysisIndex: 2, step: { index: 0, parameter: 'R', value: 1 } },
      { ...base, analysisIndex: 2, step: { index: 1, parameter: 'R', value: 2 }, voltagesV: { a: samples.map(v => v + 5), b: samples.map(() => 5) }, currentsA: { V1: samples } },
    ] };
    const original = structuredClone(stepped);
    for (const signal of ['v(a,b)', 'i(V1)']) {
      const response = await executeTool('spice_tran_metrics', { request, signal, analysis: 2, step: 1, timeRangeS: [3.5, 7.5], initialValue: 0, finalValue: 2, riseTimePercent: [20, 80] }, { simulate: async () => stepped });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ initialValue: 0, finalValue: 2, peakValue: 3, peakTimeS: 6, unit: signal.startsWith('i') ? 'A' : 'V' });
      expect((response.structuredContent as Record<string, number>).riseTimeS).toBeCloseTo(0.6, 12);
    }
    expect(stepped).toEqual(original);
  });

  it('measures the second pulse of a real RC transient', async () => {
    const pulse = { apiVersion: '1', input: { format: 'spice', source: 'V1 drive 0 PULSE(0 1 1m 10u 10u 3m 10m)\nV2 in drive PULSE(0 1 1m 10u 10u 3m 100m)\nR1 in out 1k\nC1 out 0 100n\n.tran 10u 13.5m\n.end' } };
    const full = await executeTool('spice_tran_metrics', { request: pulse, signal: 'v(out)' });
    const response = await executeTool('spice_tran_metrics', { request: pulse, signal: 'v(out)', timeRangeS: [0.0105, 0.0135] });
    expect(full.isError).not.toBe(true);
    expect(response.isError).not.toBe(true);
    const metrics = response.structuredContent as Record<string, number>;
    expect(metrics.initialValue).toBeLessThan(0.01);
    expect(metrics.finalValue).toBeGreaterThan(0.99);
    expect(metrics.riseTimeS).toBeGreaterThan(0.0001);
    expect(metrics.peakTimeS).toBeGreaterThan(0.011);
    expect((full.structuredContent as Record<string, number>).peakValue).toBeGreaterThan(metrics.peakValue * 1.9);
    expect((full.structuredContent as Record<string, number>).peakTimeS).toBeLessThan(0.005);
    expect(metrics.settlingTimeS).toBeGreaterThan(0.011);
    expect(metrics.settlingTimeS).toBeLessThan(0.0135);
  });
});
