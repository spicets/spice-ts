import { describe, expect, it } from 'vitest';
import { measureResult } from './measure.js';

const result = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 3], voltagesV: { out: [0, 2, 0] }, currentsA: {} }] };
const slope = (at: number) => ({ kind: 'slope', signal: 'v(out)', analysis: 0, at });

describe('transient slope measurements', () => {
  it('uses the right-hand segment at knots and the left-hand final segment', () => {
    expect(measureResult(result, [0, 0.5, 1, 2, 3].map(slope)).measurements).toEqual([
      { value: 2, unit: 'V/s' }, { value: 2, unit: 'V/s' }, { value: -1, unit: 'V/s' },
      { value: -1, unit: 'V/s' }, { value: -1, unit: 'V/s' },
    ]);
  });

  it('handles constant and negative nonuniform ramps and redundant knots', () => {
    const trace = { ...result, analyses: [{ ...result.analyses[0], timeS: [0, 0.25, 1, 3], voltagesV: { out: [5, 4.5, 3, -1], flat: [3, 3, 3, 3] } }] };
    const measurements = [0, 0.25, 0.6, 1, 3].map(slope);
    const values = measureResult(trace, [...measurements, { ...slope(1), signal: 'v(flat)' }]).measurements;
    for (const entry of values.slice(0, 5)) {
      expect(entry).toHaveProperty('unit', 'V/s');
      expect(Math.abs((entry as { value: number }).value - (-2))).toBeLessThanOrEqual(1e-12);
    }
    expect(values[5]).toEqual({ value: 0, unit: 'V/s' });
  });

  it('validates clipped windows without changing the original knot segments', () => {
    const items = [
      { ...slope(1), from: 0.5, to: 1 }, { ...slope(0.5), from: 0.5, to: 2 },
      { ...slope(0.4), from: 0.5, to: 2 }, { ...slope(2.1), from: 0.5, to: 2 },
      { ...slope(1), from: -1 }, { ...slope(1), to: 4 }, { ...slope(1), from: 2, to: 1 },
      slope(-1), slope(4),
    ];
    expect(measureResult(result, items).measurements).toMatchObject([
      { value: -1 }, { value: 2 }, ...Array(4).fill({ error: { code: 'OUT_OF_RANGE' } }),
      { error: { code: 'INVALID_MEASUREMENT' } }, ...Array(2).fill({ error: { code: 'OUT_OF_RANGE' } }),
    ]);
  });

  it('selects differential voltage, current and step metadata', () => {
    const trace = (index: number, factor: number) => ({ type: 'tran' as const, analysisIndex: 2, step: { index, parameter: 'r', value: index }, timeS: [0, 1, 3], voltagesV: { a: [5, 7, 5].map(v => v * factor), b: [5, 5, 5].map(v => v * factor) }, currentsA: { v1: [0, -2, 0].map(v => v * factor) } });
    const data = { status: 'complete' as const, analyses: [trace(1, 2), trace(0, 1)] };
    const base = { kind: 'slope', analysis: 2, at: 0.5 };
    expect(measureResult(data, [
      { ...base, signal: 'v(a,b)', step: 1 }, { ...base, signal: 'i(v1)', step: 0 },
      { ...base, signal: 'v(a)', step: 3 }, { ...base, signal: 'v(a)' },
      { ...base, signal: 'v(missing)', step: 0 }, { ...base, signal: 'v(a)', analysis: 9 },
    ]).measurements).toMatchObject([
      { value: 4, unit: 'V/s' }, { value: -2, unit: 'A/s' }, { error: { code: 'UNKNOWN_STEP' } },
      { error: { code: 'AMBIGUOUS_ANALYSIS' } }, { error: { code: 'UNKNOWN_SIGNAL' } }, { error: { code: 'UNKNOWN_ANALYSIS' } },
    ]);
  });

  it('rejects invalid fields and non-transient analyses', () => {
    const invalid = [undefined, null, '1', NaN, Infinity, -Infinity].map(at => ({ ...slope(1), at }));
    invalid.push(...[{ value: 1 }, { edge: 'rising' }, { occurrence: 1 }, { referenceSignal: 'v(out)' }, { trigger: {} }, { target: {} }, { unknown: 1 }].map(extra => ({ ...slope(1), ...extra })));
    expect(measureResult(result, invalid).measurements).toMatchObject(invalid.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
    const dc = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} }] };
    const op = { status: 'complete' as const, analyses: [{ type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} }] };
    for (const data of [dc, op]) expect(measureResult(data, [slope(0)]).measurements).toMatchObject([{ error: { code: 'INVALID_MEASUREMENT' } }]);
  });

  it('rejects insufficient samples and nonfinite arithmetic', () => {
    const trace = (x: number[], y: number[]) => ({ ...result, analyses: [{ ...result.analyses[0], timeS: x, voltagesV: { out: y } }] });
    expect(measureResult(trace([0], [1]), [slope(0)]).measurements).toMatchObject([{ error: { code: 'INVALID_MEASUREMENT' } }]);
    for (const data of [trace([0, 1], [-1e308, 1e308]), trace([0, 1e-308], [0, 1e308]), trace([0, 1], [0, Infinity]), trace([-1e308, 1e308], [0, 1])]) {
      expect(measureResult(data, [slope(0)]).measurements).toMatchObject([{ error: { code: 'NON_FINITE_RESULT' } }]);
    }
  });
});
