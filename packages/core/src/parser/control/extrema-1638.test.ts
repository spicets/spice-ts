import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { complexVector, realVector, type ControlVector } from './vector.js';
import { evaluateVectorExpression, parseVectorExpression } from './vector-expression.js';

function evaluate(expression: string, v: ControlVector): ControlVector {
  return evaluateVectorExpression(parseVectorExpression(expression), {
    lookup: () => v, userFunction: () => undefined, degrees: () => false,
  });
}

// ngspice-47 on fixtures/extrema-1638.cir: component-wise extrema, not magnitude.
// Regenerate with: spice-heavy ngspice -b packages/core/src/parser/control/fixtures/extrema-1638.cir
const references = ['5 -3 5 10 -3 -2 -7 -7 3 -4 3 -4'];

describe('maximum/minimum ngspice-47 parity (#1638)', () => {
  it.each(['maximum', 'minimum'])('reduces %s over real and complex components without a scale', name => {
    const scale = realVector('time', [0, 1, 2, 3, 4]);
    const re = [-3, -1, 1, 3, 5];
    const im = [10, 7, 4, 1, -2];
    const max = name === 'maximum';
    for (const input of [realVector('v', re, scale), complexVector('v', re, im, scale)]) {
      const result = evaluate(`${name}(v)`, input);
      expect([...result.re]).toEqual([max ? 5 : -3]);
      expect(result.im && [...result.im]).toEqual(input.im ? [max ? 10 : -2] : undefined);
      expect(result.scale).toBeUndefined();
      expect([...input.re]).toEqual(re);
    }
  });
  it.each(['maximum', 'minimum'])('preserves scalar %s values and rejects empty vectors', name => {
    expect([...evaluate(`${name}(v)`, realVector('v', [-7])).re]).toEqual([-7]);
    const result = evaluate(`${name}(v)`, complexVector('v', [3], [-4]));
    expect([...result.re]).toEqual([3]);
    expect([...result.im!]).toEqual([-4]);
    for (const input of [realVector('v', []), complexVector('v', [], [])]) {
      expect(() => evaluate(`${name}(v)`, input)).toThrow('at least one element');
    }
  });
  it('runs the identical oracle deck end-to-end', async () => {
    const deck = readFileSync(new URL('./fixtures/extrema-1638.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.control!.output).toEqual(references);
  });
  it('handles long vectors without spreading them into function arguments', () => {
    const input = realVector('v', new Float64Array(200_000).fill(-2));
    input.re[100_000] = 9;
    expect(evaluate('maximum(v)', input).re[0]).toBe(9);
    expect(evaluate('minimum(v)', input).re[0]).toBe(-2);
  });
});
