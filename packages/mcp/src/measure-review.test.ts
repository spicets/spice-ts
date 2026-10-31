import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { measureResult } from './measure.js';

describe('measurement selector review regressions', () => {
  const op: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'op', analysisIndex: 0, voltagesV: { 'N 1': 2, ref: 0.5 }, currentsA: { 'V,1': -0.002 } }] };
  it('preserves comma in current branch names', () => {
    expect(measureResult(op, [{ kind: 'avg', analysis: 0, signal: 'i(V,1)' }]).measurements).toEqual([{ value: -0.002, unit: 'A' }]);
  });
  it('preserves spaces inside voltage node names', () => {
    expect(measureResult(op, ['v(N 1)', 'v(N 1, ref)'].map(signal => ({ kind: 'avg', analysis: 0, signal }))).measurements).toEqual([{ value: 2, unit: 'V' }, { value: 1.5, unit: 'V' }]);
  });
  it('resolves literal comma-containing voltage names even without operand nodes', () => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'op', analysisIndex: 0, voltagesV: { 'N,1': 2 }, currentsA: {} }] };
    expect(measureResult(result, [{ kind: 'avg', analysis: 0, signal: 'v(n,1)' }]).measurements).toEqual([{ value: 2, unit: 'V' }]);
  });
  it('prefers a literal comma-containing name over differential operands', () => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'op', analysisIndex: 0, voltagesV: { 'N,1': 2, N: 5, '1': 1, ref: 3 }, currentsA: {} }] };
    const specs = ['v(N,1)', 'v(N,ref)'].map(signal => ({ kind: 'avg', analysis: 0, signal }));
    expect(measureResult(result, specs).measurements).toEqual([{ value: 2, unit: 'V' }, { value: 2, unit: 'V' }]);
  });
  it('cancels equivalent phasors without masking small differences', () => {
    const ac: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: [1, 2], currentPhasors: {}, voltagePhasors: {
      p: [1, 2].map(() => ({ magnitude: 1, phaseDegrees: 0 })),
      n: [1, 2].map(() => ({ magnitude: 1, phaseDegrees: 360 })),
      close: [1, 2].map(() => ({ magnitude: 1 - 1e-12, phaseDegrees: 360 })),
      tinyAngle: [1, 2].map(() => ({ magnitude: 1, phaseDegrees: -1e-12 })),
      halfTurn: [1, 2].map(() => ({ magnitude: 1, phaseDegrees: 180 })),
      negativeHalfTurn: [1, 2].map(() => ({ magnitude: 1, phaseDegrees: -180 })),
    } }] };
    const measurements = ['mag(v(p,n))', 'phase(v(p,n))', 'mag(v(p,close))', 'mag(v(p,tinyAngle))', 'mag(v(halfTurn,negativeHalfTurn))'].map(signal => ({ kind: 'avg', analysis: 0, signal }));
    const results = measureResult(ac, measurements).measurements;
    expect(results[0]).toEqual({ value: 0, unit: 'V' });
    expect(results[1]).toMatchObject({ error: { code: 'NON_FINITE_RESULT' } });
    expect(results[2]).toMatchObject({ value: expect.any(Number), unit: 'V' });
    expect((results[2] as { value: number }).value).toBeGreaterThan(0);
    expect((results[3] as { value: number }).value).toBeGreaterThan(0);
    expect(results[4]).toEqual({ value: 0, unit: 'V' });
  });
});
