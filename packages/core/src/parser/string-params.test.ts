import { describe, expect, it } from 'vitest';
import { preprocess } from './preprocessor.js';
import { parse } from './index.js';
import { readFileSync } from 'node:fs';
import { simulate } from '../simulate.js';

describe('numparam string parameters (#1259)', () => {
  it('substitutes quoted strings, aliases and concatenation without losing zeroes', async () => {
    const text = await preprocess('.param and="0001" or="0111"\n.param both=or{and}\n.model a d_lut table_values=and\n.model b d_lut table_values={both}');
    expect(text).toContain('table_values="0001"');
    expect(text).toContain('table_values="01110001"');
  });

  it('passes strings through subcircuit defaults, actuals and nested calls', () => {
    const circuit = parse(`strings
.param bits="0111"
x1 a b o gate table=bits
x2 a b p gate
.subckt gate a b o table="0001"
xinner a b o inner table=table
.ends
.subckt inner a b o table="0000"
.model lut d_lut table_values=table
ag [ a b ] o lut
.ends
.op`);
    expect(() => circuit.compile()).not.toThrow();
  });

  it('concatenates quoted atoms, preserves whitespace and rejects numeric string arithmetic', async () => {
    expect(await preprocess('.param a="00" b="11"{a}\n.model x d_lut table_values=b')).toContain('table_values="1100"');
    expect(await preprocess('.param a="hello world"\n.model x foo label=a')).toContain('label="hello world"');
    await expect(preprocess('.param a="01"\nR1 1 0 {a+1}')).rejects.toThrow('numeric expression');
  });

  it('runs the unchanged upstream strings.cir with ngspice-47 event values', async () => {
    const deck = readFileSync(new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/numparam/strings.cir', import.meta.url), 'utf8');
    const transient = (await simulate(deck)).transient!;
    expect(transient.time.length).toBe(192);
    // ngspice-47 source unchanged deck, then eprint o_both. Times in seconds.
    const expected = [0, 2.64e-9, 5.0365e-7, 1.00265e-6, 1.004e-6, 2.00265e-6, 3.50365e-6, 4.00265e-6];
    const events = transient.digital('o_both');
    expect(events.map(event => event.state)).toEqual(['1', '0', '1', '0', '1', '0', '1', '0']);
    events.forEach((event, i) => expect(Math.abs(event.time - expected[i])).toBeLessThan(1e-18));
  });
});
