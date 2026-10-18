import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';

const fixture = (name: string): string => readFileSync(resolve(
  process.cwd(),
  `../../benchmarks/vbic-substrate/${name}`,
), 'utf8');

// ngspice-47 `ngspice -b dc.cir` on the committed fixture (print precision).
// The fixture sets `.options reltol=1e-6` for both engines so each sweep
// point is converged well below the 1e-4 comparison tolerance.
// Columns: VSUB, v(2), i(vcc), i(vb), i(vsub). Reverse substrate bias through
// the onset of substrate-junction forward conduction: the reverse points are
// pure gmin leakage across the substrate junction (ngspice vbicload.c Ibcp).
const NGSPICE_DC = [
  [-1, 1.713223, -2.86777e-4, -3.79292e-6, 2.710354e-12],
  [0, 1.713223, -2.86777e-4, -3.79292e-6, 1.710355e-12],
  [1, 1.713223, -2.86777e-4, -3.79292e-6, 7.103568e-13],
  [1.8, 1.713223, -2.86777e-4, -3.79292e-6, -1.21642e-13],
  [2, 1.713223, -2.86777e-4, -3.79285e-6, -7.32986e-11],
  [2.1, 1.713223, -2.86777e-4, -3.78944e-6, -3.48749e-9],
  [2.2, 1.713207, -2.86793e-4, -3.62653e-6, -1.66631e-7],
  [2.3, 1.712451, -2.87549e-4, 4.341919e-6, -8.14662e-6],
] as const;

// ngspice-47 `ngspice -b ac.cir`: vdb(5), vp(5), db(i(vmeas)), ph(i(vmeas)) (radians).
const NGSPICE_AC = [
  [1e5, -19.2656, -2.55622, 32.67930, 2.901469e-2],
  [1e6, -4.69479, -1.73480, 32.68292, -3.14615e-3],
  [1e7, 15.17948, -1.66230, 32.66772, -6.07298e-2],
  [1e8, 33.78911, -2.27091, 31.36288, -5.52465e-1],
  [1e9, 34.84196, 2.154110, 17.01934, -1.54961],
  [1e10, 19.77673, 0.4403593, -3.60092, -2.81241],
] as const;

function expectNear(actual: number, expected: number, absolute: number): void {
  // 1e-4 relative: above ngspice's 6-significant-digit print precision.
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-4 * Math.abs(expected) + absolute);
}

