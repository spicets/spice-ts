import { describe, expect, it } from 'vitest';
import { dcMetricsResult } from './dc-metrics.js';

const trace = {
  status: 'complete' as const,
  analyses: [{ type: 'dc' as const, analysisIndex: 0,
    axis: { name: 'Vin', unit: 'V' as const, values: [0, 1, 2, 3, 4, 5] },
    voltagesV: { out: [5, 4.8, 4.4, 0.6, 0.2, 0] }, currentsA: {} }],
};

describe('DC metric sweep direction', () => {
  it('gives the same transfer metrics for a reversed inverter sweep', () => {
    const a = trace.analyses[0];
    const reversed = { ...trace, analyses: [{ ...a,
      axis: { ...a.axis, values: [...a.axis.values].reverse() },
      voltagesV: { out: [...a.voltagesV.out].reverse() },
    }] };
    const before = structuredClone(reversed);
    const ascending = dcMetricsResult(trace, { sweptSource: 'Vin', output: 'v(out)' });
    const descending = dcMetricsResult(reversed, { sweptSource: 'Vin', output: 'v(out)' });
    for (const key of ['voh', 'vol', 'vil', 'vih', 'nmL', 'nmH', 'switchingThreshold'] as const) {
      expect(descending[key].value).not.toBeNull();
      expect(Math.abs(descending[key].value! - ascending[key].value!)).toBeLessThanOrEqual(1e-12);
    }
    for (const key of ['value', 'input', 'sweepPoint'] as const) {
      expect(Math.abs(descending.gainMax[key]! - ascending.gainMax[key]!)).toBeLessThanOrEqual(1e-12);
    }
    expect(reversed).toEqual(before);
  });
});
