import { describe, expect, it } from 'vitest';
import { preprocess } from './preprocessor.js';
import { parseXspiceModelCard } from './xspice-parser.js';
import { ParseError } from '../errors.js';
import { parse } from './index.js';

describe('numparam bracketed vector parameters (#1405)', () => {
  it.each(['"[1.3m 2m]"', '[1.3m 2m]'])('preserves vector elements from %s for an XSPICE consumer', async value => {
    const text = await preprocess(`.param delays=${value}\n.model sum summer in_gain={delays}`);
    const model = parseXspiceModelCard(text.trim(), 2);
    expect(model.params.get('in_gain')).toEqual([1.3 * 1e-3, 2e-3]);
  });

  it('passes quoted vector aliases through subcircuit defaults and overrides', () => {
    const circuit = parse(`vectors
.param gains="[2 3]"
x1 a o sum gain={gains}
x2 a p sum
.subckt sum a o gain="[4 5]"
.model local pwl x_array=[0 1] y_array={gain}
a1 a o local
.ends
v1 a 0 1
v2 b 0 2
.op`);
    expect(() => circuit.compile()).not.toThrow();
  });

  it.each(['"[]"', '"[1 [2]]"', '"[1 bogus]"', '"[1 2]"'])('rejects invalid vectors or scalar use of %s with a typed source error', async value => {
    const error = await preprocess(`title\n.param v=${value}\nr1 a 0 {v+0}`).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as ParseError).line).toBeGreaterThanOrEqual(2);
  });

  it('rejects unsupported vector indexing at the use line', async () => {
    const error = await preprocess('title\n.param v="[1 2]"\nr1 a 0 {v[0]}').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as ParseError).line).toBe(3);
  });

  it('preserves bare vectors in multi-assignment cards and aliases', async () => {
    const text = await preprocess('.param a=[2 3] b=[4 5]\n.param alias=a\n.model s summer in_gain={alias} in_offset={b}');
    const model = parseXspiceModelCard(text.trim(), 3);
    expect(model.params.get('in_gain')).toEqual([2, 3]);
    expect(model.params.get('in_offset')).toEqual([4, 5]);
  });

  it('rejects direct vector use in a scalar device value without silently using zero', () => {
    expect(() => parse('title\n.param v="[1 2]"\nr1 a 0 {v}\n.op')).toThrow(ParseError);
  });
});
