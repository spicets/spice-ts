import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';
import { cpline } from './cpline.js';
import type { CodeModelCall } from './models.js';

// Project-authored oracle. ngspice-47: ngspice -n -b cpline-oracle.cir,
// using this identical deck with .control: set numdgt=17; op;
// print v(p1) v(p2) v(p3) v(p4) i(v1); ac lin 3 .2g 4.2g;
// print v(p1) v(p2) v(p3) v(p4) i(v1). No tolerance tuning.
const deck = (params = '') => `project-authored coupled line oracle
v1 source 0 dc 1 ac 1
rs source p1 50
r2 p2 0 75
r3 p3 0 60
r4 p4 0 40
a1 %hd(p1 0) %hd(p2 0) %hd(p3 0) %hd(p4 0) %vd(p1 0) %vd(p2 0) %vd(p3 0) %vd(p4 0) m
.model m cpline(ze=84.48 zo=53.99 l=25m ere=3.34 ero=2.829 ae=2 ao=5 ${params})
`;
const reference = [
  [[.5982500084073048, -.008410196252830182], [.5492780056618622, .017058905553455454], [.5941442406716038, -.024954627116824793]],
  [[.5863865776344881, -.11015823330921314], [-.25489891250986285, -.5356081100917957], [-.4382768503717389, .38284423459051714]],
  [[-.0014460874506474195, -.008473789922370521], [-.024248874959187792, .030728231700616178], [.07172279556242524, .06353929880276679]],
  [[.003813713213247033, .017220546003033074], [.07651554941573781, -.035370225298574476], [.04245287751867875, .043190501740887316]],
  [[-.008034999831853905, -.00016820392505660365], [-.009014439886762756, .0003411781110691091], [-.008117115186567925, -.0004990925423364958]],
];
const fixture = (name: string) => readFileSync(new URL(`../../../../../benchmarks/corpus/corpus-f/fixtures/examples/xspice/transmission_lines/${name}.cir`, import.meta.url), 'utf8');