describe('bounded VBIC substrate terminal (issue #453)', () => {
  it('honours a non-ground substrate node in DC like ngspice-47', async () => {
    const result = await simulate(fixture('dc.cir'));
    const sweep = result.dcSweep!;
    const vsub = Array.from(sweep.sweepValues);
    for (const [value, v2, icc, ib, isub] of NGSPICE_DC) {
      const index = vsub.findIndex(v => Math.abs(v - value) < 1e-9);
      expect(index, `VSUB=${value}`).toBeGreaterThanOrEqual(0);
      expectNear(sweep.voltage('2')[index], v2, 1e-6);
      expectNear(sweep.current('Vcc')[index], icc, 1e-15);
      expectNear(sweep.current('Vb')[index], ib, 1e-15);
      expectNear(sweep.current('Vsub')[index], isub, 1e-16);
    }
  });

  // Issue #472: driving the substrate further forward latches the NPN +
  // parasitic PNP pair. ngspice-47 snaps from v(2)=1.702 V at VSUB=2.36 to
  // 0.1441 V at 2.37 and stays on the latched branch.
  it('follows ngspice-47 through the substrate latch-up fold (dc-latchup.cir)', async () => {
    const result = await simulate(fixture('dc-latchup.cir'));
    const sweep = result.dcSweep!;
    const index = Array.from(sweep.sweepValues).findIndex(v => Math.abs(v - 2.4) < 1e-9);
    expectNear(sweep.voltage('2')[index], 1.463217e-1, 1e-6);
  });

  // ngspice-47 on dc-latchup.cir with only the .dc card changed to
  // `.dc Vsub 2.3 2.45 0.01`: VSUB, v(2), i(vb). The fold sits between 2.36
  // and 2.37 V; the points next to it need ngspice's CKTop gmin homotopy.
  const NGSPICE_FOLD = [
    [2.35, 1.706825, 6.309587e-5],
    [2.36, 1.702303, 1.095791e-4],
    [2.37, 1.441072e-1, 3.108478e-2],
    [2.38, 1.448444e-1, 3.120126e-2],
    [2.45, 1.500167e-1, 3.200937e-2],
  ] as const;

  it('resolves the latch-up fold on a 10 mV grid where ngspice-47 does', async () => {
    const netlist = fixture('dc-latchup.cir').replace(/^\.dc .*$/m, '.dc Vsub 2.3 2.45 0.01');
    const sweep = (await simulate(netlist)).dcSweep!;
    const vsub = Array.from(sweep.sweepValues);
    for (const [value, v2, ib] of NGSPICE_FOLD) {
      const index = vsub.findIndex(v => Math.abs(v - value) < 1e-9);
      expect(index, `VSUB=${value}`).toBeGreaterThanOrEqual(0);
      // ngspice prints 7 significant digits and converges to its reltol=1e-3.
      expect(Math.abs(sweep.voltage('2')[index] - v2), `v(2) at ${value}`).toBeLessThan(1e-5);
      expect(Math.abs(sweep.current('Vb')[index] / ib - 1), `i(vb) at ${value}`).toBeLessThan(1e-3);
    }
  });

  it('honours a non-ground substrate node in AC like ngspice-47', async () => {
    const result = await simulate(fixture('ac.cir'));
    const ac = result.ac!;
    const frequencies = Array.from(ac.frequencies);
    const substrate = ac.voltage('5');
    const meter = ac.current('Vmeas');
    for (const [frequency, subDb, subPhase, meterDb, meterPhase] of NGSPICE_AC) {
      const index = frequencies.findIndex(f => Math.abs(f / frequency - 1) < 1e-9);
      expect(index, `f=${frequency}`).toBeGreaterThanOrEqual(0);
      const sub = substrate[index];
      const meas = meter[index];
      expect(Math.abs(20 * Math.log10(sub.magnitude) - subDb)).toBeLessThan(1e-3);
      expect(Math.abs(sub.phase * Math.PI / 180 - subPhase)).toBeLessThan(1e-4);
      expect(Math.abs(20 * Math.log10(meas.magnitude) - meterDb)).toBeLessThan(1e-3);
      expect(Math.abs(meas.phase * Math.PI / 180 - meterPhase)).toBeLessThan(1e-4);
    }
  });

  it('keeps the substrate pin and model of a four-node Q card inside a subcircuit', async () => {
    const flat = fixture('dc.cir');
    const wrapped = flat
      .replace('Q1 2 1 0 4 N1', '.subckt VQ c b e s\nQ1 c b e s N1\n.ends\nX1 2 1 0 4 VQ');
    const [expected, actual] = await Promise.all([simulate(flat), simulate(wrapped)]);
    const reference = expected.dcSweep!.current('Vsub');
    const result = actual.dcSweep!.current('Vsub');
    expect(result).toHaveLength(reference.length);
    reference.forEach((value, index) => expectNear(result[index], value, 1e-18));
  });

  it('accepts a five-terminal (thermal node) VBIC instance', async () => {
    const netlist = fixture('dc.cir').replace('Q1 2 1 0 4 N1', 'Q1 2 1 0 4 tnode N1');
    const result = await simulate(netlist);
    expect(Array.from(result.dcSweep!.voltage('tnode')).every(Number.isFinite)).toBe(true);
  });

  it('rejects a five-terminal non-VBIC BJT instance with a typed error', async () => {
    const netlist = [
      'five terminal gummel-poon',
      'Vcc 3 0 2', 'Rc 3 2 1k', 'Vb 1 0 0.7',
      'Q1 2 1 0 0 tnode QN',
      '.model QN NPN IS=1e-16',
      '.op', '.end',
    ].join('\n');
    await expect(simulate(netlist)).rejects.toThrow(InvalidCircuitError);
  });
});
