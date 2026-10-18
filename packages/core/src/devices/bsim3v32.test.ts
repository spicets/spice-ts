import { describe, expect, it } from 'vitest';
import { UnsupportedModelParameterError } from '../errors.js';
import { simulate } from '../simulate.js';

/** #594: an all-default BSIM3 inverter at one bias, with extra model/instance text. */
const inverter = (modelExtra = '', instanceExtra = '', options = '') => `bsim3 inverter
VDD vdd 0 DC 3.3
VIN in 0 DC 1.2
M1 out in 0 0 n1 W=2u L=1u ${instanceExtra}
M2 out in vdd vdd p1 W=4u L=1u
.model n1 nmos level=8 version=3.2.2 ${modelExtra}
.model p1 pmos level=8 version=3.2.2
${options}
.op
.end
`;

describe('BSIM3 non-quasi-static selectors (#594, #692)', () => {
  it('rejects AC NQS from the instance or the card with a typed error', async () => {
    for (const netlist of [inverter('', 'NQSMOD=1'), inverter('nqsmod=1'), inverter('nqsmod=1', 'NQSMOD=7')]) {
      const ac = netlist.replace('.op', '.ac lin 1 1e6 1e6');
      await expect(simulate(ac)).rejects.toBeInstanceOf(UnsupportedModelParameterError);
      await expect(simulate(ac)).rejects.toMatchObject({
        code: 'UNSUPPORTED_MODEL_PARAMETER', deviceName: 'M1', parameter: 'NQSMOD',
      });
    }
  });

  it('runs when b3v32set.c resolves nqsMod to 0', async () => {
    const baseline = (await simulate(inverter())).dc!.voltage('out');
    // Instance 0 overrides the card; invalid card values fall back to 0.
    for (const netlist of [inverter('nqsmod=1', 'NQSMOD=0'), inverter('nqsmod=3'), inverter('', 'NQSMOD=0')]) {
      expect((await simulate(netlist)).dc!.voltage('out')).toBe(baseline);
    }
  });

  it('permits NQS DC operating points but rejects NQS noise', async () => {
    const deck = inverter('', 'NQSMOD=1');
    expect((await simulate(deck)).dc!.voltage('out')).toBe((await simulate(inverter())).dc!.voltage('out'));
    await expect(simulate(deck.replace('.op', '.noise v(out) VIN dec 2 1 1e6'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_MODEL_PARAMETER', parameter: 'NQSMOD',
    });
  });

  it('permits ACNQSMOD=1 DC on the 3.3.0 device, which defines it', async () => {
    const netlist = inverter().replace(/version=3\.2\.2/g, 'version=3.3.0').replace(
      'W=2u L=1u ', 'W=2u L=1u ACNQSMOD=1',
    );
    expect((await simulate(netlist)).dc!.voltage('out')).toBe(
      (await simulate(netlist.replace('ACNQSMOD=1', 'ACNQSMOD=0'))).dc!.voltage('out'),
    );
  });
});

describe('BSIM3 follows .options TEMP (b3temp.c / b3v32temp.c) (#594)', () => {
  it('accepts a non-nominal circuit temperature and evaluates the device at it', async () => {
    const nominal = (await simulate(inverter())).dc!.current('VDD');
    const explicit27 = (await simulate(inverter('', '', '.options temp=27'))).dc!.current('VDD');
    const hot = (await simulate(inverter('', '', '.options temp=85'))).dc!.current('VDD');
    expect(explicit27).toBe(nominal);
    expect(Math.abs(hot - nominal) / Math.abs(nominal)).toBeGreaterThan(0.01);
  });
});
