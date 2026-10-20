import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { preprocess } from './preprocessor.js';

const resistance = '(time<1m ? {Rload} : time<2m ? {Rload/2} : {2*Rload})';

describe('time-dependent resistor (#1589)', () => {
  it('lowers parenthesized nested ternaries with embedded brace parameters', async () => {
    const text = await preprocess(`T\nR4 out2 OUT R = ${resistance}\n.param Rload=100\n.op`);
    expect(text).toContain('bR4 out2 OUT i = v(out2, OUT)/(');
    expect(text).toContain('time<1m');
    expect(text).not.toContain('Rload');
  });

  it.each(['R = (time<1m ? 1k : 2k)', 'R={time<1m ? 1k : 2k}', "'time<1m ? 1k : 2k'"])(
    'reevaluates %s each transient step with analytic current', async card => {
      const { transient } = await simulate(`T\nV1 in 0 1\nR1 in 0 ${card}\n.tran 10u 3m\n.end`);
      const current = transient!.current('V1');
      let before = 0;
      let after = 0;
      for (let i = 0; i < current.length; i++) {
        const early = transient!.time[i] < 1e-3;
        const expected = early ? -1e-3 : -5e-4;
        expect(Math.abs((current[i] - expected) / expected)).toBeLessThan(1e-9);
        if (early) before++; else after++;
      }
      expect(before).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(0);
    },
  );

  it('retains parameter scope, nested branches and multiplier in subcircuits', async () => {
    const { transient } = await simulate(`T
V1 in 0 1
X1 in load Rload=100
.subckt load p Rload=1
R1 p 0 R = ${resistance} m=2
.ends
.tran 10u 3m
.end`);
    const current = transient!.current('V1');
    for (let i = 0; i < current.length; i++) {
      const t = transient!.time[i];
      const expected = -2 / (t < 1e-3 ? 100 : t < 2e-3 ? 50 : 200);
      expect(Math.abs((current[i] - expected) / expected)).toBeLessThan(1e-9);
    }
  });
});
