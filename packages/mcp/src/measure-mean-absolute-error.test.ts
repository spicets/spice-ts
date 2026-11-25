import { describe, expect, it } from 'vitest';
import { measureResult, measurementListSchema } from './measure.js';
import { executeTool } from './server.js';

const transient = {
  status: 'complete' as const,
  analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 0.5, 3], voltagesV: { out: [-1, -0.5, 2], ref: [0, 0, 0], offset: [2, 2, 2] }, currentsA: { a: [-1, -0.5, 2], b: [0, 0, 0] } }],
};
const spec = { kind: 'meanAbsoluteError', analysis: 0, signal: 'v(out)', referenceSignal: 'v(ref)' };

describe('transient mean absolute tracking error', () => {
  it('integrates a signed crossing rather than cancelling it', () => {
    const result = measureResult(transient, [spec]).measurements[0];
    expect(result).toHaveProperty('value');
    if ('value' in result) expect(Math.abs(result.value - 5 / 6)).toBeLessThanOrEqual(1e-12);
  });
  it('handles constant offset, identical signals, nonuniform samples and clipped windows', () => {
    const results = measureResult(transient, [
      { ...spec, signal: 'v(offset)' }, { ...spec, referenceSignal: 'v(out)' },
      { ...spec, from: 0.25, to: 2 }, { ...spec, signal: 'i(a)', referenceSignal: 'i(b)' },
      { ...spec, signal: 'v(out,ref)', referenceSignal: 'v(0)' },
    ]).measurements;
    const expected = [2, 0, 25 / 56, 5 / 6, 5 / 6];
    results.forEach((result, index) => {
      expect(result).toHaveProperty('value');
      if ('value' in result) {
        expect(Math.abs(result.value - expected[index])).toBeLessThanOrEqual(1e-12);
        expect(result.unit).toBe(index === 3 ? 'A' : 'V');
      }
    });
  });

  it('selects steps and rejects invalid references, units and windows', () => {
    const a = transient.analyses[0];
    const stepped = { ...transient, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index } })) };
    expect(measureResult(stepped, [spec, { ...spec, step: 1 }, { ...spec, step: 2 }]).measurements)
      .toMatchObject([{ error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: 5 / 6 }, { error: { code: 'UNKNOWN_STEP' } }]);
    const cases = [
      { ...spec, referenceSignal: undefined }, { ...spec, referenceSignal: '' }, { ...spec, referenceSignal: 4 },
      { ...spec, referenceSignal: 'v(missing)' }, { ...spec, referenceSignal: 'i(a)' },
      { ...spec, from: -1 }, { ...spec, to: 4 }, { ...spec, from: 2, to: 1 }, { ...spec, from: 1, to: 1 },
      { ...spec, at: 1 }, { ...spec, value: 1 }, { ...spec, edge: 'rising' }, { ...spec, kind: 'avg' },
    ];
    const codes = ['INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'UNKNOWN_SIGNAL', 'INVALID_MEASUREMENT', 'OUT_OF_RANGE', 'OUT_OF_RANGE', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT'];
    expect(measureResult(transient, cases).measurements).toMatchObject(codes.map(code => ({ error: { code } })));
  });

  it('rejects nonfinite and misaligned data and invalid transient axes', () => {
    const a = transient.analyses[0];
    const variants = [
      { ...a, timeS: [3, 0.5, 0] },
      { ...a, voltagesV: { ...a.voltagesV, ref: [0, NaN, 0] } },
      { ...a, voltagesV: { ...a.voltagesV, ref: [0, 0] } },
      { ...a, voltagesV: { ...a.voltagesV, out: [0, Infinity, 0] } },
    ];
    expect(variants.map(analysis => measureResult({ ...transient, analyses: [analysis] }, [spec]).measurements[0]))
      .toMatchObject(['INVALID_MEASUREMENT', 'NON_FINITE_RESULT', 'NON_FINITE_RESULT', 'NON_FINITE_RESULT'].map(code => ({ error: { code } })));
  });

  it('rejects non-transient analyses', () => {
    const analyses = [
      { type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} },
      { type: 'ac' as const, analysisIndex: 1, frequencyHz: [1, 2], voltagePhasors: {}, currentPhasors: {} },
    ];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...spec, analysis: a.analysisIndex }))).measurements)
      .toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });

  it('exposes the schema and measures a real core transient through the public tool', async () => {
    expect(measurementListSchema.items.properties.kind.enum).toContain('meanAbsoluteError');
    const response = await executeTool('spice_measure', {
      request: { apiVersion: '1', input: { format: 'spice', source: '* MAE test\nV1 out 0 3\nV2 ref 0 1\nR1 out 0 1k\nR2 ref 0 1k\n.tran 10u 1m\n.end' } },
      measurements: [spec],
    });
    expect(response.isError).not.toBe(true);
    const result = (response.structuredContent as { measurements: { value: number; unit: string }[] }).measurements[0];
    expect(result.unit).toBe('V');
    expect(Math.abs(result.value - 2)).toBeLessThanOrEqual(1e-12);
  });
});
