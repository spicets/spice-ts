import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';

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

describe('XSPICE cpline OP/AC', () => {
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
  it.each([`${deck()}.tran 1p 10p\n.end`, fixture('cpline_tran')])('rejects transient explicitly with a typed error', async input => {
    await expect(simulate(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_XSPICE_CPLINE', message: expect.stringMatching(/cpline.*transient/i) });
  });
  it.each(['ze=0', 'zo=-1', 'l=0', 'ere=0', 'ero=-1', 'ae=-1', 'ao=-1'])('rejects invalid parameter %s', async params => {
    await expect(simulate(`${deck(params)}.op\n.end`)).rejects.toThrow(/cpline requires/);
  });
});
