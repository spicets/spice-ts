import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { acMetrics } from './ac-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const source = '* RC corner\nV1 in 0 DC 0 AC 2 30\nR1 in out 1k\nC1 out 0 1u\n.ac lin 1 159.15494309189535 159.15494309189535\n.end';
const request = { apiVersion: '1', input: { format: 'spice', source } };
const args = { request, output: 'out', input: 'in' };

describe('sampled complex transfer', () => {
  it('returns the RC corner transfer for a non-unit phased input at tool level', async () => {
    const result = await executeTool('spice_ac_metrics', { ...args, includeComplexTransfer: true });
    expect(result.isError).not.toBe(true);
    const values = (result.structuredContent as { complexTransfer: { frequencyHz: number; real: number; imaginary: number }[] }).complexTransfer;
    expect(values).toHaveLength(1);
    expect(values[0].real).toBeCloseTo(0.5, 10);
    expect(values[0].imaginary).toBeCloseTo(-0.5, 10);
  });

  it('preserves legacy output exactly and advertises strict schemas', async () => {
    const legacy = await executeTool('spice_ac_metrics', { ...args, frequenciesHz: [100, 1000] });
    const disabled = await executeTool('spice_ac_metrics', { ...args, frequenciesHz: [100, 1000], includeComplexTransfer: false });
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(legacy));
    const enabled = await executeTool('spice_ac_metrics', { ...args, frequenciesHz: [100, 1000], includeComplexTransfer: true });
    const { complexTransfer, ...rest } = enabled.structuredContent as Record<string, unknown>;
    expect(rest).toEqual(legacy.structuredContent);
    expect(complexTransfer).toHaveLength(1);
    const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    expect(input({ ...args, includeComplexTransfer: true }).valid).toBe(true);
    expect(input({ ...args, includeComplexTransfer: 'true' }).valid).toBe(false);
    expect(output(enabled.structuredContent).valid).toBe(true);
    expect(output({ ...rest, complexTransfer: [{ frequencyHz: 1, real: 1 }] }).valid).toBe(false);
    const malformed = await executeTool('spice_ac_metrics', { ...args, includeComplexTransfer: 'true' });
    expect(malformed).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('supports differential and ground selectors, wrapping, zero output and selected steps', () => {
    const ph = (magnitude: number, phaseDegrees = 0) => ({ magnitude, phaseDegrees });
    const trace = (analysisIndex: number, index: number, scale: number) => ({
      type: 'ac' as const, analysisIndex, step: { index, parameter: 'R', value: scale }, frequencyHz: [1, 2, 3], currentPhasors: {},
      voltagePhasors: {
        op: [ph(3 * scale, 179), ph(0), ph(2)], on: [ph(scale, 179), ph(0), ph(0)],
        ip: [ph(4, -179), ph(2), ph(2)], inn: [ph(2, -179), ph(0), ph(0)],
      },
    });
    const result: SimulationResultV1 = { status: 'complete', analyses: [trace(0, 0, 1), trace(1, 0, 1), trace(1, 1, 2)] };
    const m = acMetrics(result, { output: 'v(op,on)', input: 'v(ip,inn)', analysis: 1, step: 1, includeComplexTransfer: true });
    expect(m.complexTransfer).toHaveLength(3);
    expect(m.complexTransfer![0].real).toBeCloseTo(2 * Math.cos(-2 * Math.PI / 180), 12);
    expect(m.complexTransfer![0].imaginary).toBeCloseTo(2 * Math.sin(-2 * Math.PI / 180), 12);
    expect(m.complexTransfer![1]).toEqual({ frequencyHz: 2, real: 0, imaginary: 0 });
    const ground = acMetrics(result, { output: 'v(op,0)', input: 'v(ip,0)', analysis: 1, step: 0, includeComplexTransfer: true });
    expect(ground.complexTransfer![2].real).toBeCloseTo(1, 14);
    const absolute = acMetrics(result, { output: 'v(op,0)', analysis: 1, step: 0, includeComplexTransfer: true });
    expect(absolute.complexTransfer![2].real).toBeCloseTo(2, 14);
  });

  it('rejects zero input, nonrepresentable values, and excess samples', () => {
    const sample = (out: number, input: number, phaseDegrees = 0): SimulationResultV1 => ({ status: 'complete', analyses: [{
      type: 'ac', analysisIndex: 0, frequencyHz: [1], currentPhasors: {},
      voltagePhasors: { out: [{ magnitude: out, phaseDegrees }], input: [{ magnitude: input, phaseDegrees: 0 }] },
    }] });
    expect(() => acMetrics(sample(1, 0), { output: 'out', input: 'input', includeComplexTransfer: true })).toThrowError(expect.objectContaining({ details: { reason: 'UNDEFINED_TRANSFER' } }));
    expect(() => acMetrics(sample(1e308, 1e-308), { output: 'out', input: 'input', includeComplexTransfer: true })).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'UNDEFINED_TRANSFER' }) }));
    const count = 10001;
    const huge: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: Array.from({ length: count }, (_, i) => i + 1), currentPhasors: {}, voltagePhasors: { out: Array.from({ length: count }, () => ({ magnitude: 1, phaseDegrees: 0 })) } }] };
    expect(() => acMetrics(huge, { output: 'out', includeComplexTransfer: true })).toThrowError(expect.objectContaining({ details: { reason: 'TOO_MANY_COMPLEX_TRANSFER_SAMPLES' } }));
  });

  it('keeps extreme representable component values finite without overflowing their ratio', () => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: [1], currentPhasors: {}, voltagePhasors: {
      out: [{ magnitude: 1.7e308, phaseDegrees: 45 }], input: [{ magnitude: 0.8, phaseDegrees: 0 }],
    } }] };
    const m = acMetrics(result, { output: 'out', input: 'input', includeComplexTransfer: true });
    expect(m.complexTransfer![0].real / 1e308).toBeCloseTo(1.7 / 0.8 / Math.SQRT2, 12);
    expect(m.complexTransfer![0].imaginary / 1e308).toBeCloseTo(1.7 / 0.8 / Math.SQRT2, 12);
    expect(JSON.stringify(m)).not.toContain('null,null');
  });

});
