import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { measureResult, measurementListSchema } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';

const trace = (timeS: number[], values: number[]) => ({ status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS, voltagesV: { out: values }, currentsA: { V1: values } }] });
const item = { kind: 'absInteg', signal: 'i(V1)', analysis: 0 };

describe('absolute transient integral', () => {
  it('integrates zero-crossing triangles without signed cancellation', () => {
    expect(measureResult(trace([0, 1, 3], [-2, 2, -2]), [item, { ...item, from: 0.5, to: 2 }, { ...item, kind: 'integ' }]).measurements).toEqual([
      { value: 3, unit: 'A*s' }, { value: 1.5, unit: 'A*s' }, { value: 0, unit: 'A*s' },
    ]);
  });

  it('handles asymmetric crossings, signs, flat signals, and explicit zeros', () => {
    // -1 to +3 over 4 seconds crosses after 1 second: 1/2 + 9/2 = 5.
    for (const [samples, expected] of [ [[-1, 3], 5], [[1, 3], 8], [[-1, -3], 8], [[-2, -2], 8], [[0, 0], 0], [[0, -2], 4], [[2, 0], 4] ] as [number[], number][]) {
      expect(measureResult(trace([0, 4], samples), [item]).measurements[0]).toEqual({ value: expected, unit: 'A*s' });
    }
    expect(measureResult(trace([0, 1, 4], [-1, 0, 3]), [item]).measurements[0]).toEqual({ value: 5, unit: 'A*s' });
    expect(measureResult(trace([0, 2, 4], [-1, 1, 3]), [item]).measurements[0]).toEqual({ value: 5, unit: 'A*s' });
  });

  it('supports voltage, differential voltage, zero windows, steps and isolated errors', () => {
    const base = trace([0, 1, 3], [-2, 2, -2]);
    const a = base.analyses[0];
    const result = { ...base, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index }, voltagesV: { out: a.voltagesV.out.map(v => v + 1), ref: [1, 1, 1] }, currentsA: { V1: a.currentsA.V1.map(v => v * (index + 1)) } })) };
    expect(measureResult(result, [
      item, { ...item, step: 1 }, { ...item, signal: 'v(out,ref)', step: 0 },
      { ...item, signal: 'v(ref)', step: 0 }, { ...item, step: 0, from: 1, to: 1 },
      { ...item, step: 2 }, { ...item, step: 0, from: -1 }, { ...item, step: 0, to: 4 },
      { ...item, step: 0, signal: 'i(missing)' },
    ]).measurements).toMatchObject([
      { error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: 6, unit: 'A*s' }, { value: 3, unit: 'V*s' },
      { value: 3, unit: 'V*s' }, { value: 0, unit: 'A*s' }, { error: { code: 'UNKNOWN_STEP' } },
      { error: { code: 'OUT_OF_RANGE' } }, { error: { code: 'OUT_OF_RANGE' } }, { error: { code: 'UNKNOWN_SIGNAL' } },
    ]);
    expect(measureResult(trace([0, 1], [1, NaN]), [item]).measurements).toMatchObject([{ error: { code: 'NON_FINITE_RESULT' } }]);
    expect(measureResult(trace([0, Infinity], [1, 2]), [item]).measurements).toMatchObject([{ error: { code: 'NON_FINITE_RESULT' } }]);
  });

  it('rejects OP, DC and AC analyses', () => {
    const analyses = [
      { type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} },
      { type: 'dc' as const, analysisIndex: 1, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} },
      { type: 'ac' as const, analysisIndex: 2, frequencyHz: [1], voltagePhasors: {}, currentPhasors: {} },
    ];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...item, analysis: a.analysisIndex }))).measurements).toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });

  it('advertises and validates the public schema', () => {
    expect(measurementListSchema.items.properties.kind.enum).toContain('absInteg');
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    expect(validate({ request, measurements: [item] }).valid).toBe(true);
    expect(validate({ request, measurements: [{ ...item, occurrence: 1 }] }).valid).toBe(false);
    expect(measureResult(trace([0, 1], [1, 2]), [{ ...item, occurrence: 1 }]).measurements).toMatchObject([{ error: { code: 'INVALID_MEASUREMENT' } }]);
  });

  it('measures the sampled current of a PWL source through the public tool', async () => {
    const source = '* Original current throughput circuit\nI1 0 in PWL(0 -2m 1m 2m 3m -2m)\nV1 in out 0\nR1 out 0 1k\n.tran 10u 3m\n.end';
    const request = { apiVersion: '1', input: { format: 'spice', source } };
    const sim = await executeTool('spice_simulate', { request });
    const analysis = (sim.structuredContent as unknown as SimulationResultV1).analyses[0];
    expect(analysis.type).toBe('tran');
    if (analysis.type !== 'tran') throw new Error('Expected transient');
    const current = Object.entries(analysis.currentsA).find(([key]) => key.toLowerCase() === 'v1')![1];
    expect(current[0]).toBeCloseTo(-0.002, 12);
    expect(Math.max(...current)).toBeGreaterThan(0.0019);
    let expected = 0;
    for (let i = 1; i < current.length; i++) {
      const a = current[i - 1]; const b = current[i]; const dt = analysis.timeS[i] - analysis.timeS[i - 1];
      if (a * b < 0) {
        const crossing = dt * Math.abs(a) / (Math.abs(a) + Math.abs(b));
        expected += (Math.abs(a) * crossing + Math.abs(b) * (dt - crossing)) / 2;
      } else expected += dt * (Math.abs(a) + Math.abs(b)) / 2;
    }
    const measured = await executeTool('spice_measure', { request, measurements: [item] });
    expect(measured.isError).not.toBe(true);
    const result = (measured.structuredContent as { measurements: { value: number; unit: string }[] }).measurements[0];

    expect(result.unit).toBe('A*s');
    expect(Math.abs(result.value - expected)).toBeLessThanOrEqual(1e-12);
  });
});
