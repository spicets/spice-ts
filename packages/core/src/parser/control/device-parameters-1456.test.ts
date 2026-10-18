import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const deck = `Device parameter reads
R1 top 0 2k
.subckt cell out params: resistance=3k
R4 out 0 {resistance}
C1 out 0 2u
L1 out 0 3m
V1 out 0 DC 4 AC 2 30
I1 0 out DC 5m
.ends
.subckt wrapper out
Xinner out cell resistance=4k
.ends
X1 a cell
X2 b cell
X3 c wrapper
`;

async function output(commands: string) {
  return (await simulate(`${deck}.control\n${commands}\n.endc\n.end`)).control!.output;
}

// Exercise the public control language, not just Circuit.parameterVector.
describe('device parameter reads (#1456)', () => {
  it('reads top-level resistance before and after alter', async () => {
    expect(await output('let r=@r1[resistance]\necho $&r\nalter R1=5k\nlet r=@R1[R]\necho $&r'))
      .toEqual(['2000', '5000']);
  });

  it.each(['R.X1.R4', 'x1.r4'])('reads %s, instance-local alterations, and reset', async name => {
    expect(await output(`let r=@${name}[Resistance]\necho $&r\nalter R.X1.R4=6k\nlet r=@${name}[r]\necho $&r\nlet sibling=@x2.r4[r]\necho $&sibling\nreset\nlet r=@${name}[r]\necho $&r`))
      .toEqual(['3000', '6000', '3000', '3000']);
  });

  it('reads nested parameterized instances without changing shared definitions', async () => {
    expect(await output('let r=@r.x3.xinner.r4[r]\necho $&r\nalter R.X3.Xinner.R4=7k\nlet r=@X3.Xinner.R4[resistance]\necho $&r'))
      .toEqual(['4000', '7000']);
  });

  it.each([
    ['C1', 'capacitance', '8u', '2e-06', '8e-06'],
    ['L1', 'inductance', '9m', '0.003', '0.009'],
    ['V1', 'dc', '8', '4', '8'],
    ['I1', 'dc', '8m', '0.005', '0.008'],
    ['V1', 'acmag', '3', '2', '3'],
    ['V1', 'acphase', '60', '30', '60'],
    ['I1', 'm', '2', '1', '2'],
  ])('reads and alters %s[%s]', async (device, parameter, value, before, after) => {
    expect(await output(`let p=@x1.${device}[${parameter}]\necho $&p\nalter ${device[0]}.X1.${device} ${parameter}=${value}\nlet p=@x1.${device}[${parameter}]\necho $&p`))
      .toEqual([before, after]);
  });

  it('reads altered source coefficient vectors', async () => {
    expect(await output('alter V.X1.V1 sin=[1 2 3 4 5 6]\nlet p=@x1.v1[sin]\necho $&p'))
      .toEqual(['1 2 3 4 5 6']);
  });

  it.each(['@r1[missing]', '@R.X1.R4[missing]', '@V.X1.R4[resistance]', '@xmissing.r4[r]'])('keeps a typed error for %s', async expression => {
    await expect(output(`let p=${expression}`)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL_COMMAND', command: 'let' });
  });
});
