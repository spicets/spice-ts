import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

// ngspice-47 frontend/device.c:1421-1486 passes bracketed real vectors to
// vsrcpar.c:91-97 / isrcpar.c (SINE): replace coefficients, at least two.
describe('alter source SIN coefficient vectors (#1260)', () => {
  it.each(['V', 'I'])('uses substituted bracketed coefficients in the next analysis (%s source)', async kind => {
    const circuit = (waveform: string) => `alter SIN
${kind}1 out 0 DC 0.25 AC 2 ${waveform}
R1 out 0 1
`;
    const analysis = 'tran 10u 1m';
    const result = await simulate(`${circuit('SIN(0 1 1000 10u 20 30)')}
.control
${analysis}
let a = 3
let b = 2000
alter @${kind}1[sin] [0 $&a $&b]
${analysis}
op
ac lin 1 1000 1000
.endc`);
    const edited = await simulate(`${circuit('SIN(0 3 2000)')}
.control
${analysis}
op
ac lin 1 1000 1000
.endc`);
    const runs = result.control!.runs;
    expect(runs).toHaveLength(4);
    expect(runs[1].result.transient).toEqual(edited.transient);
    expect(runs[0].result.transient).not.toEqual(runs[1].result.transient);
    expect(runs[2].result.dc).toEqual(edited.dc);
    expect(runs[3].result.ac).toEqual(edited.ac);
  });

  it.each(['DC 0.25', 'DC 0.25 AC 2'])('replaces a %s source with SIN and applies optional coefficients', async initial => {
    const base = `alter waveform\nV1 out 0 ${initial}\nR1 out 0 1k\n`;
    const altered = await simulate(`${base}.control
alter @V1[sin] = [ 1 2 1000 10u 20 30 ]
tran 10u 1m
.endc`);
    const edited = await simulate(base.replace(initial, `${initial} SIN(1 2 1000 10u 20 30)`) + '.tran 10u 1m');
    expect(altered.transient).toEqual(edited.transient);
  });

  it('rejects a SIN vector with fewer than two coefficients', async () => {
    await expect(simulate('invalid SIN\nV1 out 0 0\nR1 out 0 1k\n.control\nalter @V1[sin] [0]\n.endc'))
      .rejects.toThrow(/at least 2/);
  });
});
