import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { complexVector, realVector, type ControlVector } from './vector.js';
import { evaluateVectorExpression, parseVectorExpression } from './vector-expression.js';

// ngspice-47, src/maths/cmaths/cmath4.c:246-433 (deriv), 439-489 (integ).
// Reproduce the printed reference with this identical deck (ngspice -b):
const referenceDeck = `Control calculus reference
V1 1 0 1
R1 1 0 1k
.control
set numdgt=15
let x = vector(6)
let x[0] = 0
let x[1] = 0.1
let x[2] = 0.4
let x[3] = 0.9
let x[4] = 1.5
let x[5] = 2.3
setscale x
let ramp = 2*x+1
let sine = sin(x)
let polynomial = x^3+2*x^2-3*x+5
let ir = integ(ramp)
let is = integ(sine)
let dp = deriv(polynomial)
print x ramp sine polynomial ir is dp
echo $&ir
echo $&is
echo $&dp
quit
.endc
.end
`;
const coordinates = [0, 0.1, 0.4, 0.9, 1.5, 2.3];
const references = {
  ir: [0, 0.11, 0.56, 1.71, 3.75, 7.59],
  is: [0, 0.004991670832341408, 0.07837943467566322, 0.3715657476596967, 0.9058123165291581, 1.603092396041468],
  dp: [-3.04, -2.54, -0.77, 3.33, 10.23, 20.95],
};
function evaluate(expression: string, v: ControlVector): ControlVector {
  return evaluateVectorExpression(parseVectorExpression(expression), {
    lookup: () => v, userFunction: () => undefined, degrees: () => false,
  });
}
function matches(actual: ArrayLike<number>, expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 11));
}

describe('control calculus (#1396)', () => {
  it.each(['time', 'frequency', 'v-sweep'])('uses the non-uniform %s scale', name => {
    const scale = realVector(name, coordinates);
    for (const [expression, values, expected] of [
      ['integ(v)', coordinates.map(x => 2 * x + 1), references.ir],
      ['integ(v)', coordinates.map(Math.sin), references.is],
      ['deriv(v)', coordinates.map(x => x ** 3 + 2 * x ** 2 - 3 * x + 5), references.dp],
    ] as const) {
      const result = evaluate(expression, realVector('v', values, scale));
      matches(result.re, expected);
      expect(result.scale).toBe(scale);
    }
  });

  it('matches quadratic endpoint derivatives without one-sided first differences', () => {
    const scale = realVector('time', coordinates);
    matches(evaluate('deriv(v)', realVector('v', coordinates.map(x => x * x), scale)).re,
      coordinates.map(x => 2 * x));
  });

  it('uses the real part of a complex scale', () => {
    const scale = complexVector('frequency', coordinates, coordinates.map(() => 0));
    matches(evaluate('integ(v)', realVector('v', coordinates.map(x => 2 * x + 1), scale)).re, references.ir);
  });

  it('integrates in scale order, including descending sweeps', () => {
    const scale = realVector('v-sweep', [2, 1, 0]);
    matches(evaluate('integ(v)', realVector('v', [5, 3, 1], scale)).re, [0, -4, -6]);
    matches(evaluate('deriv(v)', realVector('v', [4, 1, 0], scale)).re, [4, 2, 0]);
  });

  it.each([{ values: [1] }, { values: [1, 2] }])('matches ngspice zero derivative below three samples: $values', ({ values }) => {
    const scale = realVector('time', values.map((_, index) => index));
    matches(evaluate('deriv(v)', realVector('v', values, scale)).re, values.map(() => 0));
  });

  it('does not silently drop the imaginary part of a complex derivative', () => {
    expect(() => evaluate('deriv(v)', complexVector('v', [1, 2, 3], [1, 2, 3], realVector('time', [0, 1, 2]))))
      .toThrow('complex');
  });

  it.each(['integ(v)', 'deriv(v)'])('requires a matching scale for %s', expression => {
    expect(() => evaluate(expression, realVector('v', [1, 2, 3]))).toThrow('scale');
    expect(() => evaluate(expression, realVector('v', [1, 2, 3], realVector('time', [0, 1])))).toThrow('scale');
  });

  it('rejects complex integration as ngspice does', () => {
    expect(() => evaluate('integ(v)', complexVector('v', [1, 2, 3], [1, 2, 3], realVector('time', [0, 1, 2]))))
      .toThrow('complex');
  });

  it('rejects repeated derivative coordinates instead of returning non-finite values', () => {
    expect(() => evaluate('deriv(v)', realVector('v', [1, 2, 3], realVector('time', [0, 0, 1]))))
      .toThrow('scale');
  });

  it('evaluates the identical ngspice reference deck, including setscale on constructed vectors', async () => {
    const result = await simulate(referenceDeck);
    expect(result.control!.output).toHaveLength(3);
    Object.values(references).forEach((expected, index) => {
      matches(result.control!.output[index].split(/\s+/).map(Number), expected);
    });
  });

  it('runs unchanged corpus-f integrate1.cir including all three integ calls', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/various/integrate1.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.control!.runs).toHaveLength(1);
    expect(result.control!.measurements.some(measurement => measurement.name === 'yint')).toBe(true);
  });
});
