import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { JFET } from './jfet.js';

// Issue #717: three JFET forms that ngspice-47 accepts on identical bytes
// (corpus-g PJFET_DC/pjfet-2108.cir, PJFET_SWITCH/pjfet_tran.cir,
// MEASURE/bad_dot_measure_line5.cir) were rejected by spice-ts.

const corpusG = resolve(import.meta.dirname, '../../../../benchmarks/corpus/corpus-g/fixtures');
const fixture = (path: string): string => readFileSync(resolve(corpusG, path), 'utf8');

const LEVEL1 = 'LEVEL=1 BETA=2.69e-5 VTO=-3.795 PB=1.07 LAMBDA=0.0181 B=0.605 IS=1.393e-10';
const LEVEL2 = 'LEVEL=2 BETA=0.000379 VTO=-3.760 PB=0.650 LAMBDA=0.0124 DELTA=0.37 IS=1.393e-10';

async function op(type: string, params: string, vd: number, vg: number, instance = '') {
  const result = await simulate(
    `JFET op\nVd d 0 ${vd}\nVg g 0 ${vg}\nJ1 d g 0 MOD ${instance}\n.model MOD ${type} ${params}\n.op\n.end`,
  );
  return { id: result.dc!.current('Vd'), ig: result.dc!.current('Vg') };
}

describe('PJF model type (#717)', () => {
  it('matches ngspice-47 for a level-1 PJF in saturation', async () => {
    // ngspice-47 -b: i(vd) = 1.906469e-04, i(vg) = -2.85597e-10
    const { id, ig } = await op('PJF', LEVEL1, -5, 1);
    expect(id).toBeCloseTo(1.906469e-4, 9);
    expect(ig).toBeCloseTo(-2.85597e-10, 14);
  });

  it('matches ngspice-47 for a level-1 PJF with reversed drain and a forward gate junction', async () => {
    // ngspice-47 -b: i(vd) = -3.48471e-02, i(vg) = 3.462474e-02
    const { id, ig } = await op('PJF', LEVEL1, 1, 0.5);
    expect(id / -3.48471e-2).toBeCloseTo(1, 5);
    expect(ig / 3.462474e-2).toBeCloseTo(1, 5);
  });

  it('matches ngspice-47 for a level-2 PJF', async () => {
    // ngspice-47 -b (same deck with TEMP=27): i(vd) = 3.030346e-03, i(vg) = -2.85600e-10
    const { id, ig } = await op('PJF', LEVEL2, -5, 1);
    expect(id / 3.030346e-3).toBeCloseTo(1, 5);
    expect(ig).toBeCloseTo(-2.856e-10, 14);
  });

  it('is the exact mirror of the NJF with every voltage negated', async () => {
    for (const [vd, vg] of [[5, -1], [1, -1], [-1, 0.3], [0.2, -4]]) {
      const n = await op('NJF', `${LEVEL1} RD=10 RS=5`, vd, vg);
      const p = await op('PJF', `${LEVEL1} RD=10 RS=5`, -vd, -vg);
      expect(p.id).toBeCloseTo(-n.id, 12);
      expect(p.ig).toBeCloseTo(-n.ig, 14);
    }
  });

  it('mirrors the NJF transient including gate charge', async () => {
    const deck = (type: string, sign: number) => `JFET tran
Vin g 0 PULSE(${sign * -4} 0 10n 5n 5n 100n 300n)
Vdd dd 0 ${sign * 10}
Rl dd d 1k
J1 d g 0 MOD
.model MOD ${type} ${LEVEL1} CGS=5p CGD=3p RD=20 RS=20
.tran 1n 200n
.end`;
    const n = await simulate(deck('NJF', 1));
    const p = await simulate(deck('PJF', -1));
    const vn = n.transient!.voltage('d');
    const vp = p.transient!.voltage('d');
    expect(vp.length).toBe(vn.length);
    for (let i = 0; i < vn.length; i++) expect(vp[i]).toBeCloseTo(-vn[i], 9);
  });

  it('rejects a PJF model on a non-J instance', () => {
    expect(() => parse('t\nM1 d g 0 0 MOD\n.model MOD PJF\nV1 d 0 1\n.op\n.end').compile())
      .toThrow(/MOD/);
  });
});

describe('JFET gate-junction thermal voltage (#717)', () => {
  it('matches ngspice-47 for a forward-biased NJF gate (vt = 300.15 K * k/q)', async () => {
    // ngspice-47 -b: i(vd) = 3.484713e-02, i(vg) = -3.46247e-02
    const { id, ig } = await op('NJF', LEVEL1, -1, -0.5);
    expect(id / 3.484713e-2).toBeCloseTo(1, 5);
    expect(ig / -3.46247e-2).toBeCloseTo(1, 5);
  });
});

describe('JFET instance TEMP= (#717)', () => {
  it('accepts TEMP equal to the nominal 27 C with an unchanged result', async () => {
    const plain = await op('NJF', LEVEL1, 5, -1);
    const withTemp = await op('NJF', LEVEL1, 5, -1, 'TEMP=27');
    expect(withTemp.id).toBe(plain.id);
    expect(withTemp.ig).toBe(plain.ig);
  });

  it('applies a non-nominal instance TEMP instead of silently running at 27 C', async () => {
    const nominal = await op('NJF', LEVEL1, 5, -1);
    const warm = await op('NJF', LEVEL1, 5, -1, 'TEMP=50');
    expect(Math.abs(warm.ig)).toBeGreaterThan(Math.abs(nominal.ig));
  });

  it('still rejects other instance keywords', () => {
    expect(() => parse('t\nJ1 d g 0 MOD DTEMP=3\n.model MOD NJF\n.op\n.end'))
      .toThrow("Unsupported JFET instance parameter: 'DTEMP=3'");
  });

  it('parses the unchanged corpus-g PJFET_DC/pjfet-2108.cir deck', () => {
    const compiled = parse(fixture('PJFET_DC/pjfet-2108.cir')).compile();
    expect(compiled.devices.some(device => device instanceof JFET)).toBe(true);
  });
});

describe('J cards inside .subckt bodies (#717)', () => {
  it('expands a J card in a subcircuit exactly like the flat netlist', async () => {
    const model = `.model JM NJF ${LEVEL1} RD=10 RS=5`;
    const flat = await simulate(`flat\nVd d 0 5\nVg g 0 -1\nJ1 d g 0 JM\n${model}\n.op\n.end`);
    const nested = await simulate(`nested
Vd d 0 5
Vg g 0 -1
X1 d g 0 cell
.subckt cell a b c
J1 a b c JM TEMP=27
${model}
.ends
.op
.end`);
    expect(nested.dc!.current('Vd')).toBe(flat.dc!.current('Vd'));
    expect(nested.dc!.current('Vg')).toBe(flat.dc!.current('Vg'));
  });

  it('compiles the unchanged corpus-g MEASURE/bad_dot_measure_line5.cir deck', () => {
    const compiled = parse(fixture('MEASURE/bad_dot_measure_line5.cir')).compile();
    expect(compiled.devices.some(device => device instanceof JFET)).toBe(true);
  });

  it('compiles the unchanged corpus-g PJFET_SWITCH/pjfet_tran.cir deck', () => {
    const compiled = parse(fixture('PJFET_SWITCH/pjfet_tran.cir')).compile();
    expect(compiled.devices.some(device => device instanceof JFET)).toBe(true);
  });
});
