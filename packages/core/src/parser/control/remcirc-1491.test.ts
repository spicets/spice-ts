import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { ControlScriptError } from './errors.js';

const run = (script: string, analysis = '') => simulate(`Circuit removal
.param rr=1k
V1 in 0 1
R1 in 0 {rr}
${analysis}
.control
${script}
.endc
.end`);

describe('remcirc lifecycle (#1491), ngspice-47 semantics', () => {
  it('preserves plots and runs circuit-independent commands after removal in a loop', async () => {
    const result = await run(`op
repeat 2
remcirc
let retained=op1.in*42
echo $&retained
end
write retained.raw op1.in`);
    expect(result.control!.output).toEqual(['42', '42']);
    expect(result.control!.runs).toHaveLength(1);
    expect(result.control!.files!.map(file => file.path)).toEqual(['retained.raw']);
  });

  it.each(['op', 'dc V1 0 1 1', 'run', 'alter R1 2k', 'altermod missing rsh=2'])('rejects %s without a loaded circuit', async command => {
    await expect(run(`remcirc\n${command}`)).rejects.toBeInstanceOf(ControlScriptError);
    await expect(run(`remcirc\n${command}`)).rejects.toThrow(/no circuit loaded/i);
  });

  it('ignores reset and alterparam while removed, but mc_source reloads the retained parameterized source', async () => {
    const result = await run(`alterparam rr=2k
mc_source
op
remcirc
remcirc
reset
alterparam rr=4k
mc_source
op
echo $&op1.v1#branch / $&op2.v1#branch`);
    expect(result.control!.output).toEqual(['-0.0005 / -0.0005']);
    expect(result.warnings.filter(warning => warning.type === 'control').map(warning => warning.message).join('\n')).toMatch(/reset.*ignored[\s\S]*alterparam.*ignored/);
  });

  it('does not implicitly run dot-card analyses after removal', async () => {
    const result = await run('remcirc\necho done', '.op');
    expect(result.dc).toBeUndefined();
    expect(result.control!.output).toEqual(['done']);
  });

  it('selects the previous circuit after removing a mc_source circuit', async () => {
    const result = await run(`alter R1 4k
op
alterparam rr=2k
mc_source
op
remcirc
op
alterparam rr=5k
mc_source
op
remcirc
op`);
    expect(result.control!.runs.map(run => run.result.dc!.current('V1'))).toEqual([
      -0.00025, -0.0005, -0.00025, -0.0002, -0.00025,
    ]);
  });
});
