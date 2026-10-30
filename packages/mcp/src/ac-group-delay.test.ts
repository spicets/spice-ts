import { describe, expect, it } from 'vitest';
import { executeTool, MCP_TOOLS } from './server.js';
import { acMetrics, acMetricsArgs } from './ac-metrics.js';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

function sweep(frequencyHz: number[], outPhase: (f: number) => number, inPhase: (f: number) => number = () => 0): SimulationResultV1 {
  const wrap = (phaseDegrees: number) => ((phaseDegrees + 180) % 360 + 360) % 360 - 180;
  return { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz, currentPhasors: {}, voltagePhasors: {
    out: frequencyHz.map(f => ({ magnitude: 1, phaseDegrees: wrap(outPhase(f)) })),
    in: frequencyHz.map(f => ({ magnitude: 1, phaseDegrees: wrap(inPhase(f)) })),
  } }] };
}

function diagnostic(fn: () => unknown, reason: string) {
  try { fn(); throw new Error('Expected a diagnostic'); } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', retryable: false, details: { reason } });
  }
}

describe('AC group delay', () => {
  it('matches analytic RC delay on a dense simulated sweep', async () => {
    const source = '* RC group delay\nV1 in 0 AC 2\nR1 in out 1k\nC1 out 0 1u\n.ac dec 200 1 100k\n.end';
    for (const frequency of [10, 100, 1000]) {
      const response = await executeTool('spice_ac_metrics', {
        request: { apiVersion: '1', input: { format: 'spice', source } },
        output: 'out', input: 'in', groupDelayAtHz: frequency,
      });
      expect(response.isError).not.toBe(true);
      const actual = (response.structuredContent as { groupDelaySeconds: number }).groupDelaySeconds;
      const expected = 0.001 / (1 + (2 * Math.PI * frequency * 0.001) ** 2);

      expect(Math.abs(actual / expected - 1)).toBeLessThan(0.01);
    }
  });

  it('unwraps a constant delay and subtracts common input phase', () => {
    const frequencies = Array.from({ length: 101 }, (_, i) => 100 + i * 50);
    const delay = 0.0003;
    const common = (f: number) => -360 * f * 0.0002;
    const result = sweep(frequencies, f => common(f) - 360 * f * delay, common);
    for (const f of [100, 175, 2550, 5100]) {
      const actual = acMetrics(result, { output: 'out', input: 'in', groupDelayAtHz: f }).groupDelaySeconds!;

      expect(Math.abs(actual - delay)).toBeLessThan(1e-9);
    }
    expect(acMetrics(result, { output: 'out' })).not.toHaveProperty('groupDelaySeconds');
    expect(acMetrics(result, { output: 'out', groupDelayAtHz: 2550 }).groupDelaySeconds).toBeCloseTo(0.0005, 10);
  });

  it('interpolates sampled derivatives in linear frequency and uses one-sided endpoint differences', () => {
    const result = sweep([1, 2, 4], f => -f * f);
    const delay = (f: number) => acMetrics(result, { output: 'out', groupDelayAtHz: f }).groupDelaySeconds!;
    expect(delay(1)).toBeCloseTo(3 / 360, 12);
    expect(delay(2)).toBeCloseTo(5 / 360, 12);
    expect(delay(3)).toBeCloseTo(5.5 / 360, 12);
    expect(delay(4)).toBeCloseTo(6 / 360, 12);
  });

  it('rejects invalid frequency and insufficient samples with typed diagnostics', () => {
    const result = sweep([1, 10], () => 0);
    for (const frequency of [0, -1, NaN, Infinity, -Infinity]) {
      diagnostic(() => acMetricsArgs({ output: 'out', groupDelayAtHz: frequency }), 'INVALID_GROUP_DELAY_FREQUENCY');
      diagnostic(() => acMetrics(result, { output: 'out', groupDelayAtHz: frequency }), 'INVALID_GROUP_DELAY_FREQUENCY');
    }
    for (const frequency of [0.5, 11]) diagnostic(() => acMetrics(result, { output: 'out', groupDelayAtHz: frequency }), 'GROUP_DELAY_OUT_OF_RANGE');
    diagnostic(() => acMetrics(sweep([1], () => 0), { output: 'out', groupDelayAtHz: 1 }), 'INSUFFICIENT_GROUP_DELAY_POINTS');
  });

  it('rejects invalid and zero phasors instead of reporting a fabricated delay', () => {
    for (const node of ['out', 'in'] as const) for (const field of ['magnitude', 'phaseDegrees'] as const) {
      const result = sweep([1, 10], () => 0);
      const analysis = result.analyses[0];
      if (analysis.type !== 'ac') throw new Error('expected AC result');
      analysis.voltagePhasors[node][0][field] = NaN;
      diagnostic(() => acMetrics(result, { output: 'out', input: 'in', groupDelayAtHz: 1 }), 'UNDEFINED_TRANSFER');
    }
    const result = sweep([1, 10], () => 0);
    const analysis = result.analyses[0];
    if (analysis.type !== 'ac') throw new Error('expected AC result');
    analysis.voltagePhasors.out[0].magnitude = 0;
    diagnostic(() => acMetrics(result, { output: 'out', groupDelayAtHz: 1 }), 'UNDEFINED_TRANSFER');
  });

  it('advertises and validates optional request and response fields', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const args = { request: { apiVersion: '1', input: { format: 'spice', source: '* test\nV1 out 0 AC 1\n.ac dec 10 1 100\n.end' } }, output: 'out', groupDelayAtHz: 5 };
    expect(input(args).valid).toBe(true);
    expect(input({ ...args, groupDelayAtHz: 0 }).valid).toBe(false);
    const response = await executeTool('spice_ac_metrics', args);
    expect(response.isError).not.toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    const invalid = await executeTool('spice_ac_metrics', { ...args, groupDelayAtHz: 500 });
    expect(invalid).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', details: { reason: 'GROUP_DELAY_OUT_OF_RANGE' } } } });
    expect(output(invalid.structuredContent).valid).toBe(true);
  });
});
