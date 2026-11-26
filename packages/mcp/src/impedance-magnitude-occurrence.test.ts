import { describe, expect, it } from 'vitest';
import { impedanceArgs, impedanceReport } from './impedance.js';

const port = { positive: 'in', negative: '0' };
const run = (occurrence: number) => impedanceReport({ frequencyHz: [1, 2, 3, 4, 5], positive: [1, 3, 1, 3, 1].map(magnitude => ({ magnitude, phaseDegrees: 0 })), negative: [1, 2, 3, 4, 5].map(() => ({ magnitude: 0, phaseDegrees: 0 })) }, impedanceArgs({ port, sweep: { variation: 'lin', points: 5, startFreq: 1, stopFreq: 5 }, magnitudeLevelsOhm: [2], magnitudeCrossingOccurrence: occurrence })).magnitudeCrossings![0].frequencyHz;

describe('magnitude crossing occurrence', () => {
  it('selects each crossing in traversal order', () => {
    expect([1, 2, 3, 4, 5].map(run)).toEqual([1.5, 2.5, 3.5, 4.5, null]);
  });
});

const trace = (frequencies: number[], magnitudes: number[], levels: number[], occurrence?: number, direction?: 'rising' | 'falling' | 'either', variation: 'lin' | 'dec' | 'oct' = 'lin') => {
  const spectrum = { frequencyHz: frequencies, positive: magnitudes.map(magnitude => ({ magnitude, phaseDegrees: 0 })), negative: magnitudes.map(() => ({ magnitude: 0, phaseDegrees: 0 })) };
  const selectors = { port, sweep: { type: 'ac' as const, variation, points: frequencies.length, startFreq: Math.min(...frequencies), stopFreq: Math.max(...frequencies) }, magnitudeLevelsOhm: levels, magnitudeCrossingOccurrence: occurrence, magnitudeCrossingDirection: direction, reactanceLevelsOhm: [0], phaseLevelsDeg: [0] };
  return impedanceReport(spectrum, selectors);
};

describe('occurrence edge cases', () => {
  const f = [1, 2, 3, 4, 5];
  const m = [1, 3, 1, 3, 1];
  it('filters direction before independently counting each level, preserving duplicates and absent levels', () => {
    expect(trace(f, m, [2, 2.5, 2, 4], 2, 'rising').magnitudeCrossings).toEqual([
      { magnitudeOhm: 2, frequencyHz: 3.5 }, { magnitudeOhm: 2.5, frequencyHz: 3.75 }, { magnitudeOhm: 2, frequencyHz: 3.5 }, { magnitudeOhm: 4, frequencyHz: null },
    ]);
  });
  it('counts in descending traversal order', () => {
    expect(trace([5, 4, 3, 2, 1], m, [2], 2, 'rising').magnitudeCrossings![0].frequencyHz).toBe(2.5);
    expect(trace([5, 4, 3, 2, 1], m, [2], 2, 'falling').magnitudeCrossings![0].frequencyHz).toBe(1.5);
  });
  it.each(['dec', 'oct'] as const)('interpolates %s crossings in log frequency', variation => {
    const result = trace([1, 4, 16, 64, 256], m, [2], 3, undefined, variation).magnitudeCrossings![0].frequencyHz!;
    expect(Math.abs(result - 32)).toBeLessThanOrEqual(1e-12);
  });
  it('coalesces exact knots and plateaus into one hit per run', () => {
    const frequencies = [1, 2, 3, 4, 5, 6, 7, 8];
    const values = [1, 2, 2, 1, 2, 3, 2, 1];
    const get = (n: number, d?: 'rising' | 'falling') => trace(frequencies, values, [2], n, d).magnitudeCrossings![0].frequencyHz;
    expect([1, 2, 3, 4].map(n => get(n))).toEqual([2, 5, 7, null]);
    expect([1, 2, 3].map(n => get(n, 'rising'))).toEqual([2, 5, null]);
    expect([1, 2, 3].map(n => get(n, 'falling'))).toEqual([3, 7, null]);
    expect(trace([1, 2, 3], [2, 2, 2], [2], 2).magnitudeCrossings![0].frequencyHz).toBeNull();
  });
  it('preserves the complete default output and other crossing families', () => {
    const implicit = trace(f, m, [2]);
    const explicit = trace(f, m, [2], 1);
    expect(JSON.stringify(implicit)).toBe(JSON.stringify(explicit));
    const later = trace(f, m, [2], 3);
    expect(later.phaseCrossings).toEqual(implicit.phaseCrossings);
    expect(later.reactanceCrossings).toEqual(implicit.reactanceCrossings);
  });
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 129, null, '2'])('rejects invalid occurrence %s', occurrence => {
    expect(() => impedanceArgs({ port, magnitudeLevelsOhm: [2], magnitudeCrossingOccurrence: occurrence })).toThrow();
  });
  it('requires magnitude levels and accepts the upper bound', () => {
    expect(() => impedanceArgs({ port, magnitudeCrossingOccurrence: 1 })).toThrow();
    expect(impedanceArgs({ port, magnitudeLevelsOhm: [2], magnitudeCrossingOccurrence: 128 }).magnitudeCrossingOccurrence).toBe(128);
  });
});
