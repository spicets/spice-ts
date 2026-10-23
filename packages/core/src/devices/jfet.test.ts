import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { MNAAssembler } from '../mna/assembler.js';
import { JFET } from './jfet.js';
import { parse } from '../parser/index.js';

const fixtureRoot = resolve(
  import.meta.dirname,
  '../../../../benchmarks/corpus/xyce/fixtures/NJFET_DC',
);

function fixture(name: string): string {
  return readFileSync(resolve(fixtureRoot, name), 'utf8');
}

const model = '.model MOD NJF LEVEL=1 BETA=2.69e-5 VTO=-3.795 PB=1.07 LAMBDA=0.0181 B=0.605 IS=1.393e-10 RD=0 RS=0 CGS=0 CGD=0 FC=0.5 AF=1 KF=0.05';

async function operatingPoint(vds: number, vgs: number) {
  return simulate(`JFET operating point\nVd d 0 ${vds}\nVg g 0 ${vgs}\nJ1 d g 0 MOD\n${model}\n.op\n.end`);
}

async function level2OperatingPoint(delta: number, theta = 0) {
  const level2Model = `.model MOD NJF LEVEL=2 BETA=0.000379 VTO=-3.760 PB=0.650 LAMBDA=0.0124 DELTA=${delta} THETA=${theta} RD=0 RS=0 CGS=0 CGD=0 FC=0.5 IS=1.393e-10 AF=1 KF=0.05`;
  return simulate(`JFET2 operating point\nVd d 0 5\nVg g 0 -1\nJ1 d g 0 MOD\n${level2Model}\n.op\n.end`);
}

function level2DrainResidual(vGS: number, vDS: number): { current: number; gm: number } {
  const assembler = new MNAAssembler(2, 0);
  assembler.solution[0] = vDS;
  assembler.solution[1] = vGS;
  const jfet = new JFET('J1', [0, 1, -1], {
    LEVEL: 2,
    BETA: 0.000379,
    VTO: -3.760,
    PB: 0.650,
    LAMBDA: 0.0124,
    DELTA: 0.37,
  });
  jfet.stamp(assembler.getStampContext());

  return {
    current: assembler.G.get(0, 0) * vDS
      + assembler.G.get(0, 1) * vGS - assembler.b[0],
    gm: assembler.G.get(0, 1),
  };
}

describe('NJF level-1', () => {
  it('matches ngspice-47 in the linear region', async () => {
    const result = await operatingPoint(1, -1);
    expect(result.dc!.current('Vd')).toBeCloseTo(-1.11743e-4, 9);
    expect(result.dc!.current('Vg')).toBeCloseTo(2.815964e-10, 14);
  });

  it('matches ngspice-47 in saturation', async () => {
    const result = await operatingPoint(5, -1);
    expect(result.dc!.current('Vd')).toBeCloseTo(-1.90647e-4, 9);
    expect(result.dc!.current('Vg')).toBeCloseTo(2.855967e-10, 14);
  });

  it('compiles the unchanged level-1 Xyce fixture', () => {
    const compiled = parse(fixture('njfet.cir')).compile();
    expect(compiled.devices.some(device => device instanceof JFET)).toBe(true);
  });

  it('matches the level-1 fixture endpoint including RD, RS, and B', async () => {
    const netlist = fixture('njfet.cir')
      .replace(/^\.Step.*$/mi, '')
      .replace(/^\.DC VDS.*$/mi, '.DC Vds 15 15 1')
      .replace(/^Vgs 2 0 0$/mi, 'Vgs 2 0 -1.875');
    const result = await simulate(netlist);

    // ngspice-47: equivalent two-source .dc sweep, Vgs=-1.875 V, Vds=15 V.
    expect(result.dcSweep!.current('Vidmon')[0]).toBeCloseTo(9.349505351985685e-5, 10);
  });

  it('rejects unsupported model parameters explicitly', () => {
    expect(() => parse('title\nJ1 d g s MOD\n.model MOD NJF LEVEL=1 DELTA=0.1\n.op').compile())
      .toThrow(/Unsupported NJF level-1 model parameter: 'DELTA'/);
  });

  it('rejects unsupported J-card instance parameters explicitly', () => {
    expect(() => parse('title\nJ1 d g s MOD UNKNOWN=2\n.model MOD NJF LEVEL=1\n.op'))
      .toThrow(/Unsupported JFET instance parameter: 'UNKNOWN=2'/);
  });
});

describe('NJF level-2 Parker-Skellern subset', () => {
  it('stamps a gate derivative matching the finite-difference channel current', () => {
    const vGS = -1;
    const vDS = 5;
    const step = 1e-5;
    const analytic = level2DrainResidual(vGS, vDS).gm;
    const finiteDifference = (
      level2DrainResidual(vGS + step, vDS).current
      - level2DrainResidual(vGS - step, vDS).current
    ) / (2 * step);

    expect(Math.abs((analytic - finiteDifference) / finiteDifference)).toBeLessThan(1e-9);
  });

  it('preserves and compiles the unchanged public Xyce fixture', () => {
    const source = fixture('njfet-2109.cir');
    expect(createHash('sha256').update(source).digest('hex'))
      .toBe('d25578ed59ddc0f94e3a2f9281f1200982f82c682ec63d5256bf0399f34ecd46');
    const compiled = parse(source).compile();
    expect(compiled.devices.some(device => device instanceof JFET)).toBe(true);
  });

  it('matches ngspice-47 DELTA thermal current reduction', async () => {
    const withoutDelta = await level2OperatingPoint(0);
    const withDelta = await level2OperatingPoint(0.37);

    expect(withoutDelta.dc!.current('Vd')).toBeCloseTo(-3.04743e-3, 8);
    expect(withDelta.dc!.current('Vd')).toBeCloseTo(-3.03035e-3, 8);
    expect(Math.abs(withDelta.dc!.current('Vd')))
      .toBeLessThan(Math.abs(withoutDelta.dc!.current('Vd')));
  });

  it('matches the level-2 fixture endpoint including DELTA and RS', async () => {
    const netlist = fixture('njfet-2109.cir')
      .replace(/^\.DC Vds.*$/mi, '.DC Vds 15 15 1')
      .replace(/^Vgs 2 0 0$/mi, 'Vgs 2 0 -1.875');
    const result = await simulate(netlist);

    // ngspice-47: equivalent one-source .dc sweep, Vgs=-1.875 V, Vds=15 V.
    expect(result.dcSweep!.current('Vidmon')[0]).toBeCloseTo(1.3541555706578206e-3, 10);
  });

  it('treats THETA as the explicit ngspice-47 compatibility no-op', async () => {
    const baseline = await level2OperatingPoint(0.37, 0);
    const withTheta = await level2OperatingPoint(0.37, 9);

    expect(withTheta.dc!.current('Vd')).toBeCloseTo(baseline.dc!.current('Vd'), 14);
  });

  it('rejects parameters outside the bounded level-2 subset explicitly', () => {
    expect(() => parse('title\nJ1 d g s MOD\n.model MOD NJF LEVEL=2 B=0.5\n.op').compile())
      .toThrow(/Unsupported NJF level-2 model parameter: 'B'/);
  });
});