describe('XSPICE cpline OP/AC/TRAN', () => {
  it('matches ngspice-47 DC shorts, including with attenuation', async () => {
    const { dc } = await simulate(`${deck()}.op\n.end`);
    for (const node of ['p1', 'p2']) expect(dc!.voltage(node)).toBeCloseTo(.6, 9);
    for (const node of ['p3', 'p4']) expect(dc!.voltage(node)).toBeCloseTo(0, 9);
    expect(dc!.current('v1')).toBeCloseTo(-.008, 9);
  });
  it('matches ngspice-47 complex AC voltages and source current within 1e-6 relative', async () => {
    const { ac } = await simulate(`${deck()}.ac lin 3 .2g 4.2g\n.end`);
    const signals = ['p1', 'p2', 'p3', 'p4'].map(node => ac!.voltage(node));
    signals.push(ac!.current('v1'));
    signals.forEach((values, signal) => values.forEach((value, point) => {
      const angle = value.phase * Math.PI / 180;
      const [re, im] = reference[signal][point];
      expect(Math.hypot(value.magnitude * Math.cos(angle) - re, value.magnitude * Math.sin(angle) - im) / Math.hypot(re, im)).toBeLessThan(1e-6);
    }));
  });
  it('runs the unchanged lossless corpus-f AC fixture', async () => {
    const result = await simulate(fixture('cpline_ac'));
    expect(result.control!.runs.some(run => run.result.sParameters?.frequencies.length === 100)).toBe(true);
  });
  it.each([
    ['even', 1, 1, .5, .5],
    ['odd', 2, -2, .5, -.5],
    ['combined', 3, -1, 1, 0],
  ] as const)('propagates a matched %s-mode step with analytical delay and amplitude', async (_mode, drive1, drive4, out2, out3) => {
    // Z_even=100, Z_odd=50: each end is matched by 100 ohms to
    // ground and 200 ohms between conductors. The sources feed the same
    // network, so its modal Norton drives launch .5 V in the selected mode.
    // cfunc.mod:179 uses l/C0 for BOTH modes, ignoring ere/ero in TRAN.
    const { transient: tran } = await simulate(`matched coupled modal step
v1 s1 0 pulse(0 ${drive1} 3n 10p 10p 10n)
v4 s4 0 pulse(0 ${drive4} 3n 10p 10p 10n)
rs1 s1 p1 100
rs4 s4 p4 100
rs14 p1 p4 200
rl2 p2 0 100
rl3 p3 0 100
rl23 p2 p3 200
a1 %hd(p1 0) %hd(p2 0) %hd(p3 0) %hd(p4 0) %vd(p1 0) %vd(p2 0) %vd(p3 0) %vd(p4 0) m
.model m cpline(ze=100 zo=50 l=.299792458 ere=4 ero=9)
.tran 2p 6n 0 2p
.end`);
    for (const [time, expected2, expected3] of [[3.5e-9, 0, 0], [4.1e-9, out2, out3], [5.5e-9, out2, out3]]) {
      const index = tran!.time.findIndex(t => t >= time);
      expect(Math.abs(tran!.voltage('p2')[index] - expected2)).toBeLessThan(1e-6);
      expect(Math.abs(tran!.voltage('p3')[index] - expected3)).toBeLessThan(1e-6);
    }
  });
  it('runs the unchanged corpus-f transient fixture', async () => {
    const { transient: tran } = await simulate(fixture('cpline_tran'));
    expect(tran!.time.at(-1)).toBeCloseTo(5e-9, 18);
    for (const node of ['p1', 'p2', 'p3', 'p4']) expect(tran!.voltage(node).every(Number.isFinite)).toBe(true);
  });
  it('keeps coupled ceiling history isolated from Newton retries, rollback and reset', () => {
    const behavior = cpline(new Map(Object.entries({ ze: 100, zo: 50, l: .299792458, ere: 4, ero: 9, ae: 2, ao: 5 }).map(([key, value]) => [key, [value]])));
    const call = (time: number, inputs: Float64Array = new Float64Array(8)): CodeModelCall => ({
      time, delta: .1e-9, analysis: 'tran', init: false, inputs,
      outputs: new Float64Array(4), partials: new Float64Array(32), notConverged() {},
    });
    behavior.accept!(call(0));
    const first = call(.2e-9, Float64Array.of(.01, .02, .03, .04, 1, 2, 3, 4));
    behavior.load(first);
    expect([...first.outputs, ...first.partials].every(value => value === 0)).toBe(true);
    behavior.load(call(.2e-9, new Float64Array(8).fill(999))); // later Newton guess
    behavior.accept!(call(.2e-9, new Float64Array(8).fill(999)));
    behavior.load(call(.5e-9, new Float64Array(8).fill(999))); // rejected future trial
    const delayed = call(1.1e-9);
    behavior.load(delayed);
    behavior.load(delayed);
    expect([...delayed.outputs]).toEqual([4.25, 2.75, 7.25, 5.75]);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) {
      expect(delayed.partials[row * 8 + col]).toBe(col === row ? 75 : col === (row ^ 3) ? 25 : 0);
    }
    behavior.accept!(call(.2e-9)); // replace the accepted point on rollback
    behavior.load(delayed);
    expect([...delayed.outputs]).toEqual([0, 0, 0, 0]);
    behavior.reset!();
    const coarse = call(2e-9, first.inputs);
    behavior.load(coarse); // no accepted ceiling sample: current-trial fallback
    expect([...coarse.outputs]).toEqual([6, 5, 10, 9]);
    behavior.reset!();
    behavior.load(delayed);
    expect([...delayed.outputs]).toEqual([0, 0, 0, 0]);
  });
  it.each(['ze=0', 'zo=-1', 'l=0', 'ere=0', 'ero=-1', 'ae=-1', 'ao=-1'])('rejects invalid parameter %s', async params => {
    await expect(simulate(`${deck(params)}.op\n.end`)).rejects.toThrow(/cpline requires/);
  });
});
