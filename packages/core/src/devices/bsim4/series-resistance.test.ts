import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { UnsupportedModelParameterError } from '../../errors.js';

const base = new URL('./__fixtures__/series-resistance/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as {
  cases: { deck: string; sha256: string; quantities: string[]; op: number[]; points: number[][] }[];
};

describe('BSIM4 RSH with explicitly given NRD/NRS', () => {
  for (const item of reference.cases) it(`${item.deck}: identical-deck ngspice-47 OP/DC`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
    const device = parse(deck).compile().devices.find(d => d.name === 'M1')!;
    expect(device.nodes).toHaveLength(item.quantities.length - 4);
    const result = await simulate(deck);
    let maxAbs = 0, maxRel = 0, maxIdRel = 0, maxInternalRel = 0;
    const failures: string[] = [];
    function check(actual: number, expected: number, label: string) {
      const abs = Math.abs(actual - expected), rel = abs / Math.max(Math.abs(expected), 1e-30);
      maxAbs = Math.max(maxAbs, abs); maxRel = Math.max(maxRel, rel);
      if (label.endsWith('Vd')) maxIdRel = Math.max(maxIdRel, rel);
      if (label.includes('M1.') && Math.abs(expected) > 1e-12) maxInternalRel = Math.max(maxInternalRel, rel);
      if (!(abs <= 1e-12 || rel <= 1e-6)) failures.push(`${label}: ${actual} != ${expected}, rel=${rel}`);
    }
    item.quantities.forEach((name, index) => {
      const current = name.startsWith('V');
      check(current ? result.dc!.current(name) : result.dc!.voltage(name), item.op[index], `OP ${name}`);
      const values = current ? result.dcSweep!.current(name) : result.dcSweep!.voltage(name);
      expect(values).toHaveLength(item.points.length);
      item.points.forEach((row, n) => check(values[n], row[index], `DC ${n} ${name}`));
    });
    if (item.deck === 'symmetric.cir') {
      expect(result.dc!.voltage('M1.drain')).toBeLessThan(result.dc!.voltage('d') - 1e-3);
      expect(result.dc!.voltage('M1.source')).toBeGreaterThan(1e-3);
    }
    expect(maxIdRel).toBeLessThanOrEqual(1e-6);
    expect(maxInternalRel).toBeLessThanOrEqual(1e-6);
    console.info(`${item.deck}: ${JSON.stringify({ maxAbs, maxRel, maxIdRel, maxInternalRel })}`);
    expect(failures).toEqual([]);
  });
  for (const analysis of ['.tran 1n 10n', '.ac dec 1 1k 1meg']) it(`guards unvalidated series analysis ${analysis}`, () => {
    const deck = readFileSync(new URL('symmetric.cir', base), 'utf8').replace('\n.op\n', `\n${analysis}\n`);
    expect(() => parse(deck).compile()).toThrow(UnsupportedModelParameterError);
  });
});
