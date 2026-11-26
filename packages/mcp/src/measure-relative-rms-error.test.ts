import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { measureResult } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';

const transient = {
  status: 'complete' as const,
  analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 0.5, 3], voltagesV: { out: [2, 4, 6], ref: [1, 2, 3] }, currentsA: { a: [-2, -4, -6], b: [-1, -2, -3] } }],
};
const spec = { kind: 'relativeRmsError', analysis: 0, signal: 'v(out)', referenceSignal: 'v(ref)' };

describe('relative RMS tracking error', () => {
  it('measures scaled, equal, constant and signed differential signals on an uneven grid', () => {
    const analysis = transient.analyses[0];
    const input = { ...transient, analyses: [{ ...analysis, voltagesV: { ...analysis.voltagesV, three: [3, 3, 3], two: [2, 2, 2] } }] };
    const results = measureResult(input, [spec, { ...spec, signal: 'v(ref)' }, { ...spec, signal: 'v(three)', referenceSignal: 'v(two)' }, { ...spec, signal: 'v(ref,out)' }, { ...spec, signal: 'i(a)', referenceSignal: 'i(b)' }]).measurements;
    expect(results).toEqual([1, 0, 0.5, 2, 1].map(value => ({ value, unit: '1' })));
  });

  it('interpolates both reference and error at clipped boundaries', () => {
    const a = transient.analyses[0];
    const input = { ...transient, analyses: [{ ...a, voltagesV: { out: [2, 2.5, 5], ref: [2, 2, 2] } }] };
    const result = measureResult(input, [{ ...spec, from: 0.25, to: 2 }]).measurements[0];
    expect(result).toHaveProperty('unit', '1');
    if ('value' in result) expect(result.value).toBeCloseTo(Math.sqrt((0.25 ** 2 + 0.25 * 2 + 2 ** 2) / 3) / 2, 14);
    else throw new Error('Expected a value');
    expect(measureResult(transient, [{ ...spec, from: 0.25, to: 2 }]).measurements[0]).toEqual({ value: 1, unit: '1' });
  });

  it.each([1e150, 1e-150, 1e200, 1e-200])('avoids squared intermediate overflow or underflow at scale %s', scale => {
    const a = transient.analyses[0];
    const input = { ...transient, analyses: [{ ...a, voltagesV: { out: a.voltagesV.out.map(x => x * scale), ref: a.voltagesV.ref.map(x => x * scale) } }] };
    const result = measureResult(input, [spec]).measurements[0];
    expect(result).toHaveProperty('unit', '1');
    if ('value' in result) expect(result.value).toBeCloseTo(1, 14);
    else throw new Error('Expected a value');
  });

  it('handles opposite signed signals near the finite limit', () => {
    const input = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1], voltagesV: { out: [-1e308, -1e308], ref: [1e308, 1e308] }, currentsA: {} }] };
    expect(measureResult(input, [spec]).measurements[0]).toEqual({ value: 2, unit: '1' });
  });

  it('selects the requested step and rejects zero reference, zero duration and unknown signals', () => {
    const a = transient.analyses[0];
    const input = { ...transient, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index } })) };
    const results = measureResult(input, [spec, { ...spec, step: 1 }, { ...spec, step: 1, referenceSignal: 'v(0)' }, { ...spec, step: 1, from: 1, to: 1 }, { ...spec, step: 1, signal: 'v(missing)' }, { ...spec, step: 1, referenceSignal: 'v(missing)' }, { ...spec, step: 2 }]).measurements;
    expect(results).toMatchObject([{ error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: 1, unit: '1' }, ...['INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'UNKNOWN_SIGNAL', 'UNKNOWN_SIGNAL', 'UNKNOWN_STEP'].map(code => ({ error: { code } }))]);
  });

  it('rejects nonfinite data and non-transient analyses', () => {
    const a = transient.analyses[0];
    for (const voltagesV of [{ ...a.voltagesV, ref: [1, NaN, 3] }, { ...a.voltagesV, out: [2, Infinity, 6] }]) {
      expect(measureResult({ ...transient, analyses: [{ ...a, voltagesV }] }, [spec]).measurements[0]).toMatchObject({ error: { code: 'NON_FINITE_RESULT' } });
    }
    const dc = { type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [1, 2], ref: [1, 2] }, currentsA: {} };
    expect(measureResult({ status: 'complete', analyses: [dc] }, [spec]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
  });

  it('advertises matching validation and measures a real simulation', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_measure')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* relative RMS\nV1 out 0 3\nV2 ref 0 2\nR1 out 0 1k\nR2 ref 0 1k\n.tran 10u 1m\n.end' } };
    expect(input({ request, measurements: [spec] }).valid).toBe(true);
    for (const invalid of [{ ...spec, referenceSignal: undefined }, ...[{ at: 1 }, { value: 1 }, { edge: 'rising' }, { occurrence: 1 }, { trigger: {} }, { target: {} }].map(extra => ({ ...spec, ...extra }))]) {
      expect(input({ request, measurements: [invalid] }).valid).toBe(false);
      expect(measureResult(transient, [invalid]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    const response = await executeTool('spice_measure', { request, measurements: [spec] });
    expect(response.isError).not.toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    expect(response.structuredContent).toMatchObject({ measurements: [{ value: 0.5, unit: '1' }] });
  });
});
