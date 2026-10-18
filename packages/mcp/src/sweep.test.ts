import { describe, expect, it } from 'vitest';
import { parseTitleless } from '@spice-ts/core';
import { createToolExecutor, executeTool, DEFAULT_MCP_LIMITS } from './server.js';

const source = '* Original MIT RC sweep fixture\n.param rval=1k\nV1 in 0 DC 0 AC 1\nR1 in out {rval}\nC1 out 0 1u\n.ac dec 200 1 100k\n.end';
const request = { apiVersion: '1', input: { format: 'spice', source } };
const measurements = [{ kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -10 * Math.log10(2), edge: 'falling' }];
const parameter = { kind: 'param', name: 'rval' };

describe('spice_sweep', () => {
  it('measures three RC cutoffs within 0.5% of analytic and preserves the request', async () => {
    const before = JSON.stringify(request);
    const response = await executeTool('spice_sweep', { request, parameter, values: [1000, 2000, 3000], measurements });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const data = response.structuredContent as { points: { value: number; status: string; measurements: { value: number; unit: string }[] }[] };
    expect(data.points).toHaveLength(3);
    for (const point of data.points) {
      expect(point.status).toBe('complete');
      expect(point.measurements[0].unit).toBe('Hz');
      const expected = 1 / (2 * Math.PI * point.value * 1e-6);
      expect(Math.abs(point.measurements[0].value / expected - 1)).toBeLessThan(0.005);

    }
    expect(JSON.stringify(request)).toBe(before);
  });

  it('caps explicit lists and generated ranges before solving', async () => {
    for (const sweep of [{ values: Array(101).fill(1) }, { range: { scale: 'lin', start: 1, stop: 2, points: 101 } }, { range: { scale: 'dec', start: 1, stop: 1e100, points: 100 } }]) {
      expect(await executeTool('spice_sweep', { request, parameter, ...sweep })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSweepPoints', maximum: 100 } } } });
    }
  });

  it('isolates a real parse failure between successful points', async () => {
    const conditional = source.replace('R1 in out {rval}', '.if rval < 0\n.invalid_sweep_point\n.else\nR1 in out {rval}\n.endif');
    const response = await executeTool('spice_sweep', { request: { ...request, input: { format: 'spice', source: conditional } }, parameter, values: [1000, -1, 3000], measurements });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ points: [{ status: 'complete' }, { status: 'failed', error: { code: expect.any(String), phase: expect.any(String), retryable: expect.any(Boolean) } }, { status: 'complete' }] });
  });

  it.each(['spice', 'spice-ts'])('sweeps component values in %s without mutating input', async format => {
    const input = format === 'spice' ? request.input : { format, document: { format: 'spice-ts', schemaVersion: '1.0', circuit: parseTitleless(source).toIR(), analyses: [{ type: 'ac', variation: 'dec', points: 200, startFreq: 1, stopFreq: 100000 }], models: [], subcircuits: [] } };
    const before = JSON.stringify(input);
    const result = await executeTool('spice_sweep', { request: { apiVersion: '1', input }, parameter: { kind: 'component', name: 'R1' }, range: { scale: 'lin', start: 1000, stop: 3000, points: 3 }, measurements });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ points: [1000, 2000, 3000].map(value => ({ value, status: 'complete', measurements: [{ unit: 'Hz', value: expect.any(Number) }] })) });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('generates logarithmic values and rejects malformed inputs', async () => {
    const response = await executeTool('spice_sweep', { request, parameter, range: { scale: 'dec', start: 1000, stop: 10000, points: 2 } });
    expect(response.structuredContent).toMatchObject({ points: [1000, Math.sqrt(1000 * 10000), 10000].map(value => ({ value: expect.closeTo(value, 8), status: 'complete' })) });
    for (const fields of [{ values: [] }, { values: [NaN] }, { values: [1], range: {} }, { range: { scale: 'dec', start: 0, stop: 10, points: 2 } }, { range: { scale: 'lin', start: 1, stop: 2, points: 1.5 } }]) {
      expect(await executeTool('spice_sweep', { request, parameter, ...fields })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
  });

  it('bounds response bytes, supports cancellation and advertises discovery', async () => {
    expect(await executeTool('spice_sweep', { request, parameter, values: [1000] }, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
    expect(await executeTool('spice_sweep', { request, parameter, values: [1000] }, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_sweep']) });
  });

  it('preserves duplicate order, independent measurement errors and unknown-target errors', async () => {
    const response = await executeTool('spice_sweep', { request, parameter, values: [3000, 1000, 3000], measurements: [...measurements, { kind: 'max', signal: 'v(missing)', analysis: 0 }] });
    expect(response.structuredContent).toMatchObject({ points: [3000, 1000, 3000].map(value => ({ value, status: 'complete', measurements: [{ unit: 'Hz' }, { error: { code: 'UNKNOWN_SIGNAL' } }] })) });
    expect(await executeTool('spice_sweep', { request, parameter: { kind: 'param', name: 'unknown' }, values: [1] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNKNOWN_PARAMETER' } } });
    expect(await executeTool('spice_sweep', { request, parameter: { kind: 'component', name: 'Rmissing' }, values: [1] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('enforces a whole-sweep deadline and reuses the concurrency quota', async () => {
    const execute = createToolExecutor({ streamLimits: { maxConcurrentJobs: 0 } });
    expect(await execute('spice_sweep', { request, parameter, values: [1000] })).toMatchObject({ structuredContent: { points: [{ status: 'failed', error: { code: 'RESOURCE_LIMIT' } }] } });
    const response = await executeTool('spice_sweep', { request, parameter, values: [1000, 2000] }, {
      limits: { ...DEFAULT_MCP_LIMITS, maxWallTimeMs: 20 },
      simulate: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { status: 'complete', analyses: [] }; },
    });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxWallTimeMs' } } } });
  });
});
