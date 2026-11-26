import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { tranMetrics, type TranMetrics } from './tran-metrics.js';

const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end' } };
const make = (timeS: number[], values: number[]): SimulationResultV1 => ({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS, voltagesV: { out: values, reference: values.map(() => 5) }, currentsA: { V1: values } }] });
const options = { signal: 'v(out)', settlingBandPercent: 20, includeSignalStatistics: true, includeStandardDeviation: true } as const;
const call = (extra: Record<string, unknown>, data = make([0, 0.3, 1.2, 2], [0, 0.3, 1.2, 2])) => executeTool('spice_tran_metrics', { request, ...options, ...extra }, { simulate: async () => data });
const deviation = (result: ReturnType<typeof tranMetrics>) => (result as TranMetrics).signalStatistics!.standardDeviation!;
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, Math.abs(expected) * 1e-10));

describe('transient population standard deviation', () => {
  it('integrates a nonuniformly sampled ramp and clipped edges', () => {
    const data = make([0, 0.3, 1.2, 2], [0, 0.3, 1.2, 2]);
    close(deviation(tranMetrics(data, options)), 2 / Math.sqrt(12));
    close(deviation(tranMetrics(data, { ...options, timeRangeS: [0.5, 1.5] })), 1 / Math.sqrt(12));
  });

  it('integrates a nonuniform ramp followed by a constant hold', () => {
    // A uniform ramp 0->2 for one second and a hold at 2 for two seconds:
    // mean = 5/3, E[x²] = 28/9, variance = 1/3.
    const data = make([0, 0.25, 1, 3], [0, 0.5, 2, 2]);
    close(deviation(tranMetrics(data, options)), Math.sqrt(1 / 3));
  });

  it.each([1e-200, 1, 1e200, -1e200])('handles ramp scale %s', amplitude => {
    const data = make([0, 0.3, 1.2, 2], [0, 0.15, 0.6, 1].map(v => v * amplitude));
    const actual = deviation(tranMetrics(data, options));
    expect(actual / Math.abs(amplitude)).toBeCloseTo(1 / Math.sqrt(12), 12);
  });

  it('preserves representable ripple under a large translation', () => {
    const time = [0, 1, 2, 4]; const values = [0, 128, 256, 256];
    const plain = deviation(tranMetrics(make(time, values), options));
    const shifted = deviation(tranMetrics(make(time, values.map(v => v + 1e16)), options));
    close(shifted, plain);
  });

  it('supports voltage, differential voltage and current selectors', async () => {
    const data = make([0, 0.3, 1.2, 2], [5, 5.3, 6.2, 7]);
    for (const [signal, unit] of [['v(out)', 'V'], ['v(out,reference)', 'V'], ['i(V1)', 'A']] as const) {
      const response = await call({ signal }, data);
      expect(response.isError).not.toBe(true);
      const stats = (response.structuredContent as unknown as TranMetrics).signalStatistics!;
      close(stats.standardDeviation!, 2 / Math.sqrt(12)); expect(stats.unit).toBe(unit);
    }
  });

  it('keeps zero/constant and unsettled error semantics and rejects malformed samples', async () => {
    for (const value of [0, 7]) {
      const data = make([0, 1, 2], [value, value, value]);
      expect((await call({}, data)).structuredContent).toMatchObject({ error: { code: 'NO_TRANSITION' } });
    }
    const unsettled = make([0, 1, 2], [0, 0, 1]);
    expect((await call({ settlingBandPercent: 2 }, unsettled)).structuredContent).toMatchObject({ error: { code: 'NOT_SETTLED' } });
    for (const values of [[0, NaN, 1], [0, Infinity, 1], [0, 1]]) {
      expect((await call({}, make([0, 1, 2], values))).structuredContent).toMatchObject({ error: { code: 'INVALID_DATA' } });
    }
    expect((await call({}, make([0, 1, 2], [-1e308, 0, 1e308]))).structuredContent).toMatchObject({ error: { code: 'INVALID_DATA' } });
  });

  it('validates options and output schema and omits the field by default', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_tran_metrics')!;
    const validator = new AjvJsonSchemaValidator(); const input = validator.getValidator(tool.inputSchema); const output = validator.getValidator(tool.outputSchema!);
    expect(input({ request, ...options }).valid).toBe(true);
    expect(input({ request, ...options, includeStandardDeviation: 'true' }).valid).toBe(false);
    for (const extra of [{ includeStandardDeviation: 'true' }, { includeStandardDeviation: null }, { includeStandardDeviation: true, includeSignalStatistics: false }, { includeStandardDeviation: true, includeSignalStatistics: undefined }]) {
      expect(await call(extra)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const enabled = await call({}); expect(output(enabled.structuredContent).valid).toBe(true);
    const invalid = structuredClone(enabled.structuredContent) as { signalStatistics: Record<string, unknown> };
    invalid.signalStatistics.standardDeviation = -1; expect(output(invalid).valid).toBe(false);
    invalid.signalStatistics.standardDeviation = '1'; expect(output(invalid).valid).toBe(false);
    const omitted = await call({ includeStandardDeviation: undefined }); const disabled = await call({ includeStandardDeviation: false });
    expect(omitted).toEqual(disabled); expect(omitted.structuredContent).not.toHaveProperty('signalStatistics.standardDeviation');
  });

  it('runs a real ramp and hold through the public executor', async () => {
    const real = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 PWL(0 0 1m 1 2m 1)\nR1 out 0 1k\n.tran 10u 2m\n.end' } };
    const response = await executeTool('spice_tran_metrics', { request: real, signal: 'v(out)', includeSignalStatistics: true, includeStandardDeviation: true });
    expect(response.isError).not.toBe(true);
    expect((response.structuredContent as unknown as TranMetrics).signalStatistics!.standardDeviation).toBeCloseTo(Math.sqrt(5 / 48), 3);
  });
});