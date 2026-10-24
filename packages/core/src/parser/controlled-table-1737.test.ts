// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { ParseError } from '../errors.js';
import { parse } from './index.js';

// The valid TABLE lowering predates #1737 (#1011); the remaining syntax gap
// was accepting a table with no assignment separator at all.
describe('E/G TABLE assignment syntax (#1737)', () => {
  it.each(['E', 'G'])('rejects a missing = in %s TABLE with source context', type => {
    const card = `${type}lookup out 0 TABLE {v(in)} (-1,-2) (0,0) (1,3)`;
    let caught: unknown;
    try { parse(`MIT missing assignment\n${card}\n.end`); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ParseError);
    expect((caught as ParseError).message).toMatch(/TABLE.*=/);
    expect((caught as ParseError).line).toBe(2);
    expect((caught as ParseError).context).toBe(card);
  });
});

// ngspice-47 inp_compat: TABLE lowers through pwl with input_domain=.1,
// fraction=TRUE, limit=TRUE. Equal-width segments have quadratic corner
// regions of half-width .1, including the two clamped endpoints.
function transfer(x: number): number {
  const corner = (v: number): number => v <= -.1 ? 0 : v >= .1 ? v : (v + .1) ** 2 / .4;
  return -2 + 2 * corner(x + 1) + corner(x) - 3 * corner(x - 1);
}

describe('E/G smoothed TABLE analysis parity (#1737)', () => {
  const deck = readFileSync(new URL('./controlled-table-1737.cir', import.meta.url), 'utf8');

  it('interpolates and clamps across the DC sweep, including all smoothing regions', async () => {
    const result = (await simulate(deck)).dcSweep!;
    expect(result.sweepValues.length).toBe(161);
    for (const [i, x] of result.sweepValues.entries()) {
      expect(result.voltage('eout')[i]).toBeCloseTo(transfer(x), 10);
      expect(result.voltage('gout')[i]).toBeCloseTo(-transfer(x), 10);
    }
  });

  it('uses the same transfer during transient input ramps', async () => {
    const result = (await simulate(deck)).transient!;
    expect(result.time.length).toBeGreaterThan(100);
    for (const [i, x] of result.voltage('in').entries()) {
      expect(result.voltage('eout')[i]).toBeCloseTo(transfer(x), 10);
      expect(result.voltage('gout')[i]).toBeCloseTo(-transfer(x), 10);
    }
  });

  it('uses the smoothed OP value and its small-signal slope in E and G AC', async () => {
    const result = await simulate(deck);
    expect(result.dc!.voltage('eout')).toBeCloseTo(.025, 10);
    expect(result.dc!.voltage('gout')).toBeCloseTo(-.025, 10);
    expect(result.ac!.voltage('eout')[0].magnitude).toBeCloseTo(2.5, 10);
    expect(result.ac!.voltage('gout')[0].magnitude).toBeCloseTo(2.5, 10);
    expect(result.ac!.voltage('eout')[0].phase).toBeCloseTo(0, 10);
    expect(Math.abs(result.ac!.voltage('gout')[0].phase)).toBeCloseTo(180, 10);
  });

  it.each([[-2, 0], [-1, 1], [0, 2.5], [.5, 3], [1, 1.5], [2, 0]])('linearizes both transfers at OP %s with slope %s', async (input, slope) => {
    const result = await simulate(deck.replace('DC 0 AC 1', `DC ${input} AC 1`));
    expect(result.dc!.voltage('eout')).toBeCloseTo(transfer(input), 10);
    expect(result.dc!.voltage('gout')).toBeCloseTo(-transfer(input), 10);
    expect(result.ac!.voltage('eout')[0].magnitude).toBeCloseTo(slope, 10);
    expect(result.ac!.voltage('gout')[0].magnitude).toBeCloseTo(slope, 10);
  });

  it.each(['E', 'G'])('retains the compatibility %s TABLE = {expr} spelling', type => {
    expect(() => parse(`MIT compatibility\n${type}lookup out 0 TABLE = {v(in)} (-1,-2) (1,3)\n.end`)).not.toThrow();
  });

  it.each(['E', 'G'])('rejects odd table coordinates in %s with a structured error', type => {
    expect(() => parse(`MIT odd table\n${type}lookup out 0 TABLE {v(in)} = (-1,-2) (0,0) (1)\n.end`)).toThrow(ParseError);
  });
});
