import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { simulate } from '../../simulate.js';

const deck = (params = '') => `coupled microstrip
v1 source 0 dc 1 ac 1
rs source p1 50
r2 p2 0 75
r3 p3 0 60
r4 p4 0 40
a1 %hd(p1 0) %hd(p2 0) %hd(p3 0) %hd(p4 0) %vd(p1 0) %vd(p2 0) %vd(p3 0) %vd(p4 0) m
.model m cpmlin(w=1m l=20m s=.3m er=9.8 h=1m t=35u tand=1m rho=22n d=.15u model=0 disp=0 ${params})
`;

// ngspice-47 -n -b, same deck, set numdgt=17; complex error / reference magnitude.
const reference = [
  [[.5892451164929762, -.04772332727656118], [.4639802756244027, .10949646280345664], [.4039913897493047, -.06509646482709966]],
  [[.5844658310835724, -.12856276382127516], [-.3923737215437774, -.4254849956213017], [-.13512068713730488, .5460480899482241]],
  [[-.0001488525611232299, -.004032211438733043], [-.06214844143290839, .0493268322589655], [.13232370580562639, .0463582828184534]],
  [[.0025432118097820015, .012293374656852528], [.05755087195409608, -.02917089955169561], [.04046667646748682, .04764653125754324]],
  [[-.008215097670140477, -.0009544665455312237], [-.010720394487511947, .0021899292560691327], [-.011920172205013907, -.0013019292965419933]],
];

describe('XSPICE cpmlin OP/AC', () => {
  it('matches ngspice-47 ideal DC shorts with finite conductor resistivity', async () => {
    const { dc } = await simulate(`${deck()}.op\n.end`);
    expect(dc!.voltage('p1')).toBeCloseTo(.6, 9);
    expect(dc!.voltage('p2')).toBeCloseTo(.6, 9);
    expect(dc!.voltage('p3')).toBeCloseTo(0, 9);
    expect(dc!.voltage('p4')).toBeCloseTo(0, 9);
    expect(dc!.current('v1')).toBeCloseTo(-.008, 9);
  });
  it('matches ngspice-47 complex voltages and source current within 1e-6 relative', async () => {
    const { ac } = await simulate(`${deck()}.ac lin 3 .2g 4.2g\n.end`);
    const signals = ['p1', 'p2', 'p3', 'p4'].map(node => ac!.voltage(node));
    signals.push(ac!.current('v1'));
    signals.forEach((values, signal) => values.forEach((value, point) => {
      const angle = value.phase * Math.PI / 180;
      const [re, im] = reference[signal][point];
      expect(Math.hypot(value.magnitude * Math.cos(angle) - re, value.magnitude * Math.sin(angle) - im) / Math.hypot(re, im)).toBeLessThan(1e-6);
    }));
  });
  it('runs the unchanged corpus-f cpmline_ac.cir', async () => {
    const input = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/xspice/transmission_lines/cpmline_ac.cir', import.meta.url), 'utf8');
    const result = await simulate(input);
    expect(result.control!.runs.some(run => run.result.sParameters?.frequencies.length === 100)).toBe(true);
  });
  it('rejects transient explicitly rather than silently using DC equations', async () => {
    await expect(simulate(`${deck()}.tran 1p 10p\n.end`)).rejects.toThrow(/cpmlin.*OP.*AC/);
  });
  it.each(['model=1', 'disp=4'])('rejects unimplemented selector %s', async params => {
    await expect(simulate(`${deck(params)}.op\n.end`)).rejects.toThrow(/cpmlin.*model=0.*disp=0/);
  });
  it.each(['s=0', 'w=-1', 'er=1', 'rho=-1'])('rejects invalid geometry or material %s', async params => {
    await expect(simulate(`${deck(params)}.op\n.end`)).rejects.toThrow(/cpmlin requires/);
  });
});
