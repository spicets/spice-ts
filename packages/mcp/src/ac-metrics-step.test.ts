import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool, MCP_TOOLS } from './server.js';

const deck = (resistance: string, step = '') => `* RC low pass\nV1 in 0 DC 0 AC 2\nR1 in out ${resistance}\nC1 out 0 1u\n.ac dec 100 0.1 100k\n${step}\n.end`;
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
const stepped = request(deck('1k', '.step param R1 list 1k 2k'));
const base = { request: stepped, output: 'out', input: 'in', groupDelayAtHz: 100 };
const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
const validator = new AjvJsonSchemaValidator();

describe('stepped AC metrics', () => {
  it('selects each real RC response and matches independent standalone simulations', async () => {
    expect(await executeTool('spice_ac_metrics', base)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', message: expect.stringContaining('specify a step') } } });
    const bandwidths: number[] = [];
    for (const [step, resistance] of [[0, '1k'], [1, '2k']] as const) {
      const selected = await executeTool('spice_ac_metrics', { ...base, step });
      const standalone = await executeTool('spice_ac_metrics', { ...base, request: request(deck(resistance)) });
      expect(selected.isError).not.toBe(true);
      expect(standalone.isError).not.toBe(true);
      const actual = selected.structuredContent as Record<string, number>;
      const expected = standalone.structuredContent as Record<string, number>;
      for (const key of ['dcGainDb', 'f3dbHz', 'groupDelaySeconds']) {
        expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(expected[key]));
      }
      bandwidths.push(actual.f3dbHz);
      // 100 points/decade grid plus interpolation: 0.1% from the analytic pole.
      expect(Math.abs(actual.f3dbHz / (1 / (2 * Math.PI * (step + 1) * 1000 * 1e-6)) - 1)).toBeLessThan(0.001);
    }
    expect(bandwidths[0]).not.toBeCloseTo(bandwidths[1], 1);
  });

  it('validates the public selector and reports unknown steps', async () => {
    const input = validator.getValidator(tool.inputSchema);
    expect(input({ ...base, step: 0 }).valid).toBe(true);
    expect((tool.inputSchema.properties as Record<string, unknown>).step).toMatchObject({ type: 'integer', minimum: 0 });
    for (const step of [-1, 0.5, Infinity, -Infinity, NaN, '1']) {
      expect(await executeTool('spice_ac_metrics', { ...base, step })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const step of [-1, 0.5, '1']) expect(input({ ...base, step }).valid).toBe(false);
    expect(await executeTool('spice_ac_metrics', { ...base, step: 2 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', details: { reason: 'UNKNOWN_STEP' } } } });
    const single = { ...base, request: request(deck('1k')) };
    expect((await executeTool('spice_ac_metrics', { ...single, step: 0 })).structuredContent).toEqual((await executeTool('spice_ac_metrics', single)).structuredContent);
    expect(await executeTool('spice_ac_metrics', { ...single, step: 1 })).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'UNKNOWN_STEP' } } } });
  });

  it('selects the analysis before looking up a step', async () => {
    const trace = (analysisIndex: number, index: number, magnitude: number) => ({
      type: 'ac' as const, analysisIndex, step: { index, parameter: 'R1', value: magnitude },
      frequencyHz: [1, 10, 100], currentPhasors: {},
      voltagePhasors: { out: [magnitude, magnitude / 2, magnitude / 10].map(magnitude => ({ magnitude, phaseDegrees: 0 })) },
    });
    const result: SimulationResultV1 = { status: 'complete', analyses: [trace(0, 0, 1), trace(0, 1, 2), trace(1, 1, 4)] };
    const run = (args: object) => executeTool('spice_ac_metrics', { request: stepped, output: 'out', ...args }, { simulate: async () => result });
    expect(await run({ step: 1 })).toMatchObject({ isError: true });
    expect(await run({ analysis: 0 })).toMatchObject({ isError: true });
    expect(await run({ analysis: 1, step: 0 })).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'UNKNOWN_STEP' } } } });
    const first = await run({ analysis: 0, step: 1 });
    const second = await run({ analysis: 1, step: 1 });
    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect((first.structuredContent as { dcGainDb: number }).dcGainDb).toBeCloseTo(20 * Math.log10(2), 12);
    expect((second.structuredContent as { dcGainDb: number }).dcGainDb).toBeCloseTo(20 * Math.log10(4), 12);
  });
});
