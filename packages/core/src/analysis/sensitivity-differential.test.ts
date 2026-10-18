import { describe, expect, it } from 'vitest';
import { InvalidCircuitError, ParseError } from '../errors.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';

// Self-written small-signal differential pair, using linear transconductors.
// One excitation and unequal loads prevent a zero-output symmetry oracle.
export const differentialPair = `Differential small-signal pair sensitivity
V1 in 0 DC 1 AC 1
G1 a 0 in tail 1m
G2 b 0 tail in 2m
R1 a 0 1k
R2 b 0 2k
Rtail tail 0 500
C1 a 0 1u
C2 b 0 2u
.sens v(a,b)
.end
`;

export const acDifferentialPair = differentialPair.replace('.sens v(a,b)', '.sens v(a,b) ac dec 1 10 1000');

describe('differential voltage sensitivity (#812, ticket 720)', () => {
  it('matches ngspice-47 DC sensitivities on the identical self-written deck', async () => {
    // ngspice -b -r output.raw input.cir, native mode. One-sided native
    // differences differ from our symmetric differences by about 1e-6.
    const expected = [0, 0, 0, 0, -999.999999907325, -1999.99999981465,
      -0.0009999990000560816, 0.999999999907325, -0.9999989998392411,
      -0.001999998000112163, 3.9999999996293, -3.999995999356964,
      0, 0, 0, -4.999999999588667];
    const result = (await simulate(differentialPair)).sensitivity!;
    expect(result.entries).toHaveLength(expected.length);
    result.entries.forEach((entry, index) => {
      if (expected[index] === 0) expect(entry.dc).toBe(0);
      else expect(Math.abs((entry.dc! - expected[index]) / expected[index])).toBeLessThan(1e-5);
    });
  });

  it('matches ngspice-47 complex differential derivatives at 10 Hz', async () => {
    // Native reference from the identical AC deck. Later-frequency native
    // disagreements are reported in the PR, not asserted away as parity.
    const result = (await simulate(acDifferentialPair)).sensitivity!;
    for (const [device, re, im] of [
      ['G2', -1881.174718045439, 472.790773946432],
      ['C1', 7833.708943756773, 62092.5718324234],
    ] as const) {
      const value = result.entries.find(entry => entry.device === device)!.ac![0];
      expect(Math.hypot(value.real - re, value.imaginary - im) / Math.hypot(re, im))
        .toBeLessThan(1e-5);
    }
  });

  it('matches the analytic differential AC source derivative at every frequency', async () => {
    const result = (await simulate(acDifferentialPair)).sensitivity!;
    const values = result.entries.find(entry => entry.device === 'V1')!.ac!;
    result.frequencies.forEach((frequency, index) => {
      const x = 2 * Math.PI * frequency * 0.001;
      const y = 4 * x;
      expect(values[index].real).toBeCloseTo(-1 / (1 + x * x) - 4 / (1 + y * y), 8);
      expect(values[index].imaginary).toBeCloseTo(x / (1 + x * x) + 4 * y / (1 + y * y), 8);
    });
  });

  it('has parser/programmatic parity and preserves LIN/OCT sweeps', async () => {
    for (const variation of ['lin', 'oct'] as const) {
      const circuit = parse(differentialPair.replace('.sens v(a,b)\n', ''));
      circuit.addAnalysis('sens', {
        outputNode: 'A', outputReferenceNode: 'B', mode: 'ac', variation,
        points: 2, startFreq: 10, stopFreq: 100,
      });
      expect(parse(circuit.toNetlist()).analyses).toEqual(circuit.analyses);
      expect((await simulate(circuit)).sensitivity)
        .toEqual((await simulate(circuit.toNetlist())).sensitivity);
    }
  });

  it('supports differential control-language sensitivity', async () => {
    const deck = differentialPair.replace('.sens v(a,b)', '.control\nsens v(a,b) dc\n.endc');
    expect((await simulate(deck)).sensitivity!.entries)
      .toEqual((await simulate(differentialPair)).sensitivity!.entries);
  });

  it('rejects an empty programmatic reference', () => {
    const circuit = parse(differentialPair.replace('.sens v(a,b)\n', ''));
    expect(() => circuit.addAnalysis('sens', {
      outputNode: 'a', outputReferenceNode: '', mode: 'dc',
    })).toThrow(InvalidCircuitError);
  });

  it.each([differentialPair, acDifferentialPair])('preserves both output nodes through serialization', deck => {
    const circuit = parse(deck);
    expect(circuit.analyses.at(-1)).toMatchObject({
      type: 'sens', outputNode: 'a', outputReferenceNode: 'b',
    });
    expect(parse(circuit.toNetlist()).analyses).toEqual(circuit.analyses);
  });

  it.each([differentialPair, acDifferentialPair])('subtracts the reference in DC and complex AC', async deck => {
    const result = (await simulate(deck)).sensitivity!;
    const positive = (await simulate(deck.replace('v(a,b)', 'v(a)'))).sensitivity!;
    const negative = (await simulate(deck.replace('v(a,b)', 'v(b)'))).sensitivity!;
    expect(result).toMatchObject({ outputNode: 'a', outputReferenceNode: 'b' });
    for (const [index, entry] of result.entries.entries()) {
      if (entry.dc !== undefined) {
        expect(entry.dc).toBeCloseTo(positive.entries[index].dc! - negative.entries[index].dc!, 6);
      } else {
        entry.ac!.forEach((value, point) => {
          const re = positive.entries[index].ac![point].real - negative.entries[index].ac![point].real;
          const im = positive.entries[index].ac![point].imaginary - negative.entries[index].ac![point].imaginary;
          const scale = Math.max(1, Math.hypot(re, im));
          expect(Math.hypot(value.real - re, value.imaginary - im) / scale).toBeLessThan(1e-5);
        });
      }
    }
  });

  it.each(['v(a,0)', 'v(0,a)', 'v(a,a)', 'v(0)'])('handles ground and equal nodes: %s', async output => {
    const deck = differentialPair.replace('v(a,b)', output);
    const result = (await simulate(deck)).sensitivity!;
    const single = (await simulate(differentialPair.replace('v(a,b)', 'v(a)'))).sensitivity!;
    result.entries.forEach((entry, index) => {
      const sign = output === 'v(a,0)' ? 1 : output === 'v(0,a)' ? -1 : 0;
      expect(entry.dc).toBeCloseTo(sign * single.entries[index].dc!, 7);
    });
  });

  it('rejects nonexistent reference nodes instead of treating them as ground', async () => {
    await expect(simulate(differentialPair.replace('v(a,b)', 'v(a,absent)')))
      .rejects.toThrow(InvalidCircuitError);
  });

  it.each(['i(V1,V2)', 'v(a,b,c)', 'v(a,b) tran 1u 1m'])('keeps unsupported forms structured: %s', output => {
    expect(() => parse(differentialPair.replace('v(a,b)', output))).toThrow(ParseError);
    expect(() => parse(differentialPair.replace('v(a,b)', output))).toThrow(/Unsupported .sens form/);
  });
});
