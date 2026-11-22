import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: '* divider\nV1 in 0 0\nR1 in out 1k\nR2 out 0 1k\n.dc V1 0 4 1\n.end' } };
const base = { request, sweptSource: 'V1', output: 'v(out)' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
type Spot = { gain: number | null; gainReason?: string; inputValue: number | null; outputValue: number | null };
const get = async (args: Record<string, unknown>, result?: object) => {
  const response = await executeTool(tool.name, { ...base, ...args }, result ? { simulate: async () => result as never } : undefined);
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  return response.structuredContent as { spots: Spot[] };
};
const trace = (axis: number[], input: number[], output: number[], index = 0) => ({ type: 'dc' as const, analysisIndex: 0, step: { index, parameter: 'R', value: index }, axis: { name: 'V1', unit: 'V' as const, values: axis }, voltagesV: { in: input, out: output, ref: axis.map(() => 1) }, currentsA: {} });
const simulation = (...analyses: ReturnType<typeof trace>[]) => ({ status: 'complete' as const, analyses });

describe('DC spot gain', () => {
  it.each([false, true])('uses traversal-order knot intervals on nonuniform sweeps, reverse=%s', async reverse => {
    const axis = [0, 1, 3, 6], input = [0, 2, 6, 12], output = [0, 2, 10, 4];
    const arr = (a: number[]) => reverse ? [...a].reverse() : a;
    const result = simulation(trace(arr(axis), arr(input), arr(output)));
    const content = await get({ input: 'v(in)', sweepPoints: [0, 0.5, 1, 2, 3, 4, 6, -1, 7], includeSpotGain: true }, result);
    expect(content.spots.map(s => s.gain)).toEqual(reverse ? [1, 1, 1, 2, 2, -1, -1, null, null] : [1, 1, 2, 2, -1, -1, -1, null, null]);
    expect(content.spots[7].gainReason).toMatch(/range/i);
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(content).valid).toBe(true);
  });

  it('follows sweep traversal even when selected input runs oppositely', async () => {
    const result = simulation(trace([0, 1, 3], [6, 4, 0], [0, 2, 10]));
    const content = await get({ input: 'v(in)', sweepPoints: [0, 1, 3], includeSpotGain: true }, result);
    expect(content.spots.map(s => s.gain)).toEqual([-1, -2, -2]);
  });

  it('supports repeated selected input with a null reason and constant output', async () => {
    const result = simulation(trace([0, 1, 2, 3], [0, 1, 1, 2], [2, 2, 2, 2]));
    const content = await get({ input: 'v(in)', sweepPoints: [0.5, 1.5, 2.5], includeSpotGain: true }, result);
    expect(content.spots.map(s => s.gain)).toEqual([0, null, 0]);
    expect(content.spots[1].gainReason).toMatch(/zero/i);
    const constant = simulation(trace([0, 1], [1, 1], [0, 1]));
    expect((await get({ input: 'v(in)', sweepPoints: [0.5], includeSpotGain: true }, constant)).spots[0].gain).toBeNull();
  });

  it('uses selected steps and differential voltage selectors', async () => {
    const result = simulation(trace([0, 1, 2], [1, 3, 5], [1, 5, 9], 0), trace([0, 1, 2], [1, 3, 5], [1, -3, -7], 1));
    for (const [step, expected] of [[0, 2], [1, -2]] as const) {
      const content = await get({ input: 'v(in,ref)', output: 'v(out,ref)', step, sweepPoints: [1], includeSpotGain: true }, result);
      expect(content.spots[0].gain).toBe(expected);
    }
  });

  it('handles finite extremes and rejects unrepresentable gain', async () => {
    const cases = [
      { x: [-1e308, 1e308], y: [-1e308, 1e308], gain: 1 },
      { x: [-1e308, 1e308], y: [-5e307, 5e307], gain: 0.5 },
      { x: [0, 1e-308], y: [-1e308, 1e308], gain: null },
      { x: [0, 1e308], y: [0, 1e-308], gain: null },
      { x: [1e308, 1.7e308], y: [0, 1], gain: 1 / 7e307 },
    ];
    for (const { x, y, gain } of cases) {
      const content = await get({ input: 'v(in)', sweepPoints: [0.5], includeSpotGain: true }, simulation(trace([0, 1], x, y)));
      expect(content.spots[0].gain).toBe(gain);
      expect(Number.isFinite(content.spots[0].inputValue)).toBe(true);
      expect(Number.isFinite(content.spots[0].outputValue)).toBe(true);
      if (gain === null) expect(content.spots[0].gainReason).toMatch(/non/i);
      expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(JSON.parse(JSON.stringify(content))).valid).toBe(true);
    }
    const content = await get({ input: 'v(in)', sweepPoints: [0], includeSpotGain: true }, simulation(trace([-1e308, 1e308], [-1e308, 1e308], [-1e308, 1e308])));
    expect(content.spots[0]).toMatchObject({ gain: 1, inputValue: 0, outputValue: 0 });
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(JSON.parse(JSON.stringify(content))).valid).toBe(true);
  });

  it('keeps legacy shape and rejects invalid arguments with structured errors', async () => {
    const plain = await get({ sweepPoints: [0.5] });
    expect(await get({ sweepPoints: [0.5], includeSpotGain: false })).toEqual(plain);
    expect(plain.spots[0]).not.toHaveProperty('gain');
    const inputSchema = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    expect(inputSchema({ ...base, sweepPoints: [1], includeSpotGain: true }).valid).toBe(true);
    expect(inputSchema({ ...base, sweepPoints: [1], includeSpotGain: 'true' }).valid).toBe(false);
    const withGain = await get({ sweepPoints: [0.5], includeSpotGain: true });
    const { gain: _gain, ...sameSpot } = withGain.spots[0];
    expect(sameSpot).toEqual(plain.spots[0]);
    expect({ ...withGain, spots: plain.spots }).toEqual(plain);
    for (const args of [{ includeSpotGain: true }, { includeSpotGain: 'true', sweepPoints: [1] }, { includeSpotGain: null, sweepPoints: [1] }, { includeSpotGain: true, sweepPoints: [] }]) {
      expect(await executeTool(tool.name, { ...base, ...args })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
  });

  it.each([
    ['divider', request.input.source, 'v(in)', 0.5],
    ['VCVS', '* gain\nV1 in 0 0\nE1 out 0 in 0 -2\nR1 out 0 1k\n.dc V1 0 4 1\n.end', 'v(in)', -2],
    ['selected input', request.input.source, 'v(out)', 1],
  ])('matches analytic %s via public MCP', async (_name, source, input, expected) => {
    const content = await get({ request: { ...request, input: { ...request.input, source } }, input, sweepPoints: [0, 0.5, 1, 4], includeSpotGain: true });
    for (const spot of content.spots) expect(Math.abs(spot.gain! - expected)).toBeLessThan(1e-10);
  });
});
