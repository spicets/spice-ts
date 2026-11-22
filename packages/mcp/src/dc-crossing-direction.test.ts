import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const base = { request: { apiVersion: '1', input: { format: 'spice', source: '* placeholder\nV1 in 0 0\nR1 in 0 1k\n.dc V1 0 6 1\n.end' } }, sweptSource: 'V1', output: 'v(out)', outputLevelsV: [2] };

describe('directional DC crossings', () => {
  it('selects the first rising or falling crossing in traversal order', async () => {
    const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1, 2, 3, 4, 5, 6] }, voltagesV: { out: [2, 2, 4, 4, 0, 2, 2] }, currentsA: {} }] };
    const run = async (crossingDirection: string) => {
      const response = await executeTool('spice_dc_metrics', { ...base, crossingDirection }, { simulate: async () => result });
      expect(response.isError).not.toBe(true);
      return (response.structuredContent as { levelCrossings: { sweepPoint: number | null }[] }).levelCrossings[0].sweepPoint;
    };
    expect(await run('either')).toBe(0);
    expect(await run('rising')).toBe(5);
    expect(await run('falling')).toBe(3.5);
  });

  it.each([false, true])('handles plateaus, repeated levels and descending traversal %s', async reverse => {
    const axis = [0, 1, 2, 3, 4, 5, 6];
    const values = [2, 2, 4, 4, 0, 2, 2];
    const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: reverse ? [...axis].reverse() : axis }, voltagesV: { out: reverse ? [...values].reverse() : values, ref: axis.map(() => 0) }, currentsA: {} }] };
    const run = async (direction?: string) => {
      const response = await executeTool('spice_dc_metrics', { ...base, output: 'v(out,ref)', outputLevelsV: [2, 4, 5, ...Array(125).fill(2)], ...(direction ? { crossingDirection: direction } : {}) }, { simulate: async () => result });
      expect(response.isError).not.toBe(true);
      return (response.structuredContent as { levelCrossings: { sweepPoint: number | null }[] }).levelCrossings.map(c => c.sweepPoint);
    };
    expect(await run()).toEqual(await run('either'));
    for (const [direction, expected] of reverse ? [['rising', [3.5, 3, null]], ['falling', [1, null, null]]] as const : [['rising', [5, 2, null]], ['falling', [3.5, null, null]]] as const) {
      const points = await run(direction);
      expect(points.slice(0, 3)).toEqual(expected);
      expect(points.slice(3)).toEqual(Array(125).fill(expected[0]));
    }
  });

  it.each([
    { axis: [0, 1], output: [-1e308, 1e308], direction: 'rising', expected: 0.5 },
    { axis: [1, 0], output: [1e308, -1e308], direction: 'falling', expected: 0.5 },
    { axis: [-1e308, 1e308], output: [-1, 1], direction: 'rising', expected: 0 },
  ])('interpolates extreme finite values without extrapolation', async ({ axis, output, direction, expected }) => {
    const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: axis }, voltagesV: { out: output }, currentsA: {} }] };
    const response = await executeTool('spice_dc_metrics', { ...base, outputLevelsV: [0], crossingDirection: direction }, { simulate: async () => result });
    expect(response.isError).not.toBe(true);
    expect((response.structuredContent as { levelCrossings: { sweepPoint: number | null }[] }).levelCrossings[0].sweepPoint).toBe(expected);
  });

  it('validates discovery, directions, dependencies and limits', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    expect(input({ ...base, crossingDirection: 'rising' }).valid).toBe(true);
    expect(input({ ...base, crossingDirection: 'sideways' }).valid).toBe(false);
    for (const args of [{ ...base, crossingDirection: 'sideways' }, { ...base, crossingDirection: null }, { ...base, outputLevelsV: undefined, crossingDirection: 'either' }, { ...base, outputLevelsV: Array(129).fill(2), crossingDirection: 'rising' }]) {
      expect(await executeTool(tool.name, args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const limited = { ...base.request, options: { limits: { maxResultPoints: 0 } } };
    expect(await executeTool(tool.name, { ...base, request: limited, crossingDirection: 'rising' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    const response = await executeTool(tool.name, { ...base, crossingDirection: 'rising' }, { simulate: async () => ({ status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 4] }, currentsA: {} }] }) });
    expect(output(response.structuredContent).valid).toBe(true);
  });

  it('applies analysis and step selectors before finding directional crossings', async () => {
    const trace = (analysisIndex: number, index: number, values: number[]) => ({ type: 'dc' as const, analysisIndex, step: { index, parameter: 'R', value: index }, axis: { name: 'V1', unit: 'V' as const, values: [0, 1, 2] }, voltagesV: { out: values }, currentsA: {} });
    const result = { status: 'complete' as const, analyses: [trace(0, 0, [0, 4, 0]), trace(0, 1, [0, 2, 0]), trace(1, 0, [4, 0, 4])] };
    for (const [analysis, step, expected] of [[0, 0, 0.5], [0, 1, 1], [1, 0, 1.5]] as const) {
      const response = await executeTool('spice_dc_metrics', { ...base, analysis, step, crossingDirection: 'rising' }, { simulate: async () => result });
      expect(response.isError).not.toBe(true);
      expect((response.structuredContent as { levelCrossings: { sweepPoint: number }[] }).levelCrossings[0].sweepPoint).toBe(expected);
    }
    expect(await executeTool('spice_dc_metrics', { ...base, crossingDirection: 'rising' }, { simulate: async () => result })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it.each([false, true])('runs a real behavioral transfer deck, reverse=%s', async reverse => {
    const source = `* V-shaped transfer\nV1 in 0 0\nB1 out 0 v=abs(v(in)-2)\nR1 out 0 1k\n.dc V1 ${reverse ? '4 0 -0.5' : '0 4 0.5'}\n.end`;
    const request = { apiVersion: '1', input: { format: 'spice', source } };
    const run = async (direction: string) => {
      const response = await executeTool('spice_dc_metrics', { ...base, request, analysis: 0, step: 0, outputLevelsV: [1], crossingDirection: direction });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      return (response.structuredContent as { levelCrossings: { sweepPoint: number }[] }).levelCrossings[0].sweepPoint;
    };
    const rising = await run('rising');
    const falling = await run('falling');
    expect(Math.abs(rising - (reverse ? 1 : 3))).toBeLessThan(1e-9);
    expect(Math.abs(falling - (reverse ? 3 : 1))).toBeLessThan(1e-9);
  });
});
