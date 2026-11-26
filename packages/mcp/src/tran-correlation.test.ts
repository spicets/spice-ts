import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { tranMetrics, tranMetricsArgs, type TranMetrics } from './tran-metrics.js';

describe('transient correlation', () => {
  it('accepts a reference signal and integrates a ramp exactly', () => {
    const x = [0, 0.4, 2, 3.5, 4];
    const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: x, voltagesV: { out: x, ref: x.map(t => 2 * t + 1) }, currentsA: {} }] };
    const args = tranMetricsArgs({ signal: 'v(out)', referenceSignal: 'v(ref)', settlingBandPercent: 99 });
    const metrics = tranMetrics(result, args);
    expect((metrics as TranMetrics).correlation!.covariance).toBeCloseTo(8 / 3, 12);
    expect((metrics as TranMetrics).correlation!.coefficient).toBeCloseTo(1, 12);
  });
  const times = [0, 0.4, 2, 3.5, 4];
  const make = (ref: number[], x = times, out = x): SimulationResultV1 => ({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: x, voltagesV: { out, ref, ground: x.map(() => 1) }, currentsA: { src: ref } }] });
  const run = (result: SimulationResultV1, extra: Record<string, unknown> = {}) => tranMetrics(result, tranMetricsArgs({ signal: 'v(out)', referenceSignal: 'v(ref)', settlingBandPercent: 99, ...extra }));
  it('handles signs, clipping, redundant knots and offsets', () => {
    for (const x of [times, [0, 1, 4]]) {
      for (const sign of [1, -1]) {
        const result = make(x.map(t => sign * 2 * t + 1), x);
        const m = run(result) as TranMetrics;
        expect(Math.abs(m.correlation!.covariance - sign * 8 / 3)).toBeLessThanOrEqual(1e-12);
        expect(m.correlation!.coefficient).toBeCloseTo(sign, 12);
        const clipped = run(result, { timeRangeS: [1, 3] }) as TranMetrics;
        expect(Math.abs(clipped.correlation!.covariance - sign * 2 / 3)).toBeLessThanOrEqual(1e-12);
      }
    }
  });
  it('integrates non-perfect piecewise-linear correlation analytically', () => {
    // x=t, r=0 for t<=2 and r=t-2 thereafter: E[xr]=5/3, E[x]E[r]=1.
    const x = [0, 2, 4];
    const m = run(make([0, 0, 2], x)) as TranMetrics;
    expect(Math.abs(m.correlation!.covariance - 2 / 3)).toBeLessThanOrEqual(1e-12);
    expect(m.correlation!.coefficient).toBeCloseTo(Math.sqrt(4 / 5), 12);
  });
  it('supports current and differential signals, steps and units', () => {
    const result = make(times.map(t => 2 * t + 1));
    result.analyses.push({ ...result.analyses[0], step: { index: 1, parameter: "R", value: 1 } } as typeof result.analyses[0]);
    const m = run(result, { signal: 'v(out,ground)', referenceSignal: 'i(src)', step: 1 }) as TranMetrics;
    expect(m.correlation).toMatchObject({ referenceSignal: 'i(src)', covarianceUnit: 'V*A' });
    expect(m.correlation!.covariance).toBeCloseTo(8 / 3, 12);
    const reverse = run(result, { signal: 'i(src)', referenceSignal: 'v(out,ground)', step: 1 }) as TranMetrics;
    expect(reverse.correlation!.covarianceUnit).toBe('A*V');
  });
  it('returns null for constant references while retaining legacy no-transition errors', () => {
    const result = make(times.map(() => 5));
    expect((run(result) as TranMetrics).correlation).toMatchObject({ covariance: 0, coefficient: null });
    expect(run(make(times, times, times.map(() => 1)))).toMatchObject({ error: { code: 'NO_TRANSITION' } });
    const legacy = tranMetrics(result, { signal: 'v(out)', settlingBandPercent: 99 });
    expect(legacy).not.toHaveProperty('correlation');
  });
  it('retains small changes on a large offset', () => {
    const x = [0, 1, 2, 3, 4];
    const result = make(x.map(t => 1e12 + 2 * t), x);
    const m = run(result) as TranMetrics;
    expect(m.correlation!.covariance).toBeCloseTo(8 / 3, 12);
    expect(m.correlation!.coefficient).toBeCloseTo(1, 12);
  });
  it('rejects missing, nonfinite, and misaligned references', () => {
    expect(run(make(times), { referenceSignal: 'v(missing)' })).toMatchObject({ error: { code: 'SIGNAL_NOT_FOUND' } });
    expect(run(make([0, 1, Infinity, 3, 4]))).toMatchObject({ error: { code: 'INVALID_DATA' } });
    expect(run(make([0, 1]))).toMatchObject({ error: { code: 'INVALID_DATA' } });
    for (const ref of ['', 1, 'x'.repeat(257)]) expect(() => tranMetricsArgs({ signal: 'v(out)', referenceSignal: ref })).toThrow();
  });
  it('rejects unrepresentable covariance instead of returning nonfinite output', () => {
    expect(run(make(times.map(t => t * 1e200), times, times.map(t => t * 1e200)))).toMatchObject({ error: { code: 'INVALID_DATA' } });
  });

});
