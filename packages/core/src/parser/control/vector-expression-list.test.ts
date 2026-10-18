import { describe, expect, it } from 'vitest';
import { parseVectorExpression, splitVectorExpressions } from './vector-expression.js';

describe('command vector expression lists', () => {
  it.each([
    ['v(out) + v(a) v(b)', ['v(out) + v(a)', 'v(b)']],
    ['v(a) v(out) + v(b)', ['v(a)', 'v(out) + v(b)']],
    ['(v(a) + v(b)) * 2 abs(v(out))', ['(v(a) + v(b)) * 2', 'abs(v(out))']],
    ['v(a)[0, length(v(a)) - 1] v(out)', ['v(a)[0, length(v(a)) - 1]', 'v(out)']],
    ['v(a) > 0 ? v(a) : -v(a) v(out)', ['v(a) > 0 ? v(a) : -v(a)', 'v(out)']],
  ])('splits %s only after complete expressions', (text, expected) => {
    expect(splitVectorExpressions(text)).toEqual(expected);
  });

  it.each(['v(out) +', '(v(out) v(a))', 'abs(v(out) v(a))', 'v(out) ]', ''])('rejects malformed list %s', text => {
    expect(() => splitVectorExpressions(text)).toThrow();
  });

  it('keeps single-expression parsing strict', () => {
    expect(() => parseVectorExpression('v(out) v(a)')).toThrow('unexpected operand');
  });
});
