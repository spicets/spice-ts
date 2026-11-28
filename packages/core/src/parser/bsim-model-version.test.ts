import { describe, expect, it } from 'vitest';
import { UnsupportedModelVersionError } from '../errors.js';
import { BSIM4 } from '../devices/bsim4/device.js';
import { simulate } from '../simulate.js';
import { parse } from './index.js';

/**
 * #503: BSIM `.model` cards carry a dotted VERSION= string (ngspice b3.c/b4.c declare it IF_STRING).
 * ngspice selects the implementation by prefix (inpdomod.c): LEVEL=8/49 -> 3.0 BSIM3v0, 3.1 BSIM3v1,
 * 3.2 BSIM3v32, 3.3 or absent BSIM3 (3.3.0); LEVEL=14/54 -> 4.0-4.5 BSIM4v5, 4.6, 4.7, 4.8 or absent BSIM4.
 */
const inverter = (modelCards: string) => `bsim3 inverter
VDD vdd 0 DC 3.3
VIN in 0 DC 1.2
M1 out in 0 0 n1 W=2u L=1u
M2 out in vdd vdd p1 W=4u L=1u
${modelCards}
.op
.end
`;

describe('BSIM model cards with dotted VERSION= values (#503)', () => {
  it('parses a dotted VERSION= string instead of failing as a number', () => {
    const circuit = parse('title\n.model n1 nmos level=8 version=3.3.0 tox=10n\n.end\n');
    const model = circuit.toNetlist();
    expect(model).toContain('VERSION=3.3.0');
  });

  it('accepts the spaced VERSION = form of ngspice decks', () => {
    expect(() => parse('title\n.MODEL Nmod NMOS LEVEL=8 TNOM = 25 VERSION = 3.3.0 TOX = 5.8e-9\n.end\n')).not.toThrow();
  });

  it('runs LEVEL=8/49 VERSION=3.3.x exactly like the default BSIM3 3.3.0 model', async () => {
    const baseline = await simulate(inverter('.model n1 nmos level=8\n.model p1 pmos level=8'));
    for (const version of ['3.3.0', '3.3', '3.30', 'default', 'DEFAULT']) {
      for (const level of [8, 49]) {
        const result = await simulate(inverter(
          `.model n1 nmos level=${level} version=${version}\n.model p1 pmos level=${level} version=${version}`,
        ));
        expect(result.dc!.voltage('out')).toBe(baseline.dc!.voltage('out'));
      }
    }
  });

  it('runs LEVEL=8/49 VERSION=3.2.x as the ngspice bsim3v32 revisions (#594)', async () => {
    const baseline = await simulate(inverter('.model n1 nmos level=8\n.model p1 pmos level=8'));
    for (const level of [8, 49]) {
      for (const version of ['3.2.2', '3.2.4', '3.2', '3.24']) {
        const result = await simulate(inverter(
          `.model n1 nmos level=${level} version=${version}\n.model p1 pmos level=${level} version=${version}`,
        ));
        // The all-default inverter has no revision-dependent DC branch: same OP as 3.3.0.
        expect(result.dc!.voltage('out')).toBeCloseTo(baseline.dc!.voltage('out'), 12);
      }
    }
  });

  it('rejects BSIM3 versions spice-ts does not implement with a typed error, not a parse error', async () => {
    for (const level of [8, 49]) {
      for (const version of ['3.1', '3.0', '5.0']) {
        const netlist = inverter(`.model n1 nmos level=${level} version=${version}\n.model p1 pmos level=${level} version=${version}`);
        await expect(simulate(netlist)).rejects.toBeInstanceOf(UnsupportedModelVersionError);
        await expect(simulate(netlist)).rejects.toMatchObject({
          code: 'UNSUPPORTED_MODEL_VERSION', level, version, modelName: 'n1',
        });
      }
    }
  });

  it('registers BSIM4 dotted VERSION=4.8.2 and rejects unported revisions, not their LEVEL', async () => {
    for (const level of [14, 54]) {
      const version = '4.8.2';
      const netlist = inverter(`.model n1 nmos level=${level} version=${version}\n.model p1 pmos level=${level} version=${version}`);
      expect(parse(netlist).compile().devices.find(device => device.name === 'M1')).toBeInstanceOf(BSIM4);
      expect(Number.isFinite((await simulate(netlist)).dc!.voltage('out'))).toBe(true);
      const unported = inverter(`.model n1 nmos level=${level} version=4.5.0\n.model p1 pmos level=${level} version=4.5.0`);
      await expect(simulate(unported)).rejects.toBeInstanceOf(UnsupportedModelVersionError);
      await expect(simulate(unported)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_VERSION', version: '4.5.0' });
    }
  });

  it.each([14, 54].flatMap(level => ['4.89', '4.8.4'].map(version => ({ level, version }))))(
    'runs BSIM4 $level version $version like 4.8.3 in OP and AC', async ({ level, version }) => {
      const deck = (v: string) => inverter(
        `.model n1 nmos level=${level} version=${v}\n.model p1 pmos level=${level} version=${v}`,
      ).replace('VIN in 0 DC 1.2', 'VIN in 0 DC 1.2 AC 1').replace('.op', '.op\n.ac dec 2 1k 1Meg');
      const baseline = await simulate(deck('4.8.3'));
      const actual = await simulate(deck(version));
      expect(actual.dc!.voltage('out')).toBe(baseline.dc!.voltage('out'));
      expect(actual.ac!.frequencies).toEqual(baseline.ac!.frequencies);
      expect(actual.ac!.voltage('out')).toEqual(baseline.ac!.voltage('out'));
      expect(actual.ac!.current('vdd')).toEqual(baseline.ac!.current('vdd'));
    },
  );

  it.each([14, 54].flatMap(level => ['4.3', '4.5', '4.7', 'garbage', '4.08'].map(version => ({ level, version }))))(
    'keeps BSIM4 $level version $version as a typed unsupported error', async ({ level, version }) => {
      const netlist = inverter(`.model n1 nmos level=${level} version=${version}\n.model p1 pmos level=${level} version=${version}`);
      await expect(simulate(netlist)).rejects.toMatchObject({
        code: 'UNSUPPORTED_MODEL_VERSION', level, version, modelName: 'n1',
      });
    },
  );

  it('preserves unsupported revisions through a netlist round trip', async () => {
    const netlist = inverter('.model n1 nmos level=8 version=3.1\n.model p1 pmos level=8 version=3.1');
    const serialized = parse(netlist).toNetlist();
    expect(serialized).toContain('VERSION=3.1');
    await expect(simulate(serialized)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL_VERSION', version: '3.1' });
  });

  it('preserves 3.2.x revisions through a netlist round trip', async () => {
    const netlist = inverter('.model n1 nmos level=8 version=3.2.2\n.model p1 pmos level=8 version=3.2.2');
    const serialized = parse(netlist).toNetlist();
    expect(serialized).toContain('VERSION=3.2.2');
    const [direct, roundTrip] = await Promise.all([simulate(netlist), simulate(serialized)]);
    expect(roundTrip.dc!.voltage('out')).toBe(direct.dc!.voltage('out'));
  });

  it('checks revisions on models local to subcircuits', async () => {
    const netlist = `local BSIM model
V1 d 0 1
V2 g 0 1
X1 d g stage
.subckt stage drain gate
M1 drain gate 0 0 local W=2u L=1u
.model local nmos level=49 version=3.1
.ends stage
.op
.end`;
    await expect(simulate(netlist)).rejects.toBeInstanceOf(UnsupportedModelVersionError);
  });

  it('still rejects malformed numeric parameters', () => {
    expect(() => parse('title\n.model n1 nmos level=8 version=3.3.0 tox=4.8.2\n.end')).toThrow("Cannot parse number: '4.8.2'");
  });
});
