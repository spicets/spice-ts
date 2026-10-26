import { describe, expect, it } from 'vitest';
import { UnsupportedTemperatureError } from './errors.js';
import { parse } from './parser/index.js';
import { simulate } from './simulate.js';

type SwitchKind = 'SW' | 'CSW';

// Original regression deck from #1825 (CSW uses a 1-ohm sensing branch).
const deck = (kind: SwitchKind, temperature: string, analysis = '.op'): string => `Switch circuit temperature
V1 1 0 DC 2
Vc c 0 DC 1 PULSE(0 1 1u 1n 1n 2u 4u)
R1 1 2 1k
${kind === 'SW' ? 'S1 2 0 c 0 sm' : 'Rc c sense 1\nVsense sense 0 0\nW1 2 0 Vsense sm'}
.model sm ${kind} ${kind === 'SW' ? 'VT=0.5 VH=0.1' : 'IT=0.5 IH=0.1'} RON=1 ROFF=1e6
${temperature}
${analysis}
.end
`;

const temperatureCards = ['.temp -40', '.temp 50', '.temp 100',
  '.options TEMP=-40', '.options TEMP=50', '.options TEMP=100'];

describe('temperature-independent SW/CSW (#1825)', () => {
  it.each(['SW', 'CSW'] as const)('accepts an %s operating point at .temp 50 unchanged from 27 C', async kind => {
    const nominal = (await simulate(deck(kind, '.temp 27'))).dc!;
    const hot = (await simulate(deck(kind, '.temp 50'))).dc!;
    expect(hot).toStrictEqual(nominal);
    // ngspice-47 ASCII .op rawfile on the identical deck, rather than the
    // issue's 7-digit print (whose rounding alone is about 1e-9 relative).
    const reference = 0.001998001998001998;
    expect(Math.abs((hot.voltage('2') - reference) / reference)).toBeLessThan(1e-9);
  });

  for (const kind of ['SW', 'CSW'] as const) {
    for (const analysis of ['.op', '.dc Vc 0 1 0.1', '.tran 0.1u 6u']) {
      it.each(temperatureCards)(`${kind} ${analysis} is bit-identical at %s`, async temperature => {
        const nominal = await simulate(deck(kind, '.temp 27', analysis));
        const actual = await simulate(deck(kind, temperature, analysis));
        // Compare all node/branch vectors and the complete time/sweep grids,
        // not result metadata (which may legitimately include temperature).
        expect(actual.dc).toStrictEqual(nominal.dc);
        expect(actual.dcSweep).toStrictEqual(nominal.dcSweep);
        expect(actual.transient).toStrictEqual(nominal.transient);
        const values = nominal.dcSweep?.voltage('2') ?? nominal.transient?.voltage('2');
        if (values) {
          expect(Math.min(...values)).toBeLessThan(0.01);
          expect(Math.max(...values)).toBeGreaterThan(1.9);
        } else {
          expect(nominal.dc!.voltage('2')).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe('unsupported temperature laws remain rejected (#1825)', () => {
  const devices = [
    ['VDMOS', 'M1 d g 0 m', 'VDMOS', 'M1'],
    ['MES', 'Z1 d g 0 m', 'NMF LEVEL=1', 'Z1'],
    ['MESA', 'Z1 d g 0 m', 'NMF LEVEL=2', 'Z1'],
    ['HFET', 'Z1 d g 0 m', 'NHFET LEVEL=5', 'Z1'],
  ] as const;

  for (const [family, instance, model, deviceName] of devices) {
    it.each(['.temp 50', '.options TEMP=50'])(`${family} still rejects %s`, temperature => {
      const netlist = (card: string): string => `Unsupported temperature
Vd d 0 1
Vg g 0 1
${instance}
.model m ${model}
${card}
.op
.end
`;
      expect(() => parse(netlist('.temp 27')).compile()).not.toThrow();
      const compile = (): void => { parse(netlist(temperature)).compile(); };
      expect(compile).toThrow(UnsupportedTemperatureError);
      expect(compile).toThrow(expect.objectContaining({
        code: 'UNSUPPORTED_TEMPERATURE', deviceName, temperature: 50,
      }));
    });
  }
});
