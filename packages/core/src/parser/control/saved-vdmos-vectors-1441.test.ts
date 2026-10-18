import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const circuit = `Saved VDMOS quantities
vd d 0 dc 1 pwl(0 1 1m 2)
vg g 0 3
m1 d g 0 power m=2
d1 0 d diode m=2
.model power vdmos(vto=1 kp=2 rd=0 rs=0 rg=0 rb=0 cgs=2n cgdmin=1n cgdmax=3n a=1 cjo=4n vj=1 m=.5)
.model diode d(is=1p cjo=4n vj=1 m=.5)
`;

// ngspice-47 vdmosask.c: id is mode*cdrain (not terminal current),
// cgs/cgd are twice the stored half-capacitance, cds is VDIOcap.
// dioask.c DIO_CAP: cd is junction capacitance, not a current alias.
const outputs = ['@m1[id]', '@m1[cgd]', '@m1[cgs]', '@m1[cds]', '@d1[cd]'];

describe('saved VDMOS/diode outputs (#1441)', () => {
  for (const analysis of ['dc vd 1 2 .5', 'tran 10u 1m']) {
    for (const name of outputs) {
      it(`samples ${name} during ${analysis}`, async () => {
        const result = await simulate(`${circuit}.control
save all ${name}
${analysis}
.endc
.end`);
        const run = result.dcSweep ?? result.transient!;
        const values = run.deviceVectors.get(name)!;
        expect(values.length).toBeGreaterThan(2);
        expect([...values].every(Number.isFinite)).toBe(true);
        // Reference endpoint values are the same in DC and at t=1ms.
        const expected = name === '@m1[id]' ? 8
          : name === '@m1[cgs]' ? 4e-9
            : name === '@m1[cgd]' ? 5.629055259556148e-9
              : 4.618802153517007e-9;
        expect(Math.abs(values.at(-1)! / expected - 1)).toBeLessThan(1e-6);
        if (name !== '@m1[cgs]') expect(values.at(-1)).not.toBe(values[1]);
      });
    }
  }

  for (const polarity of [1, -1]) {
    for (const analysis of ['dc vd -.1 -.2 -.1', 'tran 10u 1m']) {
      it(`retains native channel-current sign in inverse mode, polarity ${polarity}, ${analysis}`, async () => {
        const result = await simulate(`Inverse channel current
vd d 0 dc ${-.1 * polarity} pwl(0 ${-.1 * polarity} 1m ${-.2 * polarity})
vg g 0 ${1.5 * polarity}
m1 d g 0 power m=2
.model power vdmos(${polarity === -1 ? 'pchan' : ''} vto=${polarity} kp=2 rb=0 cjo=0 cgs=0 cgdmin=0 cgdmax=0)
.control
save all @m1[id]
${polarity === -1 && analysis.startsWith('dc') ? 'dc vd .1 .2 .1' : analysis}
.endc
.end`);
        const values = (result.dcSweep ?? result.transient!).deviceVectors.get('@m1[id]')!;
        // vdmosask.c returns mode*cdrain, even for p-channel devices.
        expect(values.at(-1)).toBeCloseTo(-0.480072917316302, 12);
      });
    }
  }
});
