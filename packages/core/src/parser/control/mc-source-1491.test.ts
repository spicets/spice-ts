import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

// ngspice-47 com_mc_source reloads the retained deck without re-entering .control.
const deck = `Monte Carlo reload
.param rr=1k
.csparam rval={rr}
V1 in 0 1
R1 in 0 {rr}
.control
`;
const run = (script: string) => simulate(`${deck}${script}\n.endc\n.end`);

describe('mc_source retained-deck reload (#1491)', () => {
  it('applies pending alterparam values and preserves old plots and user vectors', async () => {
    const result = await run(`setplot new
let retained=42
set baseplot=$curplot
op
alterparam rr=2k
op
mc_source
op
setplot $baseplot
let old=op1.v1#branch
let fresh=op3.v1#branch
echo $&retained / $&old / $&fresh / $&rval`);
    expect(result.control!.runs.map(run => run.result.dc!.current('V1'))).toEqual([-0.001, -0.001, -0.0005]);
    expect(result.control!.output).toEqual(['42 / -0.001 / -0.0005 / 2000']);
  });

  it('discards instance alterations and reloads repeatedly inside a parameter loop', async () => {
    const result = await run(`alter R1 4k
op
foreach resistance 2k 4k
alterparam rr=$resistance
mc_source
op
end`);
    expect(result.control!.runs.map(run => run.result.dc!.current('V1'))).toEqual([-0.00025, -0.0005, -0.00025]);
  });
});
