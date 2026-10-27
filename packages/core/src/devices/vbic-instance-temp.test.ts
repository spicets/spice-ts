import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { solveDCSweep } from '../analysis/dc-sweep.js';
import { resolveOptions } from '../types.js';
import { VBIC } from './vbic.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../benchmarks/fixtures/issue-1860/reference.json', import.meta.url), 'utf8')) as {
  version: string; command: string;
  rows: { name: string; deck: string; reference: Record<string, number> }[];
};

describe('VBIC instance temperature ngspice-47 (#1860)', () => {
  it.each(fixture.rows)('$name matches identical-deck collector/base currents', async ({ name, deck, reference }) => {
    expect(fixture.version).toBe('ngspice-47');
    const result = await simulate(deck);
    let worst = 0;
    for (const [signal, expected] of Object.entries(reference)) {
      if (signal === 'time') {
        expect(result.transient!.time.at(-1)).toBeCloseTo(expected, 18);
        continue;
      }
      const source = signal.slice(2, -1);
      const actual = result.transient ? result.transient.current(source).at(-1)! : result.dc!.current(source);
      const error = Math.abs((actual - expected) / expected);
      worst = Math.max(worst, error);
      expect(error, signal).toBeLessThanOrEqual(name.endsWith('-tran') ? 1e-4 : 1e-6);
    }
    console.info(`${name} worst relative error ${worst}`);
  });

  it.each([1, -1])('DTEMP equals absolute TEMP for polarity %s', async polarity => {
    const row = fixture.rows.find(row => row.name === `${polarity === 1 ? 'npn' : 'pnp'}-dtemp`)!;
    const actual = (await simulate(row.deck)).dc!;
    const expected = (await simulate(row.deck.replace('DTEMP=23', 'TEMP=50'))).dc!;
    for (const source of ['vc', 'vb']) expect(actual.current(source)).toBe(expected.current(source));
  });

  it('uses TEMP as the baseline, then adds DTEMP like vbictemp.c (unlike Gummel-Poon)', async () => {
    const row = fixture.rows.find(row => row.name === 'npn-both')!;
    const actual = (await simulate(row.deck)).dc!;
    const expected = (await simulate(row.deck.replace('TEMP=50 DTEMP=-100', 'TEMP=-50'))).dc!;
    for (const source of ['vc', 'vb']) expect(actual.current(source)).toBe(expected.current(source));
  });

  it('initializes against actual ambient temperature and restores repeated TEMP sweeps', () => {
    const row = fixture.rows.find(row => row.name === 'npn-dtemp')!;
    const compiled = parse(row.deck.replace('DTEMP=23', 'DTEMP=-301').replace('TEMP=27', 'TEMP=80')).compile();
    const device = compiled.devices.find(device => device instanceof VBIC) as VBIC;
    expect(device.getTemperature()).toBe(-221);
    for (let repeat = 0; repeat < 2; repeat++) {
      solveDCSweep(compiled, { type: 'dc', source: 'TEMP', start: 80, stop: 90, step: 10 }, resolveOptions(compiled.simulationOptions));
      expect(device.getTemperature()).toBe(-221);
    }
    expect(() => device.setTemperature(0)).toThrow(/temperature/);
    expect(device.getTemperature()).toBe(-221);
  });
});
