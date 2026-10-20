import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parseXspiceModelCard } from '../../parser/xspice-parser.js';

const fixture = readFileSync(new URL('../../../../../benchmarks/xspice/potentiometer.cir', import.meta.url), 'utf8');
const deck = (params: string, ports = '0 w in') => `potentiometer\nv1 in 0 dc 5 ac 1\na1 ${ports} p\nrload w 0 12k\n.model p potentiometer(${params})\n.op\n.ac lin 1 10 10\n.end`;

function gain(position: number, resistance = 20000, log = false, multiplier = 1): number {
  const p = position <= 0 ? 1e-9 : position >= 1 ? 0.999999999 : position;
  const lower = log ? resistance / 10 ** (p * multiplier) : p * resistance;
  const upper = resistance - lower;
  return 1 / (1 + upper / lower + upper / 12000);
}

describe('XSPICE potentiometer (#1619)', () => {
  it('runs the identical loaded linear/log OP, DC and transient oracle fixture', async () => {
    const result = await simulate(fixture);
    for (const analysis of ['op', 'dc', 'tran'] as const) {
      const rows = readFileSync(new URL(`../../../../../benchmarks/xspice/potentiometer-reference/${analysis}.txt`, import.meta.url), 'utf8')
        .trim().split('\n').slice(1).map(line => line.trim().split(/\s+/).map(Number));
      const actual = analysis === 'op' ? result.dc! : analysis === 'dc' ? result.dcSweep! : result.transient!;
      const x = analysis === 'op' ? [5] : analysis === 'dc' ? result.dcSweep!.sweepValues : result.transient!.time;
      for (const [column, name] of ['in', 'wdefault', 'wlinear', 'wlog', 'vdrive'].entries()) {
        const series = column === 4 ? actual.current(name) : actual.voltage(name);
        const values = typeof series === 'number' ? [series] : series;
        let j = 0;
        for (const row of rows) {
          while (j + 1 < x.length && x[j + 1] < row[0]) j++;
          const next = Math.min(j + 1, x.length - 1);
          const fraction = next === j ? 0 : (row[0] - x[j]) / (x[next] - x[j]);
          const value = values[j] + fraction * (values[next] - values[j]);
          expect(Math.abs(value - row[column + 1]) / Math.abs(row[column + 1])).toBeLessThan(1e-6);
        }
      }
    }
  });

  it.each([0, 0.25, 0.5, 1])('preserves linear endpoint guards and AC gains at position %s', async position => {
    const result = await simulate(deck(`r=20k position=${position}`));
    expect(result.dc!.voltage('w')).toBeCloseTo(5 * gain(position), 7);
    expect(result.ac!.voltage('w')[0].magnitude).toBeCloseTo(gain(position), 7);
  });

  it.each([1, 2])('uses logarithmic taper multiplier %s with explicit g ports', async multiplier => {
    const result = await simulate(deck(`r=20k position=0.4 log=true log_multiplier=${multiplier}`, '%g(0) %g(w) %g(in)'));
    expect(result.dc!.voltage('w')).toBeCloseTo(5 * gain(0.4, 20000, true, multiplier), 10);
    expect(result.ac!.voltage('w')[0].magnitude).toBeCloseTo(gain(0.4, 20000, true, multiplier), 10);
  });

  it('preserves port orientation when r0 is driven and r1 is grounded', async () => {
    const result = await simulate(deck('r=20k position=0.25', 'in w 0'));
    const expected = gain(0.75);
    expect(result.dc!.voltage('w')).toBeCloseTo(5 * expected, 10);
    expect(result.dc!.current('v1')).toBeCloseTo(-(5 - 5 * expected) / 5000, 12);
    expect(result.ac!.voltage('w')[0].magnitude).toBeCloseTo(expected, 10);
  });

  it('does not move an interior position smaller than the endpoint guard', async () => {
    const position = 5e-10;
    const result = await simulate(deck(`r=20k position=${position}`));
    expect(result.dc!.voltage('w') / (5 * gain(position))).toBeCloseTo(1, 6);
  });

  it.each([[-0.1, 0, 'below limit'], [1.1, 1, 'exceeds limit']] as const)(
    'clamps position %s with a diagnostic like ngspice MIF', async (position, clamped, warning) => {
      const model = parseXspiceModelCard(`.model p potentiometer(position=${position})`, 1);
      expect(model.params.get('position')).toEqual([clamped]);
      expect(model.warnings).toEqual([expect.stringContaining(warning)]);
      const result = await simulate(deck(`r=20k position=${position}`));
      expect(result.dc!.voltage('w')).toBeCloseTo(5 * gain(clamped), 7);
    },
  );
});
