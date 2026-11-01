import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool, MCP_TOOLS } from './server.js';
import { tranMetrics, type TranMetrics } from './tran-metrics.js';

const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
const ramp = (start: number, end: number) => request(`V1 out 0 PWL(0 ${start} 1 ${end} 2 ${end})\nR1 out 0 1k\n.tran 0.01 2\n.end`);
async function run(source: ReturnType<typeof request>, signal: string, riseTimePercent?: [number, number]) {
  const response = await executeTool('spice_tran_metrics', { request: source, signal, ...(riseTimePercent ? { riseTimePercent } : {}) });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as unknown as TranMetrics;
}

describe('configurable transient thresholds', () => {
  it('reports 20–80% rise time through the public tool while preserving defaults', async () => {
    const standard = await run(ramp(0, 1), 'v(out)');
    const custom = await run(ramp(0, 1), 'v(out)', [20, 80]);
    expect(standard.riseTimeS).toBeCloseTo(0.8, 12);
    expect(custom.riseTimeS).toBeCloseTo(0.6, 12);
    expect(custom).toEqual({ ...standard, riseTimeS: custom.riseTimeS });
    expect(standard.fallTimeS).toBeNull();
  });

  it('normalizes falling and scaled offset rising transitions', async () => {
    const falling = await run(ramp(1, 0), 'v(out)', [20, 80]);
    const scaled = await run(ramp(-3, 7), 'v(out)', [20, 80]);
    expect(falling.fallTimeS).toBeCloseTo(0.6, 12);
    expect(falling.riseTimeS).toBeNull();
    expect(scaled.riseTimeS).toBeCloseTo(0.6, 12);
  });

  it('measures differential voltage with configured thresholds', async () => {
    const source = request('V1 out 0 PWL(0 2 1 6 2 6)\nV2 ref 0 2\nR1 out 0 1k\nR2 ref 0 1k\n.tran 0.01 2\n.end');
    const result = await run(source, 'v(out,ref)', [20, 80]);
    expect(result.riseTimeS).toBeCloseTo(0.6, 12);
    expect(result.initialValue).toBeCloseTo(0, 12);
    expect(result.finalValue).toBeCloseTo(4, 12);
  });

  it.each([[80, 20], [20, 20], [], [20], [20, 80, 90], [0, 80], [20, 100], [-1, 80], [20, Infinity], [NaN, 80], ['20', 80], [undefined, 80], Array(2), null, '20,80'])('rejects invalid thresholds %j', async riseTimePercent => {
    const response = await executeTool('spice_tran_metrics', { request: ramp(0, 1), signal: 'v(out)', riseTimePercent });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('advertises the threshold pair in the public input schema', () => {
    const schema = MCP_TOOLS.find(tool => tool.name === 'spice_tran_metrics')!.inputSchema;
    expect(schema.properties).toMatchObject({ riseTimePercent: { type: 'array', minItems: 2, maxItems: 2, default: [10, 90] } });
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    expect(validate({ request: ramp(0, 1), signal: 'v(out)', riseTimePercent: [20, 80] }).valid).toBe(true);
    expect(validate({ request: ramp(0, 1), signal: 'v(out)', riseTimePercent: [0, 80] }).valid).toBe(false);
  });

  it('preserves NO_TRANSITION when configured crossings are missing', () => {
    const samples: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 1, 2], voltagesV: { out: [0, 0.3, 0.3] }, currentsA: {} }] };
    expect(tranMetrics(samples, { signal: 'v(out)', initialValue: 0, finalValue: 1, riseTimePercent: [20, 80] })).toMatchObject({ error: { code: 'NO_TRANSITION' } });
  });
});
