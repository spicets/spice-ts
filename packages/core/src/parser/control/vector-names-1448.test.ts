import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { ControlScriptError } from './errors.js';

describe('ngspice let vector names (#1448)', () => {
  it('assigns and retrieves slash/plus voltage names across plots and write commands', async () => {
    const result = await simulate(`vector names
V1 22 0 2
R1 22 0 1k
.control
op
let v(/22) = V(22)
let slash = v(/22)
let quoted = "v(/22)"
write test.raw v(/22)
setplot new
let v(+22) = op1.v(/22) + 1
let plus = v(+22)
setplot op1
echo $&slash $&quoted
setplot unknown2
echo $&plus
write test.raw v(+22) op1.v(/22)
.endc`);
    expect(result.control!.output).toEqual(['2 2', '3']);
  });

  it.each(['all', '@foo', '123', 'bad['])('rejects ngspice-invalid target %s with a structured error', async target => {
    await expect(simulate(`invalid name
.control
let ${target} = 1
.endc`)).rejects.toBeInstanceOf(ControlScriptError);
  });
});
