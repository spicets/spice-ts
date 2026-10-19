import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Diode, type DiodeModelInput } from './diode.js';
import { simulate } from '../simulate.js';
import { UnsupportedModelParameterError } from '../errors.js';

type Resolved = Required<Pick<DiodeModelInput, 'CJ0' | 'CJSW' | 'VJ' | 'VJSW' | 'M' | 'TT'>>;
interface Reference {
  temperature: number;
  model: DiodeModelInput;
  expected: Resolved;
  magnitude: number;
  phase: number;
}
const references: Reference[] = JSON.parse(readFileSync(
  new URL('./fixtures/diode-temperature-1533.json', import.meta.url), 'utf8',
));
const base = { CJ0: 10e-12, CJSW: 3e-12, VJ: 0.8, VJSW: 0.9, M: 0.4, MJSW: 0.33, TT: 2e-9 };

// ngspice-47 diotemp.c:52-55,82-112,248-251. References are recovered from
// `op; print @d1[cd] @d1[gd]` with numdgt=17: isolate each junction (TT=0),
// measure C at V=0,-1,-2 and invert C(V)=C(0)*(1-V/PB)^(-M). With both
// junction capacitances zero, TT(T)=cd/gd. AC uses the identical deck below.
// Regenerate with: spice-heavy python benchmarks/diode-temperature/generate.py

describe('ngspice-47 diode temperature laws (#1533)', () => {
  it('rejects selectors with no implemented ngspice capacitance law', () => {
    expect(() => new Diode('D1', [0, -1], { TLEVC: 2 })).toThrow(UnsupportedModelParameterError);
  });

  it('preserves AREA, PJ and multiplier scaling and instance DTEMP', () => {
    const model = { ...base, TLEVC: 1, CTA: 0.001, CTP: 0.002, TM1: 0.001, TTT1: 0.002 };
    const reference = new Diode('D1', [0, -1], model, false, { PJ: 1 });
    reference.setTemperature(100);
    const scaled = new Diode('D2', [0, -1], model, false, { AREA: 2, PJ: 4, M: 3, DTEMP: 73 });
    expect(scaled.params.CJ0).toBeCloseTo(reference.params.CJ0! * 6, 20);
    expect(scaled.params.CJSW).toBeCloseTo(reference.params.CJSW! * 12, 20);
    expect(scaled.params.M).toBe(reference.params.M);
    expect(scaled.params.TT).toBe(reference.params.TT);
  });

  for (const [index, reference] of references.entries()) {
    const { temperature, model, expected } = reference;
    it(`resolves case ${index} at ${temperature} C: ${JSON.stringify(model)}`, () => {
      const diode = new Diode('D1', [0, -1], { ...base, ...model }, false, { PJ: 1 });
      // Repeated updates must always start at the nominal model, not compound.
      for (const value of [temperature, 27, temperature]) {
        diode.setTemperature(value);
      }
      for (const field of Object.keys(expected) as (keyof Resolved)[]) {
        expect(Math.abs((diode.params[field]! - expected[field]) / expected[field]), field).toBeLessThan(1e-9);
      }
    });

    it(`matches reverse-bias AC case ${index} at ${temperature} C`, async () => {
      const fields = Object.entries({ ...base, ...model }).map(([key, value]) => `${key}=${value}`).join(' ');
      const result = await simulate(`Diode temperature parameter oracle #1533
V1 in 0 -1 AC 1
R1 in out 1k
D1 out 0 DM PJ=1
.model DM D (${fields})
.options temp=${temperature} reltol=1e-12 abstol=1e-20 vntol=1e-14
.ac lin 1 100Meg 100Meg
.end
`);
      const out = result.ac!.voltage('out')[0];
      // Existing diode-depletion.test.ts thresholds: 1e-4 relative vm, 1e-4 rad vp.
      expect(Math.abs((out.magnitude - reference.magnitude) / reference.magnitude)).toBeLessThan(1e-4);
      expect(Math.abs(out.phase * Math.PI / 180 - reference.phase)).toBeLessThan(1e-4);
    });
  }
});
