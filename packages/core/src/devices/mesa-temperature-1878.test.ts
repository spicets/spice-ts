import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { mesaInstanceState, resolveMESAInstance, resolveMESAModel } from './mesa-model.js';
import { expandZDevice } from './z-device.js';

// Original test circuit. Write this return value verbatim to deck.cir, then
// ngspice-47: ngspice -b deck.cir. Values printed with numdgt=15.
// Mapping source: imr/ngspice a80f6e3e95d51534905b1f23410a951802666656,
// src/spicelib/devices/mesa/{mesasetup,mesatemp,mesamparam}.c.
export const mesaTemperatureDeck = (directive: string, instance = '', model = '', level = 2) => `MESA temperature #1878
VD supply 0 1.6
RD supply d 1000
VG g 0 0.2
Z1 d g 0 h L=0.7u W=20u ${instance}
.model h nmf level=${level} n=1.44 vs=1.9e5 mu=0.25 d=1e-7 vto=0.15 m=2 lambda=0.15 sigma0=0.02 vsigmat=0.5${model}
${directive}
.options reltol=1e-10 abstol=1e-16 gmin=1e-12
.op
.control
set numdgt=15
run
print v(d) i(vd) i(vg)
.endc
.end
`;

describe('MESA temperature ngspice-47 parity (#1878)', () => {
  // Exercise every mesatemp.c temperature law, including series resistors
  // expanded before intrinsic-device construction, and both mobility branches.
  const coefficients = ' rd=20 rs=15 rg=10 ri=5 rf=6 rdi=4 rsi=3 rtc1=0.002 rtc2=1e-5'
    + ' tvto=0.0003 tphib=0.0001 teta0=2000 teta1=0.1 tlambda=3000 xtm0=-1'
    + ' mu1=0.5 mu2=0.2 xtm1=1 xtm2=2';
  it.each([
    ['.temp 75', '', [1.567455817385831, -3.25441826141690e-5, -1.74423249616119e-7]],
    ['', 'TS=100 TD=100', [1.565391980986000, -3.46080190139999e-5, -4.58016682881769e-7]],
    ['', 'DTEMP=20', [1.569582492801041, -3.04175071989594e-5, -4.79094357898507e-8]],
    ['.temp 75', 'DTEMP=20', [1.565817420244296, -3.41825797557044e-5, -3.81901733400929e-7]],
    ['.temp 75', 'TS=100 TD=100 DTEMP=20', [1.565391980986, -3.46080190139999e-5, -4.58016682881769e-7]],
    ['.temp 75', 'TS=100 DTEMP=20', [1.565392350393545, -3.46076496064549e-5, -4.58391010864036e-7]],
    ['.temp 75', 'TD=100 DTEMP=20', [1.565816889036105, -3.4183110963895e-5, -3.81363479050151e-7]],
    ['.temp 75\n.options tnom=50', 'DTEMP=20', [1.575736481966088, -2.42635180339123e-5, -4.62280657698574e-7], coefficients],
    ['.temp 75', 'DTEMP=20', [1.573953081341198, -2.60469186588017e-5, -4.76485856463566e-7], coefficients],
    ['.temp 75', 'DTEMP=20', [1.424217177404257, -1.75782822595743e-4, -4.57521379108392e-7], coefficients, 3],
    ['.temp 27', '', [1.570979585515716, -2.90204144842836e-5, -1.52808812359991e-8]],
  ] satisfies [string, string, number[], string?, number?][])('matches %s %s', async (directive, instance, expected, model = '', level = 2) => {
    const op = (await simulate(mesaTemperatureDeck(directive, instance, model, level))).dc!;
    [op.voltage('d'), op.current('VD'), op.current('VG')].forEach((actual, index) => {
      expect(Math.abs(actual - expected[index])).toBeLessThan(1e-6 * Math.abs(expected[index]));
    });
  });

  describe.each(['RD', 'RS', 'RG', 'RI', 'RF'])('%s temperature zero crossing', parameter => {
    it.each([2, 3])('retains the positive-side parasitic at level %d', async level => {
      const model = resolveMESAModel({ name: 'h', type: 'NMF', params: { LEVEL: level, [parameter]: 20, RTC1: -0.04 } });
      const expansion = expandZDevice('Z1', ['d', 'g', '0'], { kind: 'mesa', model }, {}, suffix => `z1.${suffix}`, 51);
      expect(expansion.resistors).toHaveLength(1);
      expect(expansion.resistors[0].name).toBe(`Z1.${parameter}`);
      expect(expansion.resistors[0].value).toBeCloseTo(0.8, 12);
      expect(expansion.nodes).toContain(`z1.${parameter.toLowerCase()}`);
      const op = (await simulate(mesaTemperatureDeck('.temp 51', '', ` ${parameter}=20 rtc1=-0.04`, level))).dc!;
      expect(Number.isFinite(op.voltage('d'))).toBe(true);
    });

    it.each([2, 3].flatMap(level => [52, 53, 75].map(temperature => [level, temperature])))(
      'rejects nonpositive scaled resistance at level %d, TEMP=%d with a typed error',
      async (level, temperature) => {
        // TNOM=27: RTC1=-0.04 crosses zero at 52 C. ngspice keeps its
        // model-established prime nodes; silently omitting the resistor is wrong.
        await expect(simulate(mesaTemperatureDeck(`.temp ${temperature}`, '', ` ${parameter}=20 rtc1=-0.04`, level)))
          .rejects.toMatchObject({
            code: 'UNSUPPORTED_MODEL_PARAMETER', deviceName: 'Z1', parameter, model: 'MESA',
          });
      },
    );
  });

  it.each([52, 75])('allows absent parasitics despite a nonpositive scale at TEMP=%d', async temperature => {
    const model = resolveMESAModel({ name: 'h', type: 'NMF', params: { LEVEL: 2, RTC1: -0.04 } });
    const expansion = expandZDevice('Z1', ['d', 'g', '0'], { kind: 'mesa', model }, {}, suffix => `z1.${suffix}`, temperature);
    expect(expansion.resistors).toEqual([]);
    expect(expansion.nodes).toEqual(['d', 'g', '0', '0', 'd']);
    const op = (await simulate(mesaTemperatureDeck(`.temp ${temperature}`, '', ' rtc1=-0.04'))).dc!;
    expect(Number.isFinite(op.voltage('d'))).toBe(true);
  });

  // ngspice-47 exits 1 with "unknown parameter (temp)" for this same deck.
  it('rejects TEMP rather than inventing semantics absent from ngspice MESA', async () => {
    await expect(simulate(mesaTemperatureDeck('', 'TEMP=100'))).rejects.toMatchObject({ code: 'INVALID_CIRCUIT' });
  });

  it.each(['TS=-273.15', 'TD=-400', 'DTEMP=-400'])('rejects invalid %s', async instance => {
    await expect(simulate(mesaTemperatureDeck('', instance))).rejects.toMatchObject({ code: 'INVALID_CIRCUIT' });
  });

  it.each(['TNOM', 'UNKNOWN_TC'])('rejects unsupported model %s with a typed error', parameter => {
    expect(() => resolveMESAModel({ name: 'h', type: 'NMF', params: { LEVEL: 2, [parameter]: 1 } }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MODEL_PARAMETER', parameter, model: 'MESA' }));
  });

  it('maps characteristic temperatures in Celsius and defaults TF to circuit TEMP', () => {
    const card = { name: 'h', type: 'NMF' as const, params: { LEVEL: 2 } };
    const defaults = resolveMESAModel(card, 75, 50);
    expect(defaults.TF).toBe(348.15);
    expect(defaults.nominalTemperature).toBe(323.15);
    expect(mesaInstanceState(defaults, resolveMESAInstance({}, 75)).fl).toBe(0);
    const explicit = resolveMESAModel({ ...card, params: {
      LEVEL: 2, TF: 100, TMU: 50, TLAMBDA: 200, TETA0: 300, TETA1: 0, FLO: 1,
    } }, 75);
    expect(explicit).toMatchObject({
      TF: 373.15, TMU: 323.15, TLAMBDA: 473.15, TETA0: 573.15, TETA1: 273.15,
    });
    expect(mesaInstanceState(explicit, resolveMESAInstance({}, 75)).fl)
      .toBeCloseTo(Math.exp(348.15 / 373.15), 14);
  });
});
