import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const base = new URL('./__fixtures__/lod/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('dynamic-ngspice-47.json', base), 'utf8')) as {
  cases: { deck: string; sha256: string; points: number[][] }[];
};

describe('BSIM4 dynamic length-of-diffusion stress', () => {
  for (const item of reference.cases) it(`${item.deck}: identical-deck ngspice-47 v(out)`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
    const result = await simulate(deck);
    if (item.deck === 'ac.cir') {
      const actual = result.ac!.voltage('out');
      expect(actual).toHaveLength(item.points.length);
      let maxMagnitudeRelative = 0, maxPhaseRelative = 0;
      item.points.forEach(([frequency, real, imag], n) => {
        expect(result.ac!.frequencies[n] / frequency).toBeCloseTo(1, 12);
        const magnitude = Math.hypot(real, imag);
        const phase = Math.atan2(imag, real) * 180 / Math.PI;
        maxMagnitudeRelative = Math.max(maxMagnitudeRelative, Math.abs(actual[n].magnitude / magnitude - 1));
        const difference = Math.abs(((actual[n].phase - phase + 540) % 360) - 180);
        maxPhaseRelative = Math.max(maxPhaseRelative, difference / Math.abs(phase));
      });
      expect(maxMagnitudeRelative).toBeLessThanOrEqual(1e-6);
      expect(maxPhaseRelative).toBeLessThanOrEqual(1e-6);
      console.info(`LOD AC maxMagnitudeRelative=${maxMagnitudeRelative} maxPhaseRelative=${maxPhaseRelative}`);
    } else {
      const actual = result.transient!;
      const values = actual.voltage('out');
      const peak = Math.max(...item.points.map(row => Math.abs(row[1])), 1e-4);
      expect(actual.time[0]).toBeLessThanOrEqual(item.points[0][0]);
      expect(actual.time.at(-1)!).toBeGreaterThanOrEqual(item.points.at(-1)![0]);
      let j = 0, maxPeakError = 0, maxAbsolute = 0;
      for (const [time, expected] of item.points) {
        while (j + 1 < actual.time.length - 1 && actual.time[j + 1] < time) j++;
        const weight = (time - actual.time[j]) / (actual.time[j + 1] - actual.time[j]);
        const value = values[j] + weight * (values[j + 1] - values[j]);
        expect(Number.isFinite(value)).toBe(true);
        maxAbsolute = Math.max(maxAbsolute, Math.abs(value - expected));
        maxPeakError = Math.max(maxPeakError, Math.abs(value - expected) / peak);
      }
      // Existing charge.test.ts / corpus-f bound, not a circuit-specific tolerance.
      expect(maxPeakError).toBeLessThanOrEqual(0.01);
      console.info(`LOD TRAN maxPeakError=${maxPeakError} maxAbsolute=${maxAbsolute}`);
    }
  });
  for (const analysis of ['ac', 'tran']) for (const parameter of ['SCA', 'SCB', 'SCC', 'SC']) {
    it(`keeps ${parameter} WPE rejected in ${analysis}`, async () => {
      const deck = readFileSync(new URL(`${analysis}.cir`, base), 'utf8')
        .replace('NF=2', `NF=2 ${parameter}=1e-6`);
      await expect(simulate(deck)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_PARAMETER' });
    });
  }
});
