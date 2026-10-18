import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { UnsupportedControlCommandError } from './errors.js';

// ngspice-47 src/frontend/postcoms.c:77-92, com_remzerovec:
// only current-plot vectors with v_length == 0 lose VF_PERMANENT;
// frontend/vectors.c vec_gc subsequently frees them. Arguments are ignored.
// https://github.com/imr/ngspice/blob/ngspice-47/src/frontend/postcoms.c#L77-L92
const deck = (commands: string) => `remzerovec regression
V1 in 0 1
R1 in 0 1k
.control
${commands}
.endc
.end`;

const setup = `op
compose empty values
compose zero values 0 0
compose real values 2 3
let complex = (2,3)`;

describe('#1277 remzerovec', () => {
  it('removes zero-length vectors, not vectors whose values are zero', async () => {
    const result = await simulate(deck(`${setup}
remzerovec
remzerovec
let imaginary = imag(complex)
echo $&zero $&real $&complex $&imaginary
echo $curplot`));
    expect(result.control!.output).toEqual(['0 0 2 3 2 3', 'op1']);
    await expect(simulate(deck(`${setup}
remzerovec
let probe = empty`))).rejects.toMatchObject({
      name: 'ControlScriptError',
      message: expect.stringContaining('empty'),
    });
  });

  it('leaves zero-length vectors in other plots and const untouched', async () => {
    const result = await simulate(deck(`compose constantempty values
op
compose olderempty values
op
compose empty values
remzerovec ignored arguments
let oldlength = length(op1.olderempty)
let constlength = length(const.constantempty)
echo $&oldlength $&constlength $&pi $curplot`));
    expect(result.control!.output).toEqual(['0 0 3.14159 op2']);
  });

  it('is harmless on an empty plot and on the constants plot', async () => {
    const result = await simulate(deck(`remzerovec
setplot new
remzerovec
echo done`));
    expect(result.control!.output).toEqual(['done']);
  });

  it('keeps unknown commands typed as unsupported', async () => {
    const promise = simulate(deck('remzerovec_typo'));
    await expect(promise).rejects.toBeInstanceOf(UnsupportedControlCommandError);
  });
});
