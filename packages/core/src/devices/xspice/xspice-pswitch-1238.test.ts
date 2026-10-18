import { describe, expect, it } from 'vitest';
import { parse } from '../../parser/index.js';
import { simulate } from '../../simulate.js';

// ngspice-47, src/xspice/icm/xtradev/pswitch/cfunc.mod:172-282.
// Source revision 3ef069fb1f04177a153f342a32d941fc20ff047e (corpus-f).
// At normalized control t, log mode uses exp(log(sqrt(Ron*Roff))
// + log(Ron/Roff) * (1.5*(t-.5) - 2*(t-.5)^3)); linear mode interpolates R.
describe('subcircuit-local XSPICE pswitch (#1238)', () => {
  for (const log of [false, true]) for (const reversed of [false, true]) {
    it(`matches ngspice resistance, log=${log}, reversed=${reversed}`, async () => {
      const on = reversed ? 1.5 : 2.5;
      const off = reversed ? 2.5 : 1.5;
      for (const t of [-0.5, 0, 0.25, 0.5, 0.75, 1, 1.5]) {
        const control = off + t * (on - off);
        const clamped = Math.max(0, Math.min(1, t));
        const x = clamped - 0.5;
        const resistance = log
          ? Math.exp(Math.log(Math.sqrt(1e3 * 2e9)) + Math.log(1e3 / 2e9) * (1.5 * x - 2 * x ** 3))
          : 2e9 + clamped * (1e3 - 2e9);
        const result = await simulate(`local pswitch
Vc c 0 ${control}
Vout out 0 1
x1 c out sw
.subckt sw c out
asw %gd c 0 %gd out 0 model1
.model model1 pswitch(log=${log} cntl_on=${on} cntl_off=${off} r_on=1k r_off=2g)
.ends
.op
.end`);
        expect(-result.dc!.current('Vout') * resistance).toBeCloseTo(1, 8);
        expect(-result.dc!.current('Vc')).toBeCloseTo(control / 1e12, 18);
      }
    });
  }

  it('uses ngspice ifspec.ifs:44-76 defaults in a local model', async () => {
    const result = await simulate(`default pswitch
Vc c 0 0.5
Vout out 0 1
x1 c out sw
.subckt sw c out
asw (c 0) (out 0) model1
.model model1 pswitch
.ends
.op
.end`);
    expect(-result.dc!.current('Vout')).toBeCloseTo(1e-6, 14);
    expect(-result.dc!.current('Vc')).toBeCloseTo(0.5e-12, 18);
  });

  it('keeps other local XSPICE families outside the scoped-port boundary', () => {
    expect(() => parse(`local gain
V1 in 0 1
x1 in out block
R1 out 0 1k
.subckt block in out
a1 in out g1
.model g1 gain(gain=2)
.ends
.op
.end`)).toThrow(/unsupported type 'GAIN'/);
  });
});
