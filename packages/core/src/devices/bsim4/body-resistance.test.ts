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
    const failures: string[] = [];
    function check(actual: number, expected: number, label = '') {
      const abs = Math.abs(actual - expected), rel = abs / Math.max(Math.abs(expected), 1e-30);
      maxAbs = Math.max(maxAbs, abs); maxRel = Math.max(maxRel, rel);
      if (!(abs <= 1e-12 || rel <= 1e-6)) failures.push(`${label}: actual=${actual}, expected=${expected}, rel=${rel}`);
    }
    quantities.forEach((name, index) => {
      check(index < 7 ? result.dc!.voltage(name) : result.dc!.current(name), item.op[index]);
      const values = index < 7 ? result.ac!.voltage(name) : result.ac!.current(name);
      expect(values).toHaveLength(item.ac.length);
      item.ac.forEach((row, n) => {
        check(result.ac!.frequencies[n], row[0]);
        const phase = values[n].phase * Math.PI / 180;
        check(values[n].magnitude * Math.cos(phase), row[1 + 2 * index], `${name} real ${row[0]}`);
        check(values[n].magnitude * Math.sin(phase), row[2 + 2 * index], `${name} imag ${row[0]}`);
      });
    });
    console.info(`${item.deck}: ${JSON.stringify({ maxAbs, maxRel })}`);
    expect(failures).toEqual([]);
  });
  it('model RBODYMOD=1 overridden by instance zero keeps the baseline bit-identical', async () => {
    const baseline = readFileSync(new URL('model.cir', base), 'utf8').replace('rbodymod=1', 'rbodymod=0').replace('.ac dec 2 1k 1meg', '');
    const override = baseline.replace('rbodymod=0', 'rbodymod=1').replace('ad=1p as=2p', 'ad=1p as=2p rbodymod=0');
    const a = await simulate(baseline), b = await simulate(override);
    // Captured by running the identical deck through main a7b08165.
    expect(['Vd', 'Vg', 'Vs', 'Vb'].map(name => a.dc!.current(name))).toEqual([
      -0.0012519703350521944, 0, 0.0012519703338518989, 1.2002958130720102e-12,
    ]);
    expect(parse(override).compile().devices.find(d => d.name === 'M1')!.nodes).toHaveLength(4);
    for (const name of ['Vd', 'Vg', 'Vs', 'Vb']) expect(a.dc!.current(name)).toBe(b.dc!.current(name));
  });
  it('preserves explicit CF=0 legacy transient time/voltage/current samples', async () => {
    const deck = readFileSync(new URL('../rgatemod1/transient.cir', base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe('27e61e80595f94cbba04885602b292c2864072944abcd0f1819071cdbcda825d');
    const result = (await simulate(deck.replace('RSHG=1meg', 'RSHG=1meg CF=0'))).transient!;
    // Independently verified on git archive a7b08165: its omitted CF behaves
    // exactly as explicit CF=0. Use that same-runtime baseline on every platform
    // because libm last bits differ between macOS and Linux. No tolerance.
    const legacy = (await simulate(deck.replace('RSHG=1meg', 'RSHG=1meg CF=0 RBODYMOD=0'))).transient!;
    const vectors = [result.time, ...['d', 'g', 'M1.gate'].map(n => result.voltage(n)),
      ...['Vd', 'Vg'].map(n => result.current(n))];
    const legacyVectors = [legacy.time, ...['d', 'g', 'M1.gate'].map(n => legacy.voltage(n)),
      ...['Vd', 'Vg'].map(n => legacy.current(n))];
    expect(result.time).toHaveLength(1014);
    expect(vectors).toEqual(legacyVectors);
    // Retain the independently captured main golden on its original platform.
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(createHash('sha256').update(JSON.stringify(vectors)).digest('hex')).toBe('f82c26e941f88ce67a12a945519f1e2ecc7bf999ac1fb5d6d82225d53a1cfe32');
    }
  });
  it('supports the RGATEMOD=3 body transient combination', async () => {
    const deck = readFileSync(new URL('transient.cir', base), 'utf8')
      .replace(/RBODYMOD=1 CAPMOD=2/, 'RBODYMOD=1 CAPMOD=2 RGATEMOD=3');
    const result = (await simulate(deck)).transient!;
    expect(result.time.length).toBeGreaterThan(2);
    expect(Array.from(result.voltage('M1.midgate')).every(Number.isFinite)).toBe(true);
  });
  for (const selector of ['capmod=0', 'capmod=1', 'rbodymod=2', 'trnqsmod=1']) {
    it(`keeps unsupported body transient combination ${selector} structured`, () => {
      const deck = readFileSync(new URL('transient.cir', base), 'utf8')
        .replace(/RBODYMOD=1 CAPMOD=2/, selector.startsWith('rbodymod') ? selector : `RBODYMOD=1 ${selector}`);
      expect(() => parse(deck).compile()).toThrow(UnsupportedModelParameterError);
    });
  }
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
