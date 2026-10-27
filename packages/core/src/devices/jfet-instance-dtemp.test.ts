import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { ParseError } from '../errors.js';

// Original synthetic decks (no external circuit source), ngspice-47.
// Each identical deck from deck() was run with:
// SPICE_ASCIIRAWFILE=1 ngspice -b -r case.raw case.cir
// ASCII OP output v(d), -i(Vd) below. PJF output is the negative of NJF.
// Supply and gate output are exactly sign*5 and sign*-0.6 respectively.
const cases = [
  [40, 'dtemp=35', 3.152013389139504, 0.001847986610860496],
  [40, 'temp=75', 3.152013389139504, 0.001847986610860496],
  [40, 'dtemp=-15', 2.973019429093025, 0.002026980570906976],
  [40, 'temp=25', 2.973019429093025, 0.002026980570906976],
  [undefined, 'dtemp=10', 3.02231179244133, 0.00197768820755867],
  [undefined, 'temp=37', 3.02231179244133, 0.00197768820755867],
  [27, 'dtemp=0', 2.981561393103608, 0.002018438606896392],
  [40, 'temp=55 dtemp=35', 3.088251176045538, 0.001911748823954462],
  [40, 'dtemp=-15 temp=55', 3.088251176045538, 0.001911748823954462],
  [40, 'temp=55', 3.088251176045538, 0.001911748823954462],
] as const;

function deck(type: 'NJF' | 'PJF', temperature: number | undefined, instance: string): string {
  const sign = type === 'NJF' ? 1 : -1;
  return `JFET instance DTEMP parity (#1859)
Vd supply 0 ${sign * 5}
Rd supply d 1k
Vg g 0 ${sign * -0.6}
J1 d g 0 JM ${instance}
.model JM ${type} LEVEL=1 VTO=-2 BETA=1m LAMBDA=0.01 IS=1e-14 TCV=0.002 BEX=-1.5
${temperature === undefined ? '' : `.temp ${temperature}`}
.op
.end
`;
}

describe('JFET instance DTEMP (#1859)', () => {
  for (const type of ['NJF', 'PJF'] as const) {
    const sign = type === 'NJF' ? 1 : -1;
    it.each(cases)(`${type} TEMP=%s %s matches ngspice-47`, async (temperature, instance, voltage, current) => {
      const dc = (await simulate(deck(type, temperature, instance))).dc!;
      for (const [actual, expected] of [
        [dc.voltage('supply'), sign * 5],
        [dc.voltage('d'), sign * voltage],
        [dc.voltage('g'), sign * -0.6],
        [-dc.current('Vd'), sign * current],
      ]) {
        expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-6);
      }
    });

    it(`${type} offset equals absolute TEMP and TEMP takes precedence`, async () => {
      const results = await Promise.all(cases.map(async ([temperature, instance]) => {
        const dc = (await simulate(deck(type, temperature, instance))).dc!;
        return [dc.voltage('d'), dc.current('Vd')];
      }));
      for (const [a, b] of [[0, 1], [2, 3], [4, 5], [7, 9], [8, 9]]) {
        expect(results[a]).toEqual(results[b]);
      }
      expect(results[0]).not.toEqual(results[2]);
    });
  }

  it.each(['dtemp=oops', 'dtemp=10 dtemp=20', 'dtemp=1e999'])(
    'rejects invalid %s structurally', instance => {
      expect(() => parse(deck('NJF', 40, instance))).toThrow(ParseError);
    },
  );
});
