import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

describe('saved MOS1 drain current (#1578)', () => {
  for (const polarity of [1, -1]) {
    for (const inverse of [false, true]) {
      for (const analysis of ['.dc vd 1 2 .5', '.tran 10u 100u']) {
        it(`samples native id, polarity ${polarity}, inverse ${inverse}, ${analysis}`, async () => {
          const result = await simulate(`Saved MOS1 current
vd d 0 ${polarity}
vg g 0 ${3 * polarity}
mn1 ${inverse ? '0 g d' : 'd g 0'} 0 model
.model model ${polarity === 1 ? 'nmos' : 'pmos'} (level=1 vto=${polarity} kp=2)
.save @MN1[ID]
${analysis.replace('1 2 .5', polarity === 1 ? '1 2 .5' : '-1 -2 -.5')}
.control
run
.endc
.end`);
          const saved = result.control!.runs[0].result;
          const run = saved.dcSweep ?? saved.transient!;
          const values = run.deviceVectors.get('@mn1[id]')!;
          expect(values.length).toBeGreaterThan(2);
          const expected = inverse ? -3 : 3;
          expect(values[0]).toBeCloseTo(expected, 7);
          expect(values.at(-1)).toBeCloseTo(analysis.startsWith('.dc') ? (inverse ? -4 : 4) : expected, 7);
        });
      }
    }
  }

  it('resolves mixed-case hierarchical saves without aliasing the plot history', async () => {
    const result = await simulate(`Hierarchical MOS1 current
.subckt cell d g
Mn1 d g 0 0 nm
.model nm nmos (level=1 vto=1 kp=2)
.ends
Xtop d g cell
vd d 0 1
vg g 0 3
.control
save all @M.XTOP.MN1[ID]
dc vd 1 2 .5
let old = @m.xtop.mn1[id]
dc vd 2 3 .5
setplot dc1
let residual = vecmax(abs(old - @m.xtop.mn1[id]))
echo residual $&residual
.endc
.end`);
    const values = result.control!.runs[0].result.dcSweep!.deviceVectors.get('@m.xtop.mn1[id]')!;
    for (const [index, expected] of [3, 3.75, 4].entries()) expect(values[index]).toBeCloseTo(expected, 7);
    expect(result.control!.output).toEqual(['residual 0']);
  });

  it('runs the unchanged corpus-f probe deck and records every saved point', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/probe/mos-test.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    const run = result.control!.runs[0].result.transient!;
    const values = run.deviceVectors.get('@mn1[id]')!;
    expect(values).toHaveLength(run.time.length);
    expect([...values].every(Number.isFinite)).toBe(true);
    expect(Math.max(...values)).toBeGreaterThan(0);
  });
});
