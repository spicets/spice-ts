import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

// Original test circuit. Write this return value verbatim to deck.cir, then
// ngspice-47: ngspice -b deck.cir. Values printed with numdgt=15.
export const mesaTemperatureDeck = (directive: string, instance = '') => `MESA temperature #1878
VD supply 0 1.6
RD supply d 1000
VG g 0 0.2
Z1 d g 0 h L=0.7u W=20u ${instance}
.model h nmf level=2 n=1.44 vs=1.9e5 mu=0.25 d=1e-7 vto=0.15 m=2 lambda=0.15 sigma0=0.02 vsigmat=0.5
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
  it.each([
    ['.temp 75', '', [1.567455817385831, -3.25441826141690e-5, -1.74423249616119e-7]],
    ['', 'TS=100 TD=100', [1.565391980986000, -3.46080190139999e-5, -4.58016682881769e-7]],
    ['', 'DTEMP=20', [1.569582492801041, -3.04175071989594e-5, -4.79094357898507e-8]],
  ])('matches %s %s', async (directive, instance, expected) => {
    const op = (await simulate(mesaTemperatureDeck(directive, instance))).dc!;
    [op.voltage('d'), op.current('VD'), op.current('VG')].forEach((actual, index) => {
      expect(Math.abs(actual - expected[index])).toBeLessThan(1e-6 * Math.abs(expected[index]));
    });
  });
});
