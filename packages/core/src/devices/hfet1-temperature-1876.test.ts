import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

// Authored here, no third-party circuit. HFET1 is LEVEL=5 in ngspice, not LEVEL=1.
export const temperatureDeck = (directive: string, instance = '') => `HFET1 temperature #1876
VD supply 0 1
RD supply d 1000
VG g 0 0.1
Z1 d g 0 h L=1u W=10u ${instance}
.model h nhfet level=5 vt0=0.15 js1s=1e-12 js1d=1e-12
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

describe('HFET1 temperature ngspice-47 parity (#1876)', () => {
  // ngspice-47: write temperatureDeck(...) verbatim to deck.cir; ngspice -b deck.cir.
  // Reference source: imr/ngspice a80f6e3, hfet1/hfettemp.c:62-85 (TEMP,
  // thermal voltage, N0, mobility and threshold); :89-91 (unported AC terms).
  it.each(['KMU', 'KVTO', 'KLAMBDA', 'TF', 'FGDS', 'DELF'])('rejects unported %s with a typed error', async parameter => {
    await expect(simulate(temperatureDeck('.temp 100').replace(
      'js1d=1e-12', `js1d=1e-12 ${parameter}=0`,
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_PARAMETER', parameter, model: 'HFET1' });
  });

  it.each(['TEMP=-273.15', 'DTEMP=-400'])('rejects invalid %s', async instance => {
    await expect(simulate(temperatureDeck('', instance))).rejects.toMatchObject({
      code: 'INVALID_CIRCUIT',
    });
  });

  it.each([
    ['.temp 100', '', [9.865811086184380e-1, -1.34188913815620e-5, 5.174415673605708e-10]],
    ['.temp 100', 'DTEMP=20', [9.852543335776870e-1, -1.47456664223130e-5, 4.866365227729574e-10]],
    ['.options TEMP=100', '', [9.865811086184380e-1, -1.34188913815620e-5, 5.174415673605708e-10]],
    ['.temp 500', 'DTEMP=-400', [9.865811086184380e-1, -1.34188913815620e-5, 5.174415673605708e-10]],
    ['.temp 100', 'TEMP=60 DTEMP=20', [9.890658105443130e-1, -1.09341894556870e-5, 5.971721624622562e-10]],
    ['', 'TEMP=100', [9.865811086184380e-1, -1.34188913815620e-5, 5.174415673605708e-10]],
    ['', 'DTEMP=73', [9.865811086184380e-1, -1.34188913815620e-5, 5.174415673605708e-10]],
    ['.temp 27', '', [9.909405070070135e-1, -9.05949299298647e-6, 6.905059252926646e-10]],
  ])('matches %s %s', async (directive, instance, expected) => {
    const op = (await simulate(temperatureDeck(directive, instance))).dc!;
    [op.voltage('d'), op.current('VD'), op.current('VG')].forEach((actual, index) => {
      expect(Math.abs(actual - expected[index])).toBeLessThan(1e-6 * Math.abs(expected[index]));
    });
  });
});
