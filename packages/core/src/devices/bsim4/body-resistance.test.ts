import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';

const base = new URL('./__fixtures__/rbodymod1/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as {
  cases: { deck: string; sha256: string; op: number[]; ac: number[][] }[];
};
const quantities = ['d', 'g', 's', 'b', 'M1.dbody', 'M1.body', 'M1.sbody', 'Vd', 'Vg', 'Vs', 'Vb'];

describe('BSIM4 RBODYMOD=1', () => {
  for (const item of reference.cases) it(`${item.deck}: identical-deck ngspice-47 OP/AC`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
    const result = await simulate(deck);
    let maxAbs = 0, maxRel = 0;
    function check(actual: number, expected: number) {
      const abs = Math.abs(actual - expected), rel = abs / Math.max(Math.abs(expected), 1e-30);
      maxAbs = Math.max(maxAbs, abs); maxRel = Math.max(maxRel, rel);
      expect(abs <= 1e-12 || rel <= 1e-6, `actual=${actual}, expected=${expected}, rel=${rel}`).toBe(true);
    }
    quantities.forEach((name, index) => {
      check(index < 7 ? result.dc!.voltage(name) : result.dc!.current(name), item.op[index]);
      const values = index < 7 ? result.ac!.voltage(name) : result.ac!.current(name);
      expect(values).toHaveLength(item.ac.length);
      item.ac.forEach((row, n) => {
        check(result.ac!.frequencies[n], row[0]);
        check(values[n].re, row[1 + 2 * index]);
        check(values[n].im, row[2 + 2 * index]);
      });
    });
    console.info(`${item.deck}: ${JSON.stringify({ maxAbs, maxRel })}`);
  });
  it('model RBODYMOD=1 overridden by instance zero keeps the baseline bit-identical', async () => {
    const baseline = readFileSync(new URL('model.cir', base), 'utf8').replace('rbodymod=1', 'rbodymod=0').replace('.ac dec 2 1k 1meg', '');
    const override = baseline.replace('rbodymod=0', 'rbodymod=1').replace('ad=1p as=2p', 'ad=1p as=2p rbodymod=0');
    const a = await simulate(baseline), b = await simulate(override);
    expect(parse(override).compile().devices.find(d => d.name === 'M1')!.nodes).toHaveLength(4);
    for (const name of ['Vd', 'Vg', 'Vs', 'Vb']) expect(a.dc!.current(name)).toBe(b.dc!.current(name));
  });
  for (const location of ['model', 'instance']) {
    for (const value of [-1, 2, 3]) it(`rejects ${location} rbodymod=${value}`, () => {
      const deck = `Invalid body selector\n.model DUT NMOS level=54 ${location === 'model' ? `rbodymod=${value}` : ''}\nM1 d g 0 0 DUT ${location === 'instance' ? `rbodymod=${value}` : ''}\nVd d 0 1\nVg g 0 1\n.op\n.end`;
      expect(() => parse(deck).compile()).toThrow(UnsupportedModelParameterError);
    });
    for (const key of ['rbpb', 'rbpd', 'rbps', 'rbdb', 'rbsb']) for (const value of [0, -1]) {
      it(`rejects ${location} ${key}=${value}`, () => {
        const deck = `Invalid body resistance\n.model DUT NMOS level=54 rbodymod=1 ${location === 'model' ? `${key}=${value}` : ''}\nM1 d g 0 0 DUT ${location === 'instance' ? `${key}=${value}` : ''}\nVd d 0 1\nVg g 0 1\n.op\n.end`;
        expect(() => parse(deck).compile()).toThrow(InvalidCircuitError);
      });
    }
  }
});
