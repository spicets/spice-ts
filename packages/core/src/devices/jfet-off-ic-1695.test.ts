import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { MNAAssembler } from '../mna/assembler.js';
import { JFET } from './jfet.js';
import { computeUICInitialSolution } from '../analysis/uic.js';

const deck = (level: number, polarity: number, instance: string, analysis = '.op') => `JFET initialization
V1 v 0 ${polarity * 5}
R1 v d 1k
RG g 0 10k
J1 d g 0 JM ${instance}
.model JM ${polarity === 1 ? 'NJF' : 'PJF'} LEVEL=${level} CGS=1n CGD=0.5n
${analysis}
.end`;

describe('JFET OFF and IC (#1695)', () => {
  it('preserves area, OFF and IC through netlist serialization and subcircuits', async () => {
    const source = deck(1, 1, '2 off ic=2,-1', '.tran 0.1u 10u uic');
    const circuit = parse(source);
    const serialized = circuit.toNetlist();
    expect(serialized).toMatch(/J1 d g 0 JM AREA=2 OFF IC=2,-1/i);
    const nested = source.replace('J1 d g 0 JM 2 off ic=2,-1',
      'X1 d g 0 cell\n.subckt cell d g s\nJ1 d g s JM 2 off ic=2,-1\n.ends');
    const a = await simulate(source);
    const b = await simulate(nested);
    expect(Array.from(a.transient!.voltage('g'))).toEqual(Array.from(b.transient!.voltage('g')));
  });
  for (const level of [1, 2]) for (const polarity of [1, -1] as const) {
    for (const instance of ['off', `ic=${polarity * 2},${polarity * -1}`, `2 off ic=${polarity * 2},${polarity * -1}`]) {
      it(`parses and converges level ${level} polarity ${polarity} ${instance}`, async () => {
        const actual = await simulate(deck(level, polarity, instance));
        const plain = await simulate(deck(level, polarity, instance.startsWith('2') ? '2' : ''));
        expect(actual.dc!.voltage('d')).toBeCloseTo(plain.dc!.voltage('d'), 9);
        expect(actual.dc!.current('V1')).toBeCloseTo(plain.dc!.current('V1'), 12);
      });
    }
    it(`uses device-local INITJCT/INITFIX bias level ${level} polarity ${polarity}`, () => {
      const stamp = (instance: string, phase?: 'junction' | 'fixed' | 'floating') => {
        const compiled = parse(deck(level, polarity, instance)).compile();
        const device = compiled.devices.find(d => d instanceof JFET)!;
        const a = new MNAAssembler(compiled.nodeCount, compiled.branchCount);
        a.solution.fill(polarity * 3);
        a.operatingPointPhase = phase;
        device.stamp(a.getStampContext());
        return Array.from(a.b);
      };
      expect(stamp('off', 'junction')).toEqual(stamp('off', 'fixed'));
      expect(stamp('off', 'junction')).not.toEqual(stamp('', 'junction'));
      expect(stamp('off', 'floating')).toEqual(stamp('', 'floating'));
      expect(stamp(`ic=${polarity * 2},${polarity * -1}`, 'junction')).toEqual(stamp('', 'junction'));
    });
    it(`seeds only UIC charge history level ${level} polarity ${polarity}`, async () => {
      const ic = `ic=${polarity * 2},${polarity * -1}`;
      const a = await simulate(deck(level, polarity, ic, '.tran 0.1u 10u uic'));
      const b = await simulate(deck(level, polarity, '', '.tran 0.1u 10u uic'));
      const va = a.transient!.voltage('g');
      const vb = b.transient!.voltage('g');
      if (level === 1) {
        // Identical deck, ngspice-47 first point at 1 ns (not a t=0 sample).
        expect(a.transient!.time[0]).toBe(1e-9);
        expect(Math.abs(va[0] / (polarity * -0.9957836607181637) - 1)).toBeLessThan(1e-6);
        expect(Math.abs(a.transient!.voltage('d')[0] / (polarity * 2.01575824009924) - 1)).toBeLessThan(1e-6);
      }
      // IC initializes local charge, not a global node constraint.
      expect(Array.from(computeUICInitialSolution(parse(deck(level, polarity, ic)).compile())))
        .toEqual(Array.from(computeUICInitialSolution(parse(deck(level, polarity, '')).compile())));
      expect(Math.max(...va.map((v, i) => Math.abs(v - vb[i])))).toBeGreaterThan(0.1);
      const normal = await simulate(deck(level, polarity, ic, '.tran 0.1u 10u'));
      const plain = await simulate(deck(level, polarity, '', '.tran 0.1u 10u'));
      expect(Array.from(normal.transient!.voltage('g'))).toEqual(Array.from(plain.transient!.voltage('g')));
    });
  }
  it.each(['ic=', 'ic=1', 'ic=1,2,3', 'ic=oops,2', 'ic=1,oops', 'off bogus', 'off off'])(
    'rejects malformed instance %s with a structured parse error', instance => {
      expect(() => parse(deck(1, 1, instance))).toThrow(ParseError);
    },
  );
});
