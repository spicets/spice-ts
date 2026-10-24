import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

describe('BSIM4 grounded-channel Gear gate charge (#1367)', () => {
  const errors: Record<string, number> = {};
  beforeAll(async () => {
    const base = new URL('./__fixtures__/grounded-channel/', import.meta.url);
    const deck = readFileSync(new URL('transient.cir', base), 'utf8');
    const reference = JSON.parse(readFileSync(new URL('transient-ngspice-47.json', base), 'utf8')) as {
      sha256: string; grid: number[]; signals: Record<string, number[]>;
    };
    expect(createHash('sha256').update(deck).digest('hex')).toBe(reference.sha256);
    const actual = (await simulate(deck)).transient!;
    expect(actual.time.at(-1)).toBeCloseTo(800e-12, 20);
    for (const [signal, expected] of Object.entries(reference.signals)) {
      const values = signal === 'Vdrive' ? actual.current(signal) : actual.voltage(signal);
      const peak = Math.max(...expected.map(Math.abs), signal === 'Vdrive' ? 1e-12 : 1e-4);
      let maxError = 0, j = 0;
      for (let i = 0; i < reference.grid.length; i++) {
        const t = reference.grid[i];
        while (j + 1 < actual.time.length - 1 && actual.time[j + 1] < t) j++;
        const weight = (t - actual.time[j]) / (actual.time[j + 1] - actual.time[j]);
        const value = values[j] + weight * (values[j + 1] - values[j]);
        expect(Number.isFinite(value)).toBe(true);
        maxError = Math.max(maxError, Math.abs(value - expected[i]) / peak);
      }
      errors[signal] = maxError;
    }
    console.info(`Grounded-channel peak-normalized errors: ${JSON.stringify(errors)}`);
  });
  // Unchanged corpus-f/g 1% peak-normalized gate, including its signal floors.
  it.each(['gate', 'sense', 'Vdrive'])('matches ngspice-47 %s within the shared 1% bound', signal => {
    expect(errors[signal]).toBeLessThanOrEqual(0.01);
  });
});
