import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
const source = '* resistor\nI1 0 out 0\nR1 out 0 2k\n.dc I1 0 0.002 0.001\n.end';
const base = { request: { apiVersion: '1', input: { format: 'spice', source } }, sweptSource: 'I1', output: 'v(out)', sweepPoints: [0, 0.0005, 0.001, 0.002], includeSpotResistance: true };

describe('DC spot resistance', () => {
  it('reports the local secant in ohms for an independent current source sweep', async () => {
    const response = await executeTool(tool.name, base);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const data = response.structuredContent as { resistanceSpots: { resistance: { value: number; unit: string } }[] };
    for (const spot of data.resistanceSpots) {
      expect(spot.resistance.value).toBeCloseTo(2000, 7);
      expect(spot.resistance.unit).toBe('ohm');
    }
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(data).valid).toBe(true);
  });

  it.each([false, true])('uses traversal intervals, preserves order and does not extrapolate, reverse=%s', async reverse => {
    const axis = [0, 1, 3, 6]; const output = [0, 2, 10, 4];
    const arr = (v: number[]) => reverse ? [...v].reverse() : v;
    const analysis = { type: 'dc', analysisIndex: 0, axis: { name: 'I1', unit: 'A', values: arr(axis) }, voltagesV: { out: arr(output) }, currentsA: {} };
    const response = await executeTool(tool.name, { ...base, sweepPoints: [0, 1, 3, 6, 1, -1, 7] }, { simulate: async () => ({ status: 'complete', analyses: [analysis] }) as never });
    expect(response.isError).not.toBe(true);
    const spots = (response.structuredContent as { resistanceSpots: { sweepPoint: number; resistance: { value: number | null; reason?: string } }[] }).resistanceSpots;
    expect(spots.map(s => s.sweepPoint)).toEqual([0, 1, 3, 6, 1, -1, 7]);
    expect(spots.map(s => s.resistance.value)).toEqual(reverse ? [2, 2, 4, -2, 2, null, null] : [2, 4, -2, -2, 4, null, null]);
    expect(spots[5].resistance.reason).toMatch(/range/i);
  });

  it.each([false, true])('reports 2000 ohms on real ascending and descending sweeps and the source sign convention, reverse=%s', async reverse => {
    const sweep = reverse ? '.dc I1 0.002 0 -0.001' : '.dc I1 0 0.002 0.001';
    for (const [terminals, expected] of [['0 out', 2000], ['out 0', -2000]] as const) {
      const netlist = `* resistor\nI1 ${terminals} 0\nR1 out 0 2k\n${sweep}\n.end`;
      const response = await executeTool(tool.name, { ...base, request: { ...base.request, input: { format: 'spice', source: netlist } } });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      const spots = (response.structuredContent as { resistanceSpots: { resistance: { value: number } }[] }).resistanceSpots;
      expect(spots).toHaveLength(4);
      spots.forEach(s => expect(s.resistance.value).toBeCloseTo(expected, 7));
    }
  });

  it('uses selected analysis, step and differential output', async () => {
    const trace = (analysisIndex: number, index: number, scale: number) => ({ type: 'dc', analysisIndex, step: { index, parameter: 'R', value: index }, axis: { name: 'I1', unit: 'A', values: [0, 1, 2] }, voltagesV: { out: [1, 1 + scale, 1 + 2 * scale], ref: [1, 2, 3] }, currentsA: {} });
    const result = { status: 'complete', analyses: [trace(0, 0, 2), trace(1, 1, 4)] };
    const response = await executeTool(tool.name, { ...base, output: 'v(out,ref)', analysis: 1, step: 1, sweepPoints: [1] }, { simulate: async () => result as never });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect((response.structuredContent as { resistanceSpots: { resistance: { value: number } }[] }).resistanceSpots[0].resistance.value).toBe(3);
  });

  it('returns null for nonrepresentable resistance', async () => {
    for (const [axis, output] of [[[0, 1e-308], [0, 1e308]], [[0, 1e308], [0, 1e-308]]]) {
      const analysis = { type: 'dc', analysisIndex: 0, axis: { name: 'I1', unit: 'A', values: axis }, voltagesV: { out: output }, currentsA: {} };
      const response = await executeTool(tool.name, { ...base, sweepPoints: [0] }, { simulate: async () => ({ status: 'complete', analyses: [analysis] }) as never });
      const spot = (response.structuredContent as { resistanceSpots: { resistance: { value: number | null; reason: string } }[] }).resistanceSpots[0];
      expect(spot.resistance.value).toBeNull();
      expect(spot.resistance.reason).toMatch(/nonrepresentable/i);
    }
  });

  it('rejects voltage sweeps and incompatible flags with structured errors', async () => {
    for (const args of [
      { sweepPoints: undefined }, { includeSpotResistance: 'yes' }, { includeSpotGain: true }, { input: 'v(out)' }, { outputLevelsV: [1] }, { crossingDirection: 'rising' },
      { sweptSource: 'V1', request: { ...base.request, input: { format: 'spice', source: '* voltage\nV1 out 0 0\nR1 out 0 2k\n.dc V1 0 2 1\n.end' } } },
    ]) {
      const response = await executeTool(tool.name, { ...base, ...args });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    expect(validate(base).valid).toBe(true);
    expect(validate({ ...base, includeSpotResistance: 'true' }).valid).toBe(false);
  });

});
