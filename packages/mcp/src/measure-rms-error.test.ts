import { describe, expect, it } from 'vitest';
import { measureResult, measurementListSchema } from './measure.js';
import { executeTool } from './server.js';

const transient = {
  status: 'complete' as const,
  analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 0.5, 3], voltagesV: { out: [2, 2.5, 5], ref: [2, 2, 2] }, currentsA: { a: [2, 2.5, 5], b: [2, 2, 2] } }],
};
const spec = { kind: 'rmsError', analysis: 0, signal: 'v(out)', referenceSignal: 'v(ref)' };

describe('transient RMS tracking error', () => {
  it('integrates a nonuniform linear error and interpolates window boundaries', () => {
    const values = measureResult(transient, [spec, { ...spec, from: 0.25, to: 2 }, { ...spec, referenceSignal: 'v(out)' }, { ...spec, signal: 'v(ref)', referenceSignal: 'v(0)' }, { ...spec, signal: 'i(a)', referenceSignal: 'i(b)' }]).measurements;
    const expected = [Math.sqrt(3), Math.sqrt((0.25 ** 2 + 0.25 * 2 + 2 ** 2) / 3), 0, 2, Math.sqrt(3)];
    values.forEach((result, index) => {
      expect(result).toHaveProperty('value');
      if ('value' in result) {
        expect(Math.abs(result.value - expected[index])).toBeLessThanOrEqual(1e-12);
        expect(result.unit).toBe(index === 4 ? 'A' : 'V');
      }
    });
  });

  it('reuses differential, ground, case-insensitive and literal selectors', () => {
    const a = transient.analyses[0];
    const input = { ...transient, analyses: [{ ...a, voltagesV: { ...a.voltagesV, 'out,ref': [7, 7, 7] } }] };
    const results = measureResult(input, [
      { ...spec, signal: 'V(OUT,REF)', referenceSignal: 'v(0)' },
      { ...spec, signal: 'v(out,0)', referenceSignal: 'v(REF)' },
      { ...spec, signal: 'v(ref,OUT)', referenceSignal: 'v(0)' },
    ]).measurements;
    expect(results[0]).toEqual({ value: 7, unit: 'V' });
    for (const result of results.slice(1)) {
      expect(result).toHaveProperty('value');
      if ('value' in result) expect(Math.abs(result.value - Math.sqrt(3))).toBeLessThanOrEqual(1e-12);
    }
  });

  it('reports independent invalid fields, selections and windows', () => {
    const a = transient.analyses[0];
    const stepped = { ...transient, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index } })) };
    const cases = [spec, { ...spec, step: 1 }, { ...spec, step: 2 }, { ...spec, analysis: 4, step: 0 }];
    expect(measureResult(stepped, cases).measurements).toMatchObject([
      { error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: Math.sqrt(3) }, { error: { code: 'UNKNOWN_STEP' } }, { error: { code: 'UNKNOWN_ANALYSIS' } },
    ]);
    const invalid = [
      { ...spec, referenceSignal: undefined }, { ...spec, referenceSignal: '' }, { ...spec, referenceSignal: 4 },
      { ...spec, signal: 'v(missing)' }, { ...spec, referenceSignal: 'v(missing)' }, { ...spec, referenceSignal: 'i(a)' },
      { ...spec, from: -1 }, { ...spec, to: 4 }, { ...spec, from: 2, to: 1 }, { ...spec, from: 1, to: 1 },
      { ...spec, at: 1 }, { ...spec, value: 1 }, { ...spec, edge: 'rising' },
      { ...spec, kind: 'rms' },
    ];
    const codes = ['INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'UNKNOWN_SIGNAL', 'UNKNOWN_SIGNAL', 'INVALID_MEASUREMENT', 'OUT_OF_RANGE', 'OUT_OF_RANGE', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT'];
    expect(measureResult(transient, invalid).measurements).toMatchObject(codes.map(code => ({ error: { code } })));
  });

  it('rejects invalid samples and descending time', () => {
    const a = transient.analyses[0];
    const variants = [
      { ...a, timeS: [3, 0.5, 0] },
      { ...a, voltagesV: { ...a.voltagesV, ref: [2, NaN, 2] } },
      { ...a, voltagesV: { ...a.voltagesV, ref: [2, 2] } },
      { ...a, voltagesV: { ...a.voltagesV, out: [2, Infinity, 5] } },
    ];
    const results = variants.map(analysis => measureResult({ ...transient, analyses: [analysis] }, [spec]).measurements[0]);
    expect(results).toMatchObject(['INVALID_MEASUREMENT', 'NON_FINITE_RESULT', 'NON_FINITE_RESULT', 'NON_FINITE_RESULT'].map(code => ({ error: { code } })));
  });

  it('rejects AC and DC analyses', () => {
    const analyses = [
      { type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} },
      { type: 'ac' as const, analysisIndex: 1, frequencyHz: [1, 2], voltagePhasors: {}, currentPhasors: {} },
    ];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...spec, analysis: a.analysisIndex }))).measurements)
      .toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });


  it('exposes the schema and measures a real transient through the tool', async () => {
    expect(measurementListSchema.items.properties.kind.enum).toContain('rmsError');
    expect(measurementListSchema.items.properties.referenceSignal).toMatchObject({ type: 'string', minLength: 1 });
    const response = await executeTool('spice_measure', {
      request: { apiVersion: '1', input: { format: 'spice', source: '* RMS error parity\nV1 out 0 3\nV2 ref 0 1\nR1 out 0 1k\nR2 ref 0 1k\n.tran 10u 1m\n.end' } },
      measurements: [spec],
    });
    expect(response.isError).not.toBe(true);
    const result = (response.structuredContent as { measurements: { value: number; unit: string }[] }).measurements[0];
    expect(result.unit).toBe('V');
    expect(Math.abs(result.value - 2)).toBeLessThanOrEqual(1e-12);
  });

});
