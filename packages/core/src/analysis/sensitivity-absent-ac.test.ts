import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const fixture = new URL('../../../../benchmarks/corpus/corpus-j/fixtures/spicelib/examples/testfiles/sens_ngspice_rawtest.net', import.meta.url);

describe('.sens AC without explicit AC excitation (#1633)', () => {
  it('solves unchanged corpus-j j-19 and matches the shared ngspice-47 vectors', async () => {
    const result = (await simulate(await readFile(fixture, 'utf8'))).sensitivity!;
    expect(result.frequencies).toHaveLength(31);
    expect(result.entries).toHaveLength(7);
    // ngspice-47, original bytes, -b -r: v(v1_acmag) = 0.49999999999965333;
    // v(r1_ac), v(r1_m), v(r1_scale), v(r2_ac), v(r2_m), v(r2_scale) = 0.
    // Model/other instance parameter vectors are outside the bounded public slice.
    for (const entry of result.entries) {
      expect(entry.ac).toHaveLength(31);
      for (const value of entry.ac!) {
        expect(value.real).toBeCloseTo(entry.parameter === 'acMagnitude' ? 0.49999999999965333 : 0, 9);
        expect(value.imaginary).toBe(0);
      }
    }
  });

  it.each(['V1 in 0 2', 'V1 in 0 PWL 0 0 1 1', 'V1 in 0 DC 2 AC 0'])(
    'retains the zero-magnitude derivative for %s', async source => {
      const result = (await simulate(`absent AC\n${source}\nR1 in out 1k\nR2 out 0 1k\n.sens V(out) AC LIN 1 100 100\n.end`)).sensitivity!;
      expect(result.entries.find(entry => entry.device === 'V1')?.ac![0].real).toBeCloseTo(0.5, 9);
    },
  );

  it('retains the absent current-source magnitude derivative', async () => {
    const result = (await simulate('absent current AC\nI1 0 out DC 1m\nR1 out 0 1k\n.sens V(out) AC LIN 1 100 100\n.end')).sensitivity!;
    expect(result.entries.find(entry => entry.device === 'I1' && entry.parameter === 'acMagnitude')?.ac![0].real).toBeCloseTo(1000, 6);
  });

  it('still rejects unsupported parameter derivatives with nonzero excitation', async () => {
    const input = (await readFile(fixture, 'utf8')).replace('PWL 0 0 1 1', 'AC 1');
    await expect(simulate(input)).rejects.toThrow(/M1.*outside the bounded slice/);
  });
});
