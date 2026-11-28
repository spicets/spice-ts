import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool, MCP_TOOLS } from './server.js';
import { acMetrics } from './ac-metrics.js';

const frequencies = [10, 20, 30, 40];
const delay = 0.001;
const synthetic = (magnitudes = [1, 1, 1, 1], phases = frequencies.map(f => -360 * f * delay)): SimulationResultV1 => ({
  status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: frequencies, currentPhasors: {},
    voltagePhasors: { out: magnitudes.map((magnitude, i) => ({ magnitude, phaseDegrees: phases[i] })) } }],
});
const request = { apiVersion: '1', input: { format: 'spice', source: '* RC\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 100 1 10k\n.end' } };
const args = { request, output: 'out', input: 'in' };

describe('batch group delay', () => {
  it('matches an independent constant-delay transfer at knots and between them, preserving order', () => {
    const query = [40, 25, 10, 25, 30];
    const result = acMetrics(synthetic(), { output: 'out', groupDelayFrequenciesHz: query });
    expect(result.groupDelays?.map(x => x.frequencyHz)).toEqual(query);
    for (const point of result.groupDelays!) expect(point.delaySeconds).toBeCloseTo(delay, 14);
  });
  it('returns deterministic null reasons for out-of-range, zeros and ambiguous 180-degree steps', () => {
    const zero = acMetrics(synthetic([1, 0, 1, 1]), { output: 'out', groupDelayFrequenciesHz: [5, 10, 40, 50] });
    expect(zero.groupDelays).toEqual([
      { frequencyHz: 5, delaySeconds: null, reason: 'OUT_OF_RANGE' },
      { frequencyHz: 10, delaySeconds: null, reason: 'UNDEFINED_PHASE' },
      { frequencyHz: 40, delaySeconds: expect.any(Number) },
      { frequencyHz: 50, delaySeconds: null, reason: 'OUT_OF_RANGE' },
    ]);
    const ambiguous = acMetrics(synthetic([1, 1, 1, 1], [0, 180, 170, 160]), { output: 'out', groupDelayFrequenciesHz: [10, 40] });
    expect(ambiguous.groupDelays?.[0]).toEqual({ frequencyHz: 10, delaySeconds: null, reason: 'UNDEFINED_PHASE' });
    expect(ambiguous.groupDelays?.[1].delaySeconds).toBeCloseTo(1 / 360, 14);
  });
  it('agrees with scalar results on a real RC deck and preserves default output', async () => {
    const base = await executeTool('spice_ac_metrics', args);
    const scalar = await executeTool('spice_ac_metrics', { ...args, groupDelayAtHz: 123 });
    const batch = await executeTool('spice_ac_metrics', { ...args, groupDelayAtHz: 123, groupDelayFrequenciesHz: [123, 100, 123] });
    expect(base.isError).not.toBe(true); expect(batch.isError).not.toBe(true);
    expect(base.structuredContent).not.toHaveProperty('groupDelays');
    expect(scalar.structuredContent).not.toHaveProperty('groupDelays');
    const b = batch.structuredContent as { groupDelaySeconds: number; groupDelays: { delaySeconds: number }[] };
    expect(b.groupDelaySeconds).toBe((scalar.structuredContent as { groupDelaySeconds: number }).groupDelaySeconds);
    expect(b.groupDelays[0].delaySeconds).toBe(b.groupDelaySeconds);
    expect(b.groupDelays[2].delaySeconds).toBe(b.groupDelaySeconds);
  });
  it('validates inputs and output and performs one adapter simulation', async () => {
    const simulate = vi.fn(async () => synthetic());
    const response = await executeTool('spice_ac_metrics', { request, output: 'out', groupDelayFrequenciesHz: [10, 15, 40, 100] }, { simulate });
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(response.isError).not.toBe(true);
    const tool = MCP_TOOLS.find(x => x.name === 'spice_ac_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    const output = validator.getValidator(tool.outputSchema!);
    expect(output(response.structuredContent).valid).toBe(true);
    const invalidOutput = { ...response.structuredContent, groupDelays: [{ frequencyHz: 10, delaySeconds: null }] };
    expect(output(invalidOutput).valid).toBe(false);
    expect((await executeTool('spice_ac_metrics', { request, output: 'out', groupDelayFrequenciesHz: Array(128).fill(10) }, { simulate })).isError).not.toBe(true);
    for (const value of [[], [0], [-1], [NaN], [Infinity], Array(129).fill(1)]) {
      expect((await executeTool('spice_ac_metrics', { ...args, groupDelayFrequenciesHz: value })).isError).toBe(true);
    }
  });
});
