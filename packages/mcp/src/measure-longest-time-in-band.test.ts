import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { measureResult, measurementListSchema } from './measure.js';
import { executeTool } from './server.js';

const trace = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 3, 4, 5], voltagesV: { out: [0, 1, 1, 0, 1, 1] }, currentsA: {} }] };
const band = { kind: 'longestTimeInBand', signal: 'v(out)', analysis: 0, lower: 0.5, upper: 1.5 };

describe('longest transient time in band', () => {
  it('distinguishes the longest visit from the total of disjoint visits', () => {
    expect(measureResult(trace, [band, { ...band, kind: 'timeInBand' }]).measurements).toEqual([
      { value: 2, unit: 's' }, { value: 3.5, unit: 's' },
    ]);
  });
  it('measures a finite visit even when the full time span overflows', () => {
    const wide = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [-1e308, 1e308], voltagesV: { out: [0, 2] } }] };
    const result = measureResult(wide, [band, { ...band, kind: 'timeInBand' }, { ...band, lower: 0, upper: 2 }]).measurements;
    expect(result[0]).toEqual({ value: 1e308, unit: 's' });
    expect(result[1]).toEqual({ value: 1e308, unit: 's' });
    expect(result[2]).toMatchObject({ error: { code: 'NON_FINITE_RESULT' } });
  });

  it('handles clipping, irregular grids, direction changes and boundary contacts', () => {
    const irregular = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [0, 2, 3, 7, 8], voltagesV: { out: [0, 1, 0.5, 1, 0] } }] };
    const specs = [band, { ...band, from: 1.5, to: 7.5 }, { ...band, from: 3, to: 3 }, { ...band, lower: -1, upper: 2 }, { ...band, lower: 3, upper: 4 }];
    expect(measureResult(irregular, specs).measurements).toEqual([6.5, 6, 0, 8, 0].map(value => ({ value, unit: 's' })));
  });

  it('counts zero-width plateaus but not crossings, and separates excursions', () => {
    const flat = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [0, 1, 2, 3, 4, 5, 6], voltagesV: { out: [0, 1, 1, 2, 1, 1, 0] } }] };
    expect(measureResult(flat, [{ ...band, lower: 1, upper: 1 }, { ...band, lower: 1, upper: 2 }, { ...band, lower: 1.5, upper: 1.5 }]).measurements).toEqual([1, 4, 0].map(value => ({ value, unit: 's' })));
  });

  it('supports selectors and analysis and step selection', () => {
    const a = trace.analyses[0];
    const stepped = { ...trace, analyses: [0, 1].map(index => ({ ...a, analysisIndex: 2, step: { index, parameter: 'r', value: index }, voltagesV: { OUT: a.voltagesV.out, ref: [0, 0, 0, 0, 0, 0] }, currentsA: { V1: a.voltagesV.out } })) };
    expect(measureResult(stepped, ['V(oUt,REF)', 'I(v1)'].map(signal => ({ ...band, analysis: 2, step: 1, signal }))).measurements).toEqual([2, 2].map(value => ({ value, unit: 's' })));
    expect(measureResult(stepped, [{ ...band, analysis: 2 }, { ...band, analysis: 2, step: 5 }, { ...band, analysis: 9 }]).measurements).toMatchObject(['AMBIGUOUS_ANALYSIS', 'UNKNOWN_STEP', 'UNKNOWN_ANALYSIS'].map(code => ({ error: { code } })));
  });

  it('validates the exported schema and rejects invalid inputs and analyses', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(measurementListSchema);
    const { lower: _lower, ...missingLower } = band;
    const { upper: _upper, ...missingUpper } = band;
    const invalid = [missingLower, missingUpper, ...[NaN, Infinity, -Infinity].flatMap(n => [{ ...band, lower: n }, { ...band, upper: n }]), ...Object.entries({ at: 1, value: 1, edge: 'rising', occurrence: 1, trigger: {}, target: {}, referenceSignal: 'v(out)' }).map(([key, value]) => ({ ...band, [key]: value }))];
    expect(validate([band]).valid).toBe(true);
    for (const item of invalid) {
      expect(validate(JSON.parse(JSON.stringify([item]))).valid).toBe(false);
      expect(measureResult(trace, [item]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    expect(measureResult(trace, [{ ...band, lower: 2 }, { ...band, from: 2, to: 1 }, { ...band, from: -1 }, { ...band, to: 6 }]).measurements).toMatchObject(['INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'OUT_OF_RANGE', 'OUT_OF_RANGE'].map(code => ({ error: { code } })));
    const analyses = [{ type: 'dc' as const, analysisIndex: 1, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} }, { type: 'ac' as const, analysisIndex: 2, frequencyHz: [1], voltagePhasors: { out: [{ real: 1, imaginary: 0, magnitude: 1, phaseDegrees: 0 }] }, currentPhasors: {} }];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...band, analysis: a.analysisIndex }))).measurements).toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });

  it('preserves representable durations at extreme signal magnitudes', () => {
    const extreme = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [0, 1e100], voltagesV: { out: [0, 1e308] } }] };
    const result = measureResult(extreme, [{ ...band, lower: 0, upper: 1e-100 }]).measurements[0] as { value: number; unit: string };
    expect(result.unit).toBe('s');
    expect(result.value / 1e-308).toBeCloseTo(1, 12);
  });

  it('never returns a non-finite measurement', () => {
    const extreme = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [-1e308, 1e308], voltagesV: { out: [1, 1] } }] };
    expect(measureResult(extreme, [band]).measurements[0]).toMatchObject({ error: { code: 'NON_FINITE_RESULT' } });
  });

  it('works through the public measurement handler', async () => {
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source: '* constant\nV1 out 0 2\nR1 out 0 1k\n.tran 10u 1m\n.end' } }, measurements: [{ ...band, lower: 1, upper: 2, from: 0.0002, to: 0.0008 }] });
    expect(response.structuredContent).toEqual({ measurements: [{ value: 0.0006000000000000001, unit: 's' }] });
  });
});
