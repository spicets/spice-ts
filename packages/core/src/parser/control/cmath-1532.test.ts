import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { complexVector, realVector, type ControlVector } from './vector.js';
import { evaluateVectorExpression, parseVectorExpression, UnsupportedExpressionFeature } from './vector-expression.js';

// Original MIT fixture. Regenerate: ngspice -b fixtures/cmath-1532.cir > fixtures/cmath-1532.out 2>&1
// ngspice-47 cmath1.c:93-136, cmath2.c:323-362,465-516, cmath4.c:489-564.
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/cmath-1532.${name}`, import.meta.url), 'utf8');
const rows = fixture('out').split('\n').filter(line => /^\d+\t/.test(line))
  .map(line => line.trim().split(/\s+/).slice(1).map(Number));
const references = Array.from({ length: 11 }, () => [] as number[]);
rows.forEach((row, index) => {
  const columns = index >= 5 ? [8, 9, 10] : index === 0 ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 5, 6, 7];
  columns.forEach((column, i) => references[column].push(row[i]));
});
const frequency = realVector('frequency', [1, 2, 3, 4, 5]);
const r = realVector('r', [-3, -1, 1, 3, 5], frequency);
const z = complexVector('z', r.re, [-1, 0, 1, 2, 3], frequency);
function evaluate(expression: string, v = z, degrees = false, scale = frequency): ControlVector {
  return evaluateVectorExpression(parseVectorExpression(expression), {
    lookup: () => v, userFunction: () => undefined, degrees: () => degrees, scale: () => scale,
  });
}
function matches(actual: ArrayLike<number>, expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, i) => expect(Math.abs(actual[i] - value)).toBeLessThanOrEqual(value === 0 ? 1e-14 : Math.abs(value) * 1e-12));
}

describe('ngspice-47 control vector functions (#1532)', () => {
  it('matches every printed real/complex reference in radians and degrees', () => {
    const values = [evaluate('avg(v)', r).re, evaluate('avg(v)').re, evaluate('avg(v)').im!,
      evaluate('stddev(v)', r).re, evaluate('stddev(v)').re, evaluate('cph(v)').re,
      evaluate('unwrap(v)', r).re, evaluate('group_delay(v)').re, evaluate('cph(v)', z, true).re,
      evaluate('unwrap(v)', realVector('v', [-300, -100, 100, 300, 500]), true).re,
      evaluate('group_delay(v)', z, true).re];
    values.forEach((value, i) => matches(value, references[i]));
  });
  it('runs the identical control deck end-to-end against the printed oracle', async () => {
    const result = await simulate(fixture('cir'));
    expect(result.control!.output).toHaveLength(11);
    result.control!.output.forEach((line, i) => matches(line.trim().split(/\s+/).map(Number), references[i]));
  });
  it('preserves scales, zeroes real cph and complex unwrap, and handles wrap ties', () => {
    expect(evaluate('avg(v)').scale).toBe(frequency);
    expect(evaluate('stddev(v)').im).toBeUndefined();
    matches(evaluate('cph(v)', r).re, [0, 0, 0, 0, 0]);
    matches(evaluate('unwrap(v)').re, [0, 0, 0, 0, 0]);
    matches(evaluate('unwrap(v)', realVector('v', [0, Math.PI, 0])).re, [0, -Math.PI, -2 * Math.PI]);
    expect(Number.isNaN(evaluate('stddev(v)', realVector('v', [1])).re[0])).toBe(true);
  });
  it('requires complex data and a matching frequency scale for group_delay', () => {
    expect(() => evaluate('group_delay(v)', r)).toThrow('complex');
    expect(() => evaluate('group_delay(v)', z, false, realVector('time', frequency.re))).toThrow('frequency');
    expect(() => evaluate('group_delay(v)', z, false, realVector('frequency', [1]))).toThrow('scale');
  });
  it('uses the current nonuniform complex frequency scale rather than the argument scale', () => {
    const scale = complexVector('frequency', [1, 2, 4, 7, 11], [0, 0, 0, 0, 0]);
    const phase = Array.from(scale.re, f => -0.02 * f * f);
    const signal = complexVector('v', phase.map(Math.cos), phase.map(Math.sin), frequency);
    matches(evaluate('group_delay(v)', signal, false, scale).re, Array.from(scale.re, f => 0.04 * f / (2 * Math.PI)));
    expect(evaluate('group_delay(v)', signal, false, scale).scale).toBe(scale);
    expect(() => evaluate('stddev(v)', realVector('v', []))).toThrow('at least one');
  });
  it.each(['sum', 'interpolate', 'rnd', 'poisson', 'exponential'])('keeps %s explicitly unsupported', name => {
    expect(() => evaluate(`${name}(v)`)).toThrow(UnsupportedExpressionFeature);
    try { evaluate(`${name}(v)`); } catch (error) { expect((error as UnsupportedExpressionFeature).feature).toBe(name); }
  });
});
