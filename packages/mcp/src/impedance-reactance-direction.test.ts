import { describe, expect, it } from 'vitest';
import { impedanceArgs, impedanceReport } from './impedance.js';
import { executeTool } from './server.js';

const port = { positive: 'in', negative: '0' };
const run = (frequencyHz: number[], x: number[], levels: number[], direction?: string, variation: 'lin' | 'dec' | 'oct' = 'lin') => impedanceReport({ frequencyHz, positive: x.map(v => ({ magnitude: Math.abs(v), phaseDegrees: v < 0 ? -90 : 90 })), negative: x.map(() => ({ magnitude: 0, phaseDegrees: 0 })) }, impedanceArgs({ port, sweep: { variation, points: 3, startFreq: 10, stopFreq: 100 }, reactanceLevelsOhm: levels, ...(direction === undefined ? {} : { reactanceCrossingDirection: direction }) }));

describe('directional reactance crossings', () => {
  it('selects the first segment in the requested direction and preserves duplicates and missing levels', () => {
    const frequencies = [10, 20, 30]; const values = [-2, 2, -2];
    expect(run(frequencies, values, [0], 'rising').reactanceCrossings).toEqual([{ reactanceOhm: 0, frequencyHz: 15 }]);
    expect(run(frequencies, values, [0, 3, 0], 'falling').reactanceCrossings).toEqual([{ reactanceOhm: 0, frequencyHz: 25 }, { reactanceOhm: 3, frequencyHz: null }, { reactanceOhm: 0, frequencyHz: 25 }]);
    expect(run(frequencies, values, [0, 2])).toEqual(run(frequencies, values, [0, 2], 'either'));
  });
  it('uses sweep traversal order even when frequency descends', () => {
    expect(run([30, 20, 10], [-2, 2, -2], [0], 'rising').reactanceCrossings![0].frequencyHz).toBe(25);
    expect(run([30, 20, 10], [-2, 2, -2], [0], 'falling').reactanceCrossings![0].frequencyHz).toBe(15);
  });
  it.each(['dec', 'oct'] as const)('interpolates %s crossings logarithmically', variation => {
    expect(run([10, 100, 1000], [-2, 2, -2], [0], 'rising', variation).reactanceCrossings![0].frequencyHz).toBeCloseTo(Math.sqrt(1000), 10);
    expect(run([10, 100, 1000], [-2, 2, -2], [0], 'falling', variation).reactanceCrossings![0].frequencyHz).toBeCloseTo(Math.sqrt(100000), 10);
  });
  it('accepts non-flat exact endpoints but not flat plateaus or single points', () => {
    expect(run([10, 20, 30], [2, 2, 3], [2], 'rising').reactanceCrossings![0].frequencyHz).toBe(20);
    expect(run([10, 20, 30], [3, 2, 2], [2], 'falling').reactanceCrossings![0].frequencyHz).toBe(20);
    expect(run([10, 20], [2, 3], [2], 'rising').reactanceCrossings![0].frequencyHz).toBe(10);
    for (const direction of ['rising', 'falling']) {
      expect(run([10, 20, 30], [2, 2, 2], [2], direction).reactanceCrossings![0].frequencyHz).toBeNull();
      expect(run([10], [2], [2], direction).reactanceCrossings![0].frequencyHz).toBeNull();
    }
    expect(run([10, 20], [2, 2], [2], 'either').reactanceCrossings![0].frequencyHz).toBe(10);
  });
  it('interpolates extreme finite reactances and frequencies without overflow', () => {
    for (const variation of ['lin', 'dec'] as const) {
      const result = run([1e-300, 1e300], [-1e308, 1e308], [0], 'rising', variation).reactanceCrossings![0].frequencyHz!;
      expect(Math.abs(result / (variation === 'lin' ? 5e299 : 1) - 1)).toBeLessThan(1e-12);
    }
  });
  it.each([{ reactanceCrossingDirection: 'up', reactanceLevelsOhm: [0] }, { reactanceCrossingDirection: null, reactanceLevelsOhm: [0] }, { reactanceCrossingDirection: 'either' }])('rejects invalid direction or missing levels %#', async options => {
    const response = await executeTool('spice_impedance', { request: { apiVersion: '1', input: { format: 'spice', source: '* resistor\nR1 in 0 10\n.ac lin 2 10 20\n.end' } }, port, ...options });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
});
