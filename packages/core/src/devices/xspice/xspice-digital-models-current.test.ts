import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
const reference = JSON.parse(readFileSync(new URL('./digital-models-ngspice47.json', import.meta.url), 'utf8')) as {
  sha256: string;
  samples: number[][];
};

const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/xspice/original-examples/digital_models.deck', import.meta.url), 'utf8');

function interpolate(samples: readonly (readonly number[])[], time: number, column: number): number {
  let i = 1;
  while (i < samples.length - 1 && samples[i][0] < time) i++;
  const a = samples[i - 1];
  const b = samples[i];
  return a[column] + (b[column] - a[column]) * (time - a[0]) / (b[0] - a[0]);
}

describe('digital_models.deck ngspice-47 parity (#1706)', () => {
  it('matches i(v1) within 1% of reference peak on the unchanged deck', async () => {
    expect(createHash('sha256').update(deck).digest('hex')).toBe(reference.sha256);
    const tran = (await simulate(deck)).transient!;
    const peak = Math.max(...reference.samples.map(row => Math.abs(row[2])));
    const actual = tran.current('v1');
    const errors = tran.time.map((time, i) => Math.abs(actual[i] - interpolate(reference.samples, time, 2)) / peak);
    expect(Math.max(...errors)).toBeLessThanOrEqual(0.01);
    // Check the reverse grid too, so skipping the short pulse cannot pass.
    const candidate = tran.time.map((time, i) => [time, actual[i]]);
    const reverse = reference.samples.map(row => Math.abs(interpolate(candidate, row[0], 1) - row[2]) / peak);
    expect(Math.max(...reverse)).toBeLessThanOrEqual(0.01);
  });
});
