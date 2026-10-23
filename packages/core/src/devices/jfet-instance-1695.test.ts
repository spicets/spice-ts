import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';

const deck = (level: number, instance: string, model = '') => `JFET instance scaling
V1 1 0 5
R1 1 2 1k
J1 2 0 0 JM ${instance}
.model JM NJF LEVEL=${level} ${model}
.op
.end`;

describe('JFET area and multiplicity (#1695)', () => {
  // ngspice-47, ngspice -b -r deck.raw deck.cir, identical input decks.
  // Instance setters and loading at the pinned ngspice-47 release:
  // https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices
  // jfet/jfetpar.c, jfet/jfetload.c; jfet2/jfet2par.c, jfet2/jfet2load.c,
  // jfet2/psmodel.c (DELTA / AREA before multiplicity is applied).
  it.each([
    [1, '2', '', 4.19999999578, -0.0008000000042200001],
    [2, 'area=2 m=2', '', 3.412331334262741, -0.001587668665737259],
    [2, 'area=2 m=3', 'DELTA=0.37 RD=10 RS=20', 2.6671182870344, -0.0023328817129656],
  ] as const)('matches ngspice-47 OP level %s %s %s', async (level, instance, model, v, i) => {
    const result = await simulate(deck(level, instance, model));
    expect(Math.abs(result.dc!.voltage('2') / v - 1)).toBeLessThan(1e-6);
    expect(Math.abs(result.dc!.current('V1') / i - 1)).toBeLessThan(1e-6);
  });
  for (const level of [1, 2]) {
    for (const instance of ['2', 'area=2', 'm=2', 'area=2 m=3']) {
      it(`scales level ${level} ${instance} including series resistances`, async () => {
        const scale = instance === 'm=2' ? 1 : 2;
        const m = instance.includes('m=3') ? 3 : instance === 'm=2' ? 2 : 1;
        const actual = await simulate(deck(level, instance, 'RD=100 RS=50 CGS=2p CGD=1p'));
        const equivalent = await simulate(deck(level, `m=${m}`, `BETA=${1e-4 * scale} IS=${1e-14 * scale} RD=${100 / scale} RS=${50 / scale} CGS=${2e-12 * scale} CGD=${1e-12 * scale}`));
        expect(actual.dc!.voltage('2')).toBeCloseTo(equivalent.dc!.voltage('2'), 10);
        expect(actual.dc!.current('V1')).toBeCloseTo(equivalent.dc!.current('V1'), 12);
      });
    }
    it(`scales level ${level} transient gate charges`, async () => {
      const tran = (instance: string, model: string) => `charge scaling
V1 1 0 5
R1 1 2 1k
VG g 0 PULSE(-1 0 1n 2n 2n 10n 30n)
J1 2 g 0 JM ${instance}
.model JM NJF LEVEL=${level} ${model}
.tran 0.2n 20n
.end`;
      const actual = await simulate(tran('area=2 m=3', 'CGS=2p CGD=1p'));
      const equivalent = await simulate(tran('m=3', 'BETA=2e-4 IS=2e-14 CGS=4p CGD=2p'));
      const a = actual.transient!.voltage('2');
      const b = equivalent.transient!.voltage('2');
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 8);
      if (level === 1) {
        // Same deck, ngspice-47 final V(2). Full waveform probe max/RMS
        // relative error was 0.0435873% / 0.00887238% at 126 matched times.
        expect(Math.abs(a[a.length - 1] / 4.123650834244414 - 1)).toBeLessThan(0.01);
      }
    });
  }
  it.each(['bogus=2', 'area=oops', 'area=0', 'm=-1', '2 3', 'area=2 area=3'])(
    'keeps malformed instance %s a structured parse error', instance => {
      expect(() => parse(deck(1, instance))).toThrow(ParseError);
    },
  );
});
