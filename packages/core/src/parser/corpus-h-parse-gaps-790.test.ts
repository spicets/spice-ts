import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.js';
import { simulate } from '../simulate.js';
import { parse } from './index.js';
import { parseNumber } from './tokenizer.js';

// Five small parse gaps found by corpus-h (#785, #790). Every deck below was
// run with `ngspice -b` (ngspice-47); the expected values are its output.

describe('#790 bare .probe', () => {
  // ngspice-47 inpcom.c: "Note: Empty .probe command, treated as .probe alli".
  // spice-ts returns every computed vector, so .probe alli narrows nothing.
  it('accepts a .probe card without arguments like .probe alli', async () => {
    const result = await simulate('bare probe\nV1 1 0 AC 1\nR1 1 2 1k\nR2 2 0 1k\n.ac dec 1 1 10\n.probe\n.end');
    expect(result.ac!.voltage('2')[0].magnitude).toBeCloseTo(0.5, 12);
  });
});

describe('#790 .options names ngspice-47 does not recognise', () => {
  // ngspice-47 if_option() silently returns for a name outside OPTtbl that no
  // cp_getvar() reads: `.options ysep foobar zork=3` runs unchanged.
  it('ignores them with a parse warning', () => {
    const circuit = parse('t\nV1 1 0 1\nR1 1 0 1k\n.options ysep foobar zork=3\n.op\n.end');
    expect(circuit.parseWarnings).toEqual([
      'Ignored .options fields ngspice-47 does not recognise: ysep foobar zork=3',
    ]);
  });

  it('applies the recognised fields on the same card', () => {
    const circuit = parse('t\nV1 1 0 1\nR1 1 0 1k\n.options ysep reltol=1e-4\n.op\n.end');
    expect(circuit.simulationOptions.reltol).toBe(1e-4);
  });

  it('still rejects option names ngspice-47 applies but spice-ts does not implement', () => {
    expect(() => parse('t\nV1 1 0 1\nR1 1 0 1k\n.options gminsteps=10\n.op\n.end'))
      .toThrow(ParseError);
    expect(() => parse('t\nV1 1 0 1\nR1 1 0 1k\n.options gminsteps=10\n.op\n.end'))
      .toThrow("Unsupported .options field: 'gminsteps'");
  });

  // ngspice-47 reads `interp` with cp_getvar() and interpolates the transient
  // rawfile onto the TSTEP grid ("Warning: Interpolated raw file data!"). It
  // changes the saved points, not the solution.
  it('accepts INTERP as an implemented output-only flag', () => {
    const circuit = parse('t\nV1 1 0 1\nR1 1 0 1k\n.option INTERP\n.tran 1u 10u\n.end');
    expect(circuit.parseWarnings).toHaveLength(0);
    expect(circuit.simulationOptions.interp).toBe(true);
  });
});

describe('#790 .four', () => {
  // ngspice-47 prints the Fourier table to stdout after .tran (and ignores
  // the card when it writes a rawfile); the transient vectors are unchanged.
  it('accepts .four after .tran and reports that the table is not computed', async () => {
    const result = await simulate(
      'four\nV1 1 0 SIN(0 1 1k)\nR1 1 2 1k\nR2 2 0 1k\n.tran 10u 2m\n.FOUR 1k V ( 2 )\n.end',
    );
    expect(result.transient).toBeDefined();
    const parseWarnings = result.warnings.filter(warning => warning.type === 'parse');
    expect(parseWarnings).toHaveLength(1);
    expect(parseWarnings[0].message).toMatch(/\.four/);
  });

  // ngspice-47 answers each of these with "Warning: no nodes given" and runs
  // the deck (Xyce FOURIER/bad_dot_four_line1.cir under `ngspice -b`).
  it('accepts a .four card without a frequency or an output with a warning, like ngspice-47', () => {
    for (const card of ['.four', '.four 1k', '.four v(1)']) {
      const circuit = parse(`t\nV1 1 0 1\nR1 1 0 1k\n.tran 1u 10u\n${card}\n.end`);
      expect(circuit.parseWarnings).toHaveLength(1);
    }
  });
});

describe('#790 trailing non-ASCII unit text on numbers', () => {
  // ngspice-47 INPevaluate stops at the first character that is not a digit,
  // exponent or scale factor and ignores the rest of the token.
  it('reads 27°C as 27', () => {
    expect(parseNumber('27°C')).toBe(27);
    expect(parseNumber('1kΩ')).toBe(1000);
  });

  it('accepts .options TEMP = 27°C and TNOM = 27°C (the ngspice defaults)', () => {
    const circuit = parse('t\nV1 1 0 1\nR1 1 0 1k\n.options TEMP = 27°C\n.options TNOM = 27°C\n.op\n.end');
    expect(circuit.temperature).toBe(27);
  });

  it('rejects nondefault circuit TNOM for unsupported diodes at compile time', () => {
    const circuit = parse('t\nV1 1 0 1\nR1 1 0 1k\nD1 1 0 DM\n.model DM D\n.options tnom=50\n.op\n.end');
    expect(() => circuit.compile()).toThrow(/TNOM=50/);
  });
});

describe('#790 bare .ic and .nodeset', () => {
  // pyspice issue-172.cir has a bare `.ic`; ngspice-47 runs a deck with bare
  // `.ic` and `.nodeset` cards unchanged (b = 1 V at t = 0 with `ngspice -b -r`).
  it('accepts them as empty initial-state cards', async () => {
    const result = await simulate('t\nV1 a 0 1\nR1 a b 1k\nC1 b 0 1u\n.ic\n.nodeset\n.tran 0.1m 1m\n.end');
    expect(result.transient!.voltage('b')[0]).toBeCloseTo(1, 12);
  });
});

describe('#790 parenthesised node pairs on controlled sources', () => {
  // ngspice-47 INPgetNetTok skips '(' and ',' before a node name and stops at
  // ')', so `E1 (out 0) (in 0) -10` is `E1 out 0 in 0 -10`.
  const deck = `paren node pairs
V1 in 0 0.25
R1 in 0 1k
E1 (eout 0) (in 0) -10
R2 eout 0 1k
G1 (0 gout) (in 0) 2m
R3 gout 0 1k
V2 a 0 0
R4 in a 1k
F1 (fout 0) V2 3
R5 fout 0 1k
H1 (hout 0) V2 2k
R6 hout 0 1k
X1 in sout amp
R7 sout 0 1k
.subckt amp i o
E1 (o 0) (i 0) 4
.ends
.op
.end`;

  it('matches ngspice-47 on E, G, F, H and a subcircuit E card', async () => {
    const result = await simulate(deck);
    const dc = result.dc!;
    expect(dc.voltage('eout')).toBeCloseTo(-2.5, 12);
    expect(dc.voltage('gout')).toBeCloseTo(0.5, 12);
    expect(dc.voltage('fout')).toBeCloseTo(-0.75, 12);
    expect(dc.voltage('hout')).toBeCloseTo(0.5, 12);
    expect(dc.voltage('sout')).toBeCloseTo(1, 12);
  });

  it('reads a POLY card written with node-pair parentheses (#845)', async () => {
    // spice2poly reads its tokens with MIFgettok, which skips '(' and ')'.
    const result = await simulate('t\nV1 1 0 1\nR1 1 0 1k\nE1 (2 0) POLY(1) 1 0 0 1\nR2 2 0 1k\n.op\n.end');
    expect(result.dc!.voltage('2')).toBeCloseTo(1, 12);
  });
});
