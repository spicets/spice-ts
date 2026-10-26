import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from './errors.js';
import { parse } from './parser/index.js';
import { simulate } from './simulate.js';

const fixtureUrl = new URL(
  '../../../benchmarks/corpus/ngspice/fixtures/tests/vbic/temp.cir',
  import.meta.url,
);

/**
 * ngspice-47 `.print dc i(vc) i(vb)` of the unchanged tests/vbic/temp.cir
 * (`.OPTIONS TEMP=150 NOACCT`), run with `ngspice -b temp.cir`.
 */
const NGSPICE_47_TEMP_150 = [
  { sweep: 0.2, vc: 1.868249e-08, vb: 1.079689e-09 },
  { sweep: 0.4, vc: 4.248673e-06, vb: 4.952732e-08 },
  { sweep: 0.6, vc: 6.920914e-04, vb: 1.094672e-05 },
  { sweep: 0.7, vc: 3.955907e-03, vb: 1.316270e-04 },
  { sweep: 0.8, vc: 1.162295e-02, vb: 1.009677e-03 },
  { sweep: 1.0, vc: 2.603855e-02, vb: 8.605550e-03 },
  { sweep: 1.2, vc: 3.152854e-02, vb: 2.114793e-02 },
] as const;

describe('.OPTIONS TEMP (ngspice-47 circuit temperature)', () => {
  it('parses TEMP as the circuit temperature and NOACCT as a no-op', () => {
    const circuit = parse('options temp\nR1 1 0 1k\nV1 1 0 1\n.OPTIONS TEMP=150 NOACCT\n.op');

    expect(circuit.temperature).toBe(150);
    expect(circuit.simulationOptions).toEqual({});
  });

  it('round-trips the circuit temperature through toNetlist()', () => {
    const circuit = parse('options temp\nR1 1 0 1k\nV1 1 0 1\n.options temp=85\n.op');

    expect(parse(circuit.toNetlist()).temperature).toBe(85);
  });

  it.each(['temp', 'temp=', 'temp=abc'])('rejects a malformed TEMP field: %s', field => {
    expect(() => parse(`bad temp\nR1 1 0 1k\nV1 1 0 1\n.options ${field}\n.op`)).toThrow();
  });

  it('applies TEMP to resistor TC1/TC2 like ngspice', async () => {
    const result = await simulate(`resistor temp
V1 1 0 1
R1 1 0 1k TC1=1e-3 TC2=1e-6
.options temp=127
.op`);
    const delta = 127 - 27;
    const resistance = 1000 * (1 + 1e-3 * delta + 1e-6 * delta * delta);

    expect(result.dc!.current('V1')).toBeCloseTo(-1 / resistance, 12);
  });

  it('applies TEMP to .model R TC1/TC2 and instance tce like ngspice-47 restemp.c', async () => {
    // ngspice-47 `print` on the same deck: i(v1) = -9.00900900901e-4, i(v2) = -6.08038824689e-4.
    const result = await simulate(`rmodel temp
V1 1 0 1
R1 1 0 1k RM
.model RM R TC1=1e-3 TC2=1e-6
V2 2 0 1
R2 2 0 1k tce=0.5
.options TEMP=127
.op`);

    expect(result.dc!.current('V1')).toBeCloseTo(-9.00900900901e-4, 14);
    expect(result.dc!.current('V2')).toBeCloseTo(-6.08038824689e-4, 14);
  });

  it('applies TEMP to B-source tc1/tc2 and temper like ngspice-47 asrctemp.c', async () => {
    // ngspice-47 `print` on the same deck: v(2) = 3, v(3) = 77, v(4) = 1.75.
    const result = await simulate(`asrc temp
V1 1 0 1
B1 2 0 V=2*v(1) tc1=0.01
R1 2 0 1k
B2 3 0 V=temper
R2 3 0 1k
B3 0 4 I=1m tc1=0.01 tc2=1e-4
R3 4 0 1k
.options TEMP=77
.op`);

    expect(result.dc!.voltage('2')).toBeCloseTo(3, 9);
    expect(result.dc!.voltage('3')).toBeCloseTo(77, 9);
    expect(result.dc!.voltage('4')).toBeCloseTo(1.75, 9);
  });

  it('matches ngspice-47 on the unchanged tests/vbic/temp.cir fixture', async () => {
    const fixture = readFileSync(fixtureUrl);
    expect(createHash('sha256').update(fixture).digest('hex'))
      .toBe('5dfd5fb1e620eac69af1eed64463aac62efd23dee169f2a3773d1091088f31e7');

    const result = await simulate(fixture.toString('utf8'));
    const sweep = Array.from(result.dcSweep!.sweepValues);
    const vc = Array.from(result.dcSweep!.current('VC'));
    const vb = Array.from(result.dcSweep!.current('VB'));

    expect(sweep).toHaveLength(101);
    for (const reference of NGSPICE_47_TEMP_150) {
      const index = sweep.findIndex(value => Math.abs(value - reference.sweep) < 1e-9);
      expect(index).toBeGreaterThanOrEqual(0);
      // On the same deck at 27 C the bounded VBIC already differs from ngspice by
      // up to 2.7e-6 A (i(vc) near 0.96 V, about 1e-4 relative) plus a ~2e-13 A
      // junction-GMIN offset at low bias, so a 5e-4 relative envelope is used.
      // Without the temperature mapping i(vc) at 0.2 V is 2.2e-13 A, not 1.9e-8 A.
      expect(Math.abs(vc[index] - reference.vc)).toBeLessThanOrEqual(5e-4 * reference.vc);
      expect(Math.abs(vb[index] - reference.vb)).toBeLessThanOrEqual(5e-4 * reference.vb);
    }
  });

  it('keeps TEMP=27 identical to the nominal circuit', async () => {
    const fixture = readFileSync(fixtureUrl, 'utf8');
    const nominal = await simulate(fixture.replace('.OPTIONS TEMP=150 NOACCT', '.OPTIONS NOACCT'));
    const explicit = await simulate(fixture.replace('TEMP=150', 'TEMP=27'));

    expect(Array.from(explicit.dcSweep!.current('VC')))
      .toEqual(Array.from(nominal.dcSweep!.current('VC')));
  });

  it('maps VBIC parameters relative to the model TNOM like ngspice-47', async () => {
    // ngspice-47 on temp.cir with TNOM=150 added to the .MODEL card
    // (written with `set filetype=ascii` + `write`, 16 significant digits).
    const reference = [
      { sweep: 1.0, vc: 5.245222674691574e-05, vb: 8.145448094160069e-07 },
      { sweep: 1.2, vc: 3.854084842142448e-03, vb: 1.450190074961516e-04 },
    ];
    const fixture = readFileSync(fixtureUrl, 'utf8').replace('NPN LEVEL=4', 'NPN LEVEL=4 TNOM=150');
    const result = await simulate(fixture);
    const sweep = Array.from(result.dcSweep!.sweepValues);
    const vc = Array.from(result.dcSweep!.current('VC'));
    const vb = Array.from(result.dcSweep!.current('VB'));

    for (const point of reference) {
      const index = sweep.findIndex(value => Math.abs(value - point.sweep) < 1e-9);
      expect(Math.abs(vc[index] - point.vc)).toBeLessThanOrEqual(5e-4 * point.vc);
      expect(Math.abs(vb[index] - point.vb)).toBeLessThanOrEqual(5e-4 * point.vb);
    }
  });

  it.each([
    ['level-9 MOSFET', 'M1 1 1 0 0 MMOD\n.model MMOD NMOS LEVEL=9'],
  ])('rejects a non-nominal TEMP for a %s without an ngspice temperature model', (_kind, cards) => {
    const circuit = parse(`unsupported temp\nV1 1 0 1\n${cards}\n.options temp=100\n.op`);

    expect(() => circuit.compile()).toThrow(InvalidCircuitError);
    expect(() => circuit.compile()).toThrow(/cannot be simulated at TEMP=100 C/);
  });

  it('accepts TEMP=27 for devices without a temperature model', async () => {
    const result = await simulate('nominal temp\nV1 1 0 1\nR1 1 2 1k\nD1 2 0 DMOD\n.model DMOD D IS=1e-14\n.options temp=27\n.op');

    expect(result.dc).toBeDefined();
  });

  it('accepts resistor .noise at a non-nominal TEMP', () => {
    const circuit = parse(`noise temp
V1 1 0 dc 0 ac 1
R1 1 2 1k
R2 2 0 1k
.options temp=50
.noise v(2) V1 dec 1 1k 10k`);

    expect(() => circuit.compile()).not.toThrow();
  });
});
