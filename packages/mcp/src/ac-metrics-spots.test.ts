import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool, MCP_TOOLS } from './server.js';
import { acMetrics } from './ac-metrics.js';

const request = { apiVersion: '1', input: { format: 'spice', source: '* RC\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 1 1 1000\n.end' } };
const base = { request, output: 'out', input: 'in' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
const validator = new AjvJsonSchemaValidator();
const sweep = (magnitudes: number[], phases: number[]): SimulationResultV1 => ({ status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: [1, 10, 100], currentPhasors: {}, voltagePhasors: { out: magnitudes.map((magnitude, i) => ({ magnitude, phaseDegrees: phases[i] })) } }] });

describe('AC transfer spots', () => {
  it('matches analytic RC transfer at sampled frequencies and preserves order', async () => {
    const frequenciesHz = [100, 1, 10, 100];
    const response = await executeTool(tool.name, { ...base, frequenciesHz });
    expect(response.isError).not.toBe(true);
    const spots = (response.structuredContent as { spots: { frequencyHz: number; gainDb: number; phaseDeg: number }[] }).spots;
    expect(spots.map(s => s.frequencyHz)).toEqual(frequenciesHz);
    for (const spot of spots) {
      const x = 2 * Math.PI * spot.frequencyHz * 0.001;
      expect(Math.abs(spot.gainDb - 20 * Math.log10(1 / Math.hypot(1, x)))).toBeLessThan(1e-6);
      expect(Math.abs(spot.phaseDeg + Math.atan(x) * 180 / Math.PI)).toBeLessThan(1e-6);
    }
  });
  it('interpolates unwrapped phase and dB in log frequency without extrapolation', () => {
    const spots = acMetrics(sweep([1, 0.1, 0.01], [170, -170, -150]), { output: 'out', frequenciesHz: [Math.sqrt(10), 10, 0.5, 101] }).spots!;
    expect(spots[0].gainDb).toBeCloseTo(-10, 10);
    expect(spots[0].phaseDeg).toBeCloseTo(180, 10);
    expect(spots[1]).toMatchObject({ gainDb: -20, phaseDeg: 190 });
    for (const spot of spots.slice(2)) expect(spot).toMatchObject({ gainDb: null, phaseDeg: null, reasons: { gainDb: 'OUT_OF_RANGE', phaseDeg: 'OUT_OF_RANGE' } });
  });
  it('interpolates distinct adjacent frequencies even when their logarithms round equally', () => {
    const result = sweep([1, 0.1, 0.01], [0, 20, 40]);
    const trace = result.analyses[0];
    if (trace.type !== 'ac') throw new Error('expected AC');
    trace.frequencyHz = [1e10, 1e10 + 0.000004, 1e10 + 0.000008];
    const spot = acMetrics(result, { output: 'out', frequenciesHz: [1e10 + 0.000002] }).spots![0];
    expect(spot.gainDb).toBeCloseTo(-10, 5);
    expect(spot.phaseDeg).toBeCloseTo(10, 5);
  });
  it('reports undefined zero-magnitude samples and intervals', () => {
    const spots = acMetrics(sweep([1, 0, 1], [0, 0, 0]), { output: 'out', frequenciesHz: [10, 2] }).spots!;
    for (const spot of spots) expect(spot).toMatchObject({ gainDb: null, phaseDeg: null, reasons: { gainDb: 'UNDEFINED_VALUE', phaseDeg: 'UNDEFINED_VALUE' } });
  });
  it('combines stepped differential selection with group delay and bandpass', async () => {
    const stepped = { apiVersion: '1', input: { format: 'spice', source: '* stepped RC\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 1 1 1000\n.step param R1 list 1k 2k\n.end' } };
    const args = { request: stepped, output: 'out', input: 'in', analysis: 0, step: 1, groupDelayAtHz: 10, includeBandpass: true, frequenciesHz: [1, 10, 100] };
    const direct = await executeTool(tool.name, args);
    const differential = await executeTool(tool.name, { ...args, output: 'v(out,0)', input: 'v(in,0)' });
    expect(direct.isError).not.toBe(true);
    expect(differential.structuredContent).toEqual(direct.structuredContent);
    expect(direct.structuredContent).toHaveProperty('groupDelaySeconds');
    expect(direct.structuredContent).toHaveProperty('bandpass');
    const spots = (direct.structuredContent as { spots: { frequencyHz: number; gainDb: number; phaseDeg: number }[] }).spots;
    for (const spot of spots) {
      const x = 2 * Math.PI * spot.frequencyHz * 0.002;
      expect(Math.abs(spot.gainDb - 20 * Math.log10(1 / Math.hypot(1, x)))).toBeLessThan(1e-6);
      expect(Math.abs(spot.phaseDeg + Math.atan(x) * 180 / Math.PI)).toBeLessThan(1e-6);
    }
  });
  it('validates input and strict output and preserves legacy shape', async () => {
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const legacy = await executeTool(tool.name, base);
    expect(legacy.structuredContent).not.toHaveProperty('spots');
    const response = await executeTool(tool.name, { ...base, frequenciesHz: [1, 10000] });
    expect(input({ ...base, frequenciesHz: [1] }).valid).toBe(true);
    expect(input({ ...base, frequenciesHz: Array(128).fill(1) }).valid).toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    const zero = await executeTool(tool.name, { ...base, output: 'out', input: undefined, frequenciesHz: [10] }, { simulate: async () => sweep([1, 0, 1], [0, 0, 0]) });
    expect(output(zero.structuredContent).valid).toBe(true);
    const content = response.structuredContent as { spots: object[] };
    expect(output({ ...content, spots: [{ ...content.spots[0], extra: true }] }).valid).toBe(false);
    expect(output({ ...content, spots: [{ frequencyHz: 1, gainDb: null, phaseDeg: null, reasons: {} }] }).valid).toBe(false);
    expect(output({ ...content, spots: [{ frequencyHz: 1, gainDb: 1, phaseDeg: 2, reasons: { gainDb: 'OUT_OF_RANGE' } }] }).valid).toBe(false);
    for (const frequenciesHz of [[], Array(129).fill(1), [0], ['1'], '1', null]) expect(input({ ...base, frequenciesHz }).valid).toBe(false);
    for (const frequenciesHz of [[], Array(129).fill(1), [0], [-1], [NaN], [Infinity], Array(1), ['1'], '1', null]) {
      const invalid = await executeTool(tool.name, { ...base, frequenciesHz });
      expect(invalid).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
  });
});
