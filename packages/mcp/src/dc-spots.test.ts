import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
const request = (reverse = false) => ({ apiVersion: '1', input: { format: 'spice', source: `* divider\nV1 in 0 0\nR1 in out 1k\nR2 out 0 1k\n.dc V1 ${reverse ? '10 0 -2' : '0 10 2'}\n.end` } });
const base = { request: request(), sweptSource: 'V1', output: 'v(out)' };
type Spot = { sweepPoint: number; inputValue: number | null; outputValue: number | null; outOfRange: boolean };

describe('DC sweep spots', () => {
  it.each([false, true])('interpolates the divider in request order (reverse=%s)', async reverse => {
    const points = [0, 3, 10, -1, 11, 3];
    const response = await executeTool(tool.name, { ...base, request: request(reverse), sweepPoints: points });
    expect(response.isError).not.toBe(true);
    const spots = (response.structuredContent as { spots: Spot[] }).spots;
    expect(spots.map(s => s.sweepPoint)).toEqual(points);
    expect(spots.map(s => s.outOfRange)).toEqual([false, false, false, true, true, false]);
    for (const [i, value] of [0, 1.5, 5, null, null, 1.5].entries()) {
      if (value === null) expect(spots[i]).toMatchObject({ inputValue: null, outputValue: null });
      else { expect(spots[i].outputValue).toBeCloseTo(value, 10); expect(spots[i].inputValue).toBeCloseTo(points[i], 10); }
    }
  });

  it('uses the source axis, not the selected differential input, and isolates steps', async () => {
    const stepped = { ...base.request, input: { ...base.request.input, source: base.request.input.source.replace('.end', '.step R2 list 1k 3k\n.end') } };
    for (const [step, ratio] of [[0, 0.5], [1, 0.75]] as const) {
      const response = await executeTool(tool.name, { ...base, request: stepped, analysis: 0, step, input: 'v(out,0)', output: 'v(in,out)', sweepPoints: [3] });
      expect(response.isError).not.toBe(true);
      const spot = (response.structuredContent as { spots: Spot[] }).spots[0];
      expect(spot.sweepPoint).toBe(3);
      expect(spot.inputValue).toBeCloseTo(3 * ratio, 10);
      expect(spot.outputValue).toBeCloseTo(3 * (1 - ratio), 10);
    }
  });

  it('validates discovery schemas, runtime input and legacy output', async () => {
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const legacy = await executeTool(tool.name, base);
    expect(legacy.isError).not.toBe(true);
    expect(legacy.structuredContent).not.toHaveProperty('spots');
    expect(output(legacy.structuredContent).valid).toBe(true);
    const response = await executeTool(tool.name, { ...base, sweepPoints: [3, -1] });
    expect(input({ ...base, sweepPoints: [3] }).valid).toBe(true);
    expect(input({ ...base, sweepPoints: Array(128).fill(1) }).valid).toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    const content = response.structuredContent as { spots: Spot[] };
    expect(output({ ...content, spots: [{ ...content.spots[0], extra: true }] }).valid).toBe(false);
    for (const sweepPoints of [[], Array(129).fill(1), [NaN], [Infinity], [-Infinity], Array(1), ['3'], '3', null]) {
      expect(await executeTool(tool.name, { ...base, sweepPoints })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      if (Array.isArray(sweepPoints) && sweepPoints.every(v => typeof v === 'number' && Number.isFinite(v)) || typeof sweepPoints !== 'object' || sweepPoints === null || Array.isArray(sweepPoints) && sweepPoints.some(v => typeof v !== 'number')) expect(input({ ...base, sweepPoints }).valid).toBe(false);
    }
    expect(await executeTool(tool.name, { ...base, sweepPoints: [3], extra: 1 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('rejects repeated sweep coordinates even with a distinct monotonic input', async () => {
    const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1, 1, 2] }, voltagesV: { in: [0, 1, 2, 3], out: [0, 0.5, 1, 1.5] }, currentsA: {} }] };
    const response = await executeTool(tool.name, { ...base, input: 'v(in)', sweepPoints: [1] }, { simulate: async () => result });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
});
