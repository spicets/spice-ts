import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
const request = (reverse = false) => ({ apiVersion: '1', input: { format: 'spice', source: `* divider\nV1 in 0 0\nR1 in out 1k\nR2 out 0 1k\n.dc V1 ${reverse ? '10 0 -2' : '0 10 2'}\n.end` } });
const base = { request: request(), sweptSource: 'V1', output: 'v(out)' };
type Crossing = { outputLevelV: number; sweepPoint: number | null };

describe('DC output level crossings', () => {
  it.each([false, true])('interpolates divider levels in request order (reverse=%s)', async reverse => {
    const levels = [0, 1.5, 5, -1, 6, 1.5];
    const response = await executeTool(tool.name, { ...base, request: request(reverse), outputLevelsV: levels });
    expect(response.isError).not.toBe(true);
    const crossings = (response.structuredContent as { levelCrossings: Crossing[] }).levelCrossings;
    expect(crossings.map(c => c.outputLevelV)).toEqual(levels);
    for (const [i, value] of [0, 3, 10, null, null, 3].entries()) {
      if (value === null) expect(crossings[i].sweepPoint).toBeNull();
      else expect(crossings[i].sweepPoint).toBeCloseTo(value, 10);
    }
  });

  it('uses traversal order on a nonmonotonic output including initial equality and plateaus', async () => {
    const axis = [0, 1, 2, 3, 4, 5, 6];
    const output = [2, 2, 4, 4, 0, 2, 2];
    for (const reverse of [false, true]) {
      const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: reverse ? [...axis].reverse() : axis }, voltagesV: { out: reverse ? [...output].reverse() : output }, currentsA: {} }] };
      const response = await executeTool(tool.name, { ...base, outputLevelsV: [2, 3, 1, 4, 5] }, { simulate: async () => result });
      expect(response.isError).not.toBe(true);
      expect((response.structuredContent as { levelCrossings: Crossing[] }).levelCrossings.map(c => c.sweepPoint)).toEqual(reverse ? [6, 3.25, 4.5, 3, null] : [0, 1.5, 3.75, 2, null]);
    }
  });

  it('uses the sweep axis with differential output and an explicit input, isolating selected steps', async () => {
    const stepped = { ...base.request, input: { ...base.request.input, source: base.request.input.source.replace('.end', '.step R2 list 1k 3k\n.end') } };
    for (const [step, expected] of [[0, 4], [1, 8]] as const) {
      const response = await executeTool(tool.name, { ...base, request: stepped, analysis: 0, step, input: 'v(out,0)', output: 'v(in,out)', outputLevelsV: [2] });
      expect(response.isError).not.toBe(true);
      expect((response.structuredContent as { levelCrossings: Crossing[] }).levelCrossings[0].sweepPoint).toBeCloseTo(expected, 10);
    }
  });

  it('exposes strict discovery schemas, structured errors and unchanged omitted-option output', async () => {
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const legacy = await executeTool(tool.name, base);
    expect(legacy.isError).not.toBe(true);
    expect(legacy.structuredContent).not.toHaveProperty('levelCrossings');
    expect(output(legacy.structuredContent).valid).toBe(true);
    const response = await executeTool(tool.name, { ...base, outputLevelsV: [1.5, 6] });
    expect(input({ ...base, outputLevelsV: [1.5] }).valid).toBe(true);
    expect(input({ ...base, outputLevelsV: Array(128).fill(1) }).valid).toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    const content = response.structuredContent as { levelCrossings: Crossing[] };
    expect(output({ ...content, levelCrossings: [{ ...content.levelCrossings[0], extra: true }] }).valid).toBe(false);
    for (const outputLevelsV of [[], Array(129).fill(1), [NaN], [Infinity], [-Infinity], Array(1), ['3'], '3', null, {}]) {
      expect(await executeTool(tool.name, { ...base, outputLevelsV })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    }
    for (const outputLevelsV of [[], Array(129).fill(1), ['3'], '3', null, {}]) expect(input({ ...base, outputLevelsV }).valid).toBe(false);
  });
});
