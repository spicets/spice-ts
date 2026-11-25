import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const request = (reverse = false) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source: `* resistor\nV1 in 0 0\nR1 in 0 1k\n.dc V1 ${reverse ? '4 0 -1' : '0 4 1'}\n.end` } });
const base = { request: request(), sweptSource: 'V1', output: 'v(in)' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
type Spot = { sweepPoint: number; currentA: number | null; conductanceS: number | null; outOfRange: boolean; conductanceReason?: string };
const trace = (axis: number[], currents: number[], index = 0, analysisIndex = 0) => ({ type: 'dc' as const, analysisIndex, step: { index, parameter: 'R', value: index }, axis: { name: 'V1', unit: 'V' as const, values: axis }, voltagesV: { in: axis.map((_, i) => i) }, currentsA: { v1: currents } });
const simulation = (...analyses: ReturnType<typeof trace>[]) => ({ status: 'complete' as const, analyses });
const run = (args: Record<string, unknown>, result?: ReturnType<typeof simulation>) => executeTool(tool.name, { ...base, ...args }, result ? { simulate: async () => result } : undefined);
const spots = (content: unknown) => (content as { currentSpots: Spot[] }).currentSpots;

describe('DC current spots', () => {
  it.each([false, true])('matches the raw protocol resistor oracle (descending=%s)', async reverse => {
    const req = request(reverse);
    const raw = await simulateProtocolV1(req);
    const a = raw.analyses.find(a => a.type === 'dc');
    if (!a || a.type !== 'dc') throw new Error('Missing sweep');
    const keys = Object.keys(a.currentsA);
    const key = keys.find(k => k.toLowerCase() === 'v1');
    expect(key).toBeDefined();
    const samples = a.axis.values.map((v, i) => [v, a.currentsA[key!][i]]).sort((x, y) => x[0] - y[0]);
    const points = [0, 1, 1.5, 4, -1, 5, 1.5];
    const response = await run({ request: req, currentSignal: 'i(V1)', sweepPoints: points });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const actual = spots(response.structuredContent);
    expect(actual.map(s => s.sweepPoint)).toEqual(points);
    for (const [i, point] of points.entries()) {
      if (point < 0 || point > 4) { expect(actual[i]).toMatchObject({ currentA: null, conductanceS: null, outOfRange: true, conductanceReason: expect.any(String) }); continue; }
      const end = Math.min(samples.findIndex(([v]) => v > point) < 0 ? samples.length - 1 : samples.findIndex(([v]) => v > point), samples.length - 1);
      const [x0, y0] = samples[end - 1]; const [x1, y1] = samples[end];
      const current = y0 + (point - x0) / (x1 - x0) * (y1 - y0);
      const slope = (y1 - y0) / (x1 - x0);
      expect(actual[i].currentA).toBeCloseTo(current, 14);
      expect(actual[i].currentA).toBeCloseTo(-point / 1000, 14);
      expect(actual[i].conductanceS).toBeCloseTo(slope, 14);
      expect(actual[i].conductanceS).toBeCloseTo(-0.001, 14);
      expect(actual[i].outOfRange).toBe(false);
    }
  });

  it.each([false, true])('selects increasing-coordinate intervals for nonuniform nonlinear data (descending=%s)', async reverse => {
    const axis = [0, 1, 3, 6], values = [0, 2, 2, -4];
    const a = reverse ? [...axis].reverse() : axis; const v = reverse ? [...values].reverse() : values;
    const response = await run({ currentSignal: 'I(v1)', sweepPoints: [0, 1, 2, 3, 6, 3] }, simulation(trace(a, v)));
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(spots(response.structuredContent)).toEqual([
      { sweepPoint: 0, currentA: 0, conductanceS: 2, outOfRange: false },
      { sweepPoint: 1, currentA: 2, conductanceS: 0, outOfRange: false },
      { sweepPoint: 2, currentA: 2, conductanceS: 0, outOfRange: false },
      { sweepPoint: 3, currentA: 2, conductanceS: -2, outOfRange: false },
      { sweepPoint: 6, currentA: -4, conductanceS: -2, outOfRange: false },
      { sweepPoint: 3, currentA: 2, conductanceS: -2, outOfRange: false },
    ]);
  });

  it('rejects malformed selectors, missing points, unknown currents and current sweeps', async () => {
    for (const currentSignal of ['', 'i()', 'v(v1)', 'i( v1)', 'i(v1,x)', 'i(v1))', 42, null]) {
      expect(await run({ currentSignal, sweepPoints: [1] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const args of [{ currentSignal: 'i(v1)' }, { currentSignal: 'i(missing)', sweepPoints: [1] }, { currentSignal: 'i(v1)', sweepPoints: [] }, { currentSignal: 'i(v1)', sweepPoints: Array(129).fill(1) }]) {
      expect(await run(args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const currentRequest = { apiVersion: '1', input: { format: 'spice', source: '* current\nI1 in 0 0\nR1 in 0 1k\n.dc I1 0 1m 0.5m\n.end' } };
    expect(await run({ request: currentRequest, sweptSource: 'I1', input: 'v(in)', currentSignal: 'i(I1)', sweepPoints: [0] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('rejects invalid or unaligned current samples and reports nonrepresentable slopes', async () => {
    for (const values of [[0, NaN], [0, Infinity], [0]]) {
      expect(await run({ currentSignal: 'i(v1)', sweepPoints: [0] }, simulation(trace([0, 1], values)))).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const [axis, current] of [[[0, 1e-308], [0, 1e308]], [[0, 1e308], [0, Number.MIN_VALUE]]] as [number[], number[]][]) {
      const response = await run({ currentSignal: 'i(v1)', sweepPoints: [0] }, simulation(trace(axis, current)));
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(spots(response.structuredContent)[0]).toMatchObject({ currentA: 0, conductanceS: null, conductanceReason: expect.any(String), outOfRange: false });
      expect(JSON.stringify(response.structuredContent)).not.toMatch(/NaN|Infinity/);
    }
  });

  it('never returns nonfinite structured values for extreme sweep coordinates', async () => {
    const huge = Number.MAX_VALUE;
    const a = trace([-huge, huge], [-1, 1]);
    const response = await run({ currentSignal: 'i(v1)', sweepPoints: [0] }, simulation(a));
    const finite = (value: unknown): boolean => typeof value === 'number' ? Number.isFinite(value) : value === null || typeof value !== 'object' || Object.values(value).every(finite);
    expect(finite(response.structuredContent)).toBe(true);
  });

  it('honors explicit analysis and step selectors and result limits', async () => {
    const result = simulation(trace([0, 1], [0, 1], 0, 0), trace([0, 1], [0, 2], 1, 0), trace([0, 1], [0, 3], 0, 1));
    expect(await run({ currentSignal: 'i(v1)', sweepPoints: [0.5] }, result)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    expect(await run({ currentSignal: 'i(v1)', sweepPoints: [0.5], analysis: 0 }, result)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    const selected = await run({ currentSignal: 'i(v1)', sweepPoints: [0.5], analysis: 0, step: 1 }, result);
    expect(spots(selected.structuredContent)[0]).toMatchObject({ currentA: 1, conductanceS: 2 });
    const limited = { ...base.request, options: { limits: { maxResultPoints: 0 } } };
    expect(await run({ request: limited, currentSignal: 'i(v1)', sweepPoints: [0] })).toMatchObject({ isError: true });
  });

  it('advertises schemas and preserves the default response', async () => {
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema); const output = validator.getValidator(tool.outputSchema!);
    expect(input({ ...base, currentSignal: 'i(v1)', sweepPoints: [1] }).valid).toBe(true);
    expect(input({ ...base, currentSignal: 'v(v1)', sweepPoints: [1] }).valid).toBe(false);
    expect(input({ ...base, currentSignal: 'i(v1)' }).valid).toBe(false);
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_dc_metrics']) });
    const legacy = await run({}); const withPoints = await run({ sweepPoints: [1] });
    expect(legacy.isError).not.toBe(true);
    expect(legacy.structuredContent).not.toHaveProperty('currentSpots');
    expect(withPoints.structuredContent).not.toHaveProperty('currentSpots');
    expect(output(legacy.structuredContent).valid).toBe(true);
    const current = await run({ currentSignal: 'i(v1)', sweepPoints: [1] });
    expect(output(current.structuredContent).valid).toBe(true);
    const { currentSpots: _, ...rest } = current.structuredContent as Record<string, unknown>;
    expect(rest).toEqual(withPoints.structuredContent);
  });
});
