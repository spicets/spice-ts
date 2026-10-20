import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { resolveVBICParams } from './vbic.js';
import { resolveVBICTemperature } from './vbic-temperature.js';

const reference = JSON.parse(readFileSync(new URL('../../../../benchmarks/vbic-resistor-temperature/ngspice-47.json', import.meta.url), 'utf8')) as {
  version: string; rows: { deck: string; currents: number[] }[];
};
describe('VBIC resistor temperature exponents (#1526)', () => {
  it.each(reference.rows.map((row, i) => ({ ...row, i })))('matches ngspice-47 case $i', async ({ deck, currents }) => {
    expect(reference.version).toBe('ngspice-47');
    const result = (await simulate(deck)).dc!;
    ['vc', 'vb', 've', 'vs'].forEach((source, i) => {
      expect(Math.abs(result.current(source) / currents[i] - 1)).toBeLessThanOrEqual(1e-6);
    });

  });
  it('maps all seven resistances with absolute temperature ratios', () => {
    const names = ['RE', 'RBI', 'RCI', 'RS', 'RBP', 'RBX', 'RCX'] as const;
    const params = resolveVBICParams(Object.fromEntries(names.flatMap(name => [[name, 10], [`X${name}`, -2]])), 1);
    const mapped = resolveVBICTemperature(params, 85);
    for (const name of names) expect(mapped[name]).toBeCloseTo(10 * ((85 + 273.15) / (27 + 273.15)) ** -2, 12);
  });
  it('runs the unchanged public deck with resistor exponents, activation energies and zero HRCF', async () => {
    const deck = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/vbic/vbic99_tran.sp', import.meta.url), 'utf8');
    expect((await simulate(deck)).transient!.time.length).toBeGreaterThan(1);
  }, 30_000);
});
