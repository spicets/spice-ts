import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { measureResult } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';

const trace = (timeS: number[], values: number[]) => ({ status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS, voltagesV: { out: values }, currentsA: { V1: values } }] });
const item = { kind: 'totalVariation', signal: 'v(out)', analysis: 0 };

describe('transient total variation', () => {
  it('measures the clipped path length of a nonuniform triangle', () => {
    expect(measureResult(trace([0, 1, 3], [0, 2, -1]), [item, { ...item, from: 0.5, to: 2 }]).measurements).toEqual([
      { value: 5, unit: 'V' }, { value: 2.5, unit: 'V' },
    ]);
  });

  it('handles currents, constant signals, collinear samples and degenerate windows', () => {
    expect(measureResult(trace([0, 1, 3], [4, 3, 1]), [{ ...item, signal: 'i(v1)' }, { ...item, from: 1, to: 1 }]).measurements)
      .toEqual([{ value: 3, unit: 'A' }, { value: 0, unit: 'V' }]);
    expect(measureResult(trace([0, 1, 2], [7, 7, 7]), [item]).measurements[0]).toEqual({ value: 0, unit: 'V' });
    expect(measureResult(trace([0, 0.5, 1, 2, 3], [0, 1, 2, 0.5, -1]), [item]).measurements[0]).toEqual({ value: 5, unit: 'V' });
  });

  it('selects differential voltage and explicit steps with isolated errors', () => {
    const a = trace([0, 1, 3], [1, 3, 0]).analyses[0];
    const stepped = { status: 'complete' as const, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index }, voltagesV: { ...a.voltagesV, ref: [1, 1, 1] } })) };
    expect(measureResult(stepped, [item, { ...item, step: 1, signal: 'v(out,ref)' }, { ...item, step: 2 }, { ...item, step: 1, signal: 'v(missing)' }]).measurements)
      .toMatchObject([{ error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: 5, unit: 'V' }, { error: { code: 'UNKNOWN_STEP' } }, { error: { code: 'UNKNOWN_SIGNAL' } }]);
  });

  it('validates schema and window fields consistently', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    expect(validate({ request, measurements: [item] }).valid).toBe(true);
    for (const field of ['at', 'value', 'edge', 'referenceSignal']) {
      const invalid = { ...item, [field]: field === 'edge' ? 'rising' : field === 'referenceSignal' ? 'v(out)' : 1 };
      expect(validate({ request, measurements: [invalid] }).valid).toBe(false);
      expect(measureResult(trace([0, 1], [0, 1]), [invalid]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    const cases = [{ from: -1 }, { to: 4 }, { from: 2, to: 1 }, { from: Infinity }, { to: NaN }, { from: '0' }];
    expect(measureResult(trace([0, 1, 3], [0, 2, -1]), cases.map(v => ({ ...item, ...v }))).measurements)
      .toMatchObject(['OUT_OF_RANGE', 'OUT_OF_RANGE', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT'].map(code => ({ error: { code } })));
  });

  it('rejects AC and DC and nonfinite or unrepresentable data', () => {
    const analyses = [
      { type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} },
      { type: 'ac' as const, analysisIndex: 1, frequencyHz: [1, 2], voltagePhasors: {}, currentPhasors: {} },
    ];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...item, analysis: a.analysisIndex }))).measurements)
      .toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
    for (const values of [[0, Infinity], [-1e308, 1e308], [0, 1e308, 0]]) {
      expect(measureResult(trace(values.map((_, i) => i), values), [item]).measurements[0]).toMatchObject({ error: { code: 'NON_FINITE_RESULT' } });
    }
  });

  it('preserves clipped changes smaller than the DC offset spacing', () => {
    const result = measureResult(trace([0, 1], [1e16, 1e16 + 2]), [{ ...item, from: 0, to: 0.25 }]).measurements[0];
    expect(result).toEqual({ value: 0.5, unit: 'V' });
    expect(measureResult(trace([0, 1, 2], [1e16, 1e16 + 2, 1e16]), [{ ...item, from: 0.25, to: 1.75 }]).measurements[0])
      .toEqual({ value: 3, unit: 'V' });
  });

  it('preserves representable variation when the clipped fraction underflows', () => {
    const result = measureResult(trace([0, 1e308], [0, 1e308]), [{ ...item, from: 0, to: 1e-100 }]).measurements[0];
    expect(result).toHaveProperty('value');
    if ('value' in result) expect(result.value / 1e-100).toBeCloseTo(1, 14);
  });

  it('avoids intermediate overflow when clipping large values and times', () => {
    const result = measureResult(trace([-1e308, 1e308], [-1e308, 1e308]), [{ ...item, from: -5e307, to: 5e307 }]).measurements[0];
    expect(result).toHaveProperty('value');
    if ('value' in result) expect(result.value / 1e308).toBeCloseTo(1, 14);
  });

  it('measures a real transient through spice_measure', async () => {
    const source = '* variation\nV1 out 0 PWL(0 0 1m 2 3m -1)\nR1 out 0 1k\n.tran 10u 3m\n.end';
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source } }, measurements: [item] });
    expect(response.isError).not.toBe(true);
    const result = (response.structuredContent as { measurements: { value: number; unit: string }[] }).measurements[0];
    expect(result.unit).toBe('V');
    expect(result.value).toBeCloseTo(5, 9);
  });
});
