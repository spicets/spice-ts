import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const base = new URL('./__fixtures__/rgatemod2/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as {
  cases: { deck: string; sha256: string; op: number[]; dc: number[][]; ac: number[][] }[];
};
const quantities = ['d', 'g', 's', 'b', 'M1.gate', 'Vdd', 'Vg', 'Vs', 'Vb'];

describe('BSIM4 RGATEMOD=2', () => {
  for (const item of reference.cases) it(`${item.deck}: identical-deck ngspice-47 OP/DC/AC`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
    const result = await simulate(deck);
    const errors = { op: 0, dc: 0, ac: 0 };
    const absolute = { op: 0, dc: 0, ac: 0 };
    function check(actual: number, expected: number, analysis: keyof typeof errors, label: string) {
      const abs = Math.abs(actual - expected), rel = abs / Math.max(Math.abs(expected), 1e-30);
      errors[analysis] = Math.max(errors[analysis], rel);
      absolute[analysis] = Math.max(absolute[analysis], abs);
      expect(abs <= 1e-12 || rel <= 1e-6, `${analysis} ${label}: actual=${actual}, expected=${expected}, rel=${rel}`).toBe(true);
    }
    quantities.forEach((name, index) => {
      check(index < 5 ? result.dc!.voltage(name) : result.dc!.current(name), item.op[index], 'op', name);
      const dc = index < 5 ? result.dcSweep!.voltage(name) : result.dcSweep!.current(name);
      expect(dc).toHaveLength(item.dc.length);
      item.dc.forEach((row, n) => check(dc[n], row[index + 1], 'dc', `${name} ${row[0]}`));
      const ac = index < 5 ? result.ac!.voltage(name) : result.ac!.current(name);
      expect(ac).toHaveLength(item.ac.length);
      item.ac.forEach((row, n) => {
        check(result.ac!.frequencies[n], row[0], 'ac', 'frequency');
        const phase = ac[n].phase * Math.PI / 180;
        check(ac[n].magnitude * Math.cos(phase), row[1 + 2 * index], 'ac', `${name} real ${row[0]}`);
        check(ac[n].magnitude * Math.sin(phase), row[2 + 2 * index], 'ac', `${name} imag ${row[0]}`);
      });
    });
    console.info(`${item.deck}: max relative ${JSON.stringify(errors)}, max absolute ${JSON.stringify(absolute)}`);
  });
  it('rejects RGATEMOD=2 transient with a structured error', async () => {
    const deck = readFileSync(new URL('nmos.cir', base), 'utf8').replace('.ac dec 3 1k 1g', '.tran 1n 10n');
    await expect(simulate(deck)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_PARAMETER' });
  });
  it('rejects RGATEMOD=3 with a structured error', async () => {
    const deck = readFileSync(new URL('nmos.cir', base), 'utf8').replaceAll('RGATEMOD=2', 'RGATEMOD=3');
    await expect(simulate(deck)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_PARAMETER' });
  });
});
