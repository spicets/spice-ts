import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { complexVector, realVector, type ControlVector } from './vector.js';
import { evaluateVectorExpression, parseVectorExpression } from './vector-expression.js';

const time = [0, 0.1, 0.4, 0.9, 1.5, 2.3];
const values = [1, 3, -2, 4, 2, 7];
// ngspice-47 cx_mtimeavg (cmath4.c:1025-1138), printed with numdgt=15.
// These are NOT trapezoidal means: native uses left rectangles and its own
// boundary corrections, including an extra sample interval on either side.
const references = [
  [1, [8.8, 7, 4, 2.526315789473684, 1.384615384615385, 15.2]],
  [0.2, [4, 14, 8.8, 4, 1.111111111111111, 92]],
  [10, [0.8, 0.7843137254901962, 0.7407407407407407, 0.6779661016949152, 0.6153846153846154, 0.547945205479452]],
] as const;
const assignments = (name: string, data: number[]): string =>
  `let ${name} = vector(${data.length})\n${data.map((value, i) => `let ${name}[${i}] = ${value}`).join('\n')}`;
const referenceDeck = `mtimeavg reference
V1 1 0 1
R1 1 0 1k
.control
set numdgt=15
tran 0.1 3
${assignments('time', time)}
setscale time
${assignments('signal', values)}
${references.map(([window], i) => `set mtimeavgwindow=${window}\nlet a${i} = mtimeavg(signal)\necho $&a${i}`).join('\n')}
unset mtimeavgwindow
let defaultavg = mtimeavg(signal)
echo $&defaultavg
.endc
.end`;

function evaluate(v: ControlVector, window = 1): ControlVector {
  return evaluateVectorExpression(parseVectorExpression('mtimeavg(v)'), {
    lookup: () => v, userFunction: () => undefined, degrees: () => false,
    movingAverageWindow: () => window,
  });
}
function matches(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, i) => expect(Math.abs(actual[i] / value - 1)).toBeLessThan(1e-9));
}

describe('mtimeavg (#1426)', () => {
  it.each(references)('matches native non-uniform weighting and edges, window=%s', (window, expected) => {
    const scale = realVector('time', time);
    const result = evaluate(realVector('v', values, scale), window);
    matches(result.re, expected);
    expect(result.scale).toBe(scale);
  });

  it('plumbs set/unset, suffixes and the default ten transient timesteps', async () => {
    const result = await simulate(referenceDeck.replace('mtimeavgwindow=0.2', 'mtimeavgwindow=200m'));
    const output = result.control!.output.map(line => line.split(/\s+/).map(Number));
    expect(output).toHaveLength(4);
    references.forEach(([, expected], i) => matches(output[i], expected));
    matches(output[3], references[0][1]);
  });

  it('requires a real time scale and a real input', () => {
    for (const scale of [undefined, realVector('frequency', time), realVector('time', [0, 1]), complexVector('time', time, time)]) {
      expect(() => evaluate(realVector('v', values, scale))).toThrow('scale');
    }
    expect(() => evaluate(complexVector('v', values, values, realVector('time', time)))).toThrow('real');
  });

  it('runs the unchanged corpus-f fixture, including all four filters', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/various/mtimeavg_test.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.control!.runs).toHaveLength(1);
    expect(result.transient!.time.length).toBeGreaterThan(1000);
  });
});
