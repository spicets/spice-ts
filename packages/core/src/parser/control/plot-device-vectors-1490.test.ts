import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

// Identical deck printed with ngspice-47 -b, set numdgt=15.
// x = [-0.002, -0.001, 0, 0.001, 0.002], slope = [0.001] * 5.
const referenceDeck = `Plot-qualified saved device vectors
V1 out 0 0
R1 out 0 1k
.save all @r1[i]
.control
set numdgt=15
dc V1 -2 2 1
set name=$curplot
setplot new
let x = {$name}.@r1[i]
let slope = deriv({$name}.@r1[i])
let sample = {$name}.@r1[i][3]
print x slope sample
echo $&x
echo $&slope
echo $&sample
.endc
.end
`;

describe('plot-qualified device vectors (#1490)', () => {
  it('reads a saved DC current from another plot with its original scale', async () => {
    const result = await simulate(referenceDeck);
    const output = result.control!.output;
    expect(output[0].split(/\s+/).map(Number)).toEqual([-0.002, -0.001, 0, 0.001, 0.002]);
    expect(output[1].split(/\s+/).map(Number)).toEqual(Array(5).fill(0.001));
    expect(Number(output[2])).toBe(0.001);
  });

  it('keeps saved historical current rather than reading the altered live device', async () => {
    const result = await simulate(referenceDeck.replace('setplot new', 'alter R1 2k\nop\nsetplot new'));
    expect(result.control!.output[0].split(/\s+/).map(Number)).toEqual([-0.002, -0.001, 0, 0.001, 0.002]);
  });

  it.each([
    '.SAVE all\n+ @R1[i] ; saved current',
    '.save all\n* continuation comment\n+ @r1[i]',
  ])('collects case-insensitive dot saves and continuations: %s', async save => {
    const result = await simulate(referenceDeck.replace('.save all @r1[i]', save));
    expect(result.control!.output[0].split(/\s+/).map(Number)).toEqual([-0.002, -0.001, 0, 0.001, 0.002]);
  });

  it('applies a dot save written after the control block before its analyses', async () => {
    const result = await simulate(referenceDeck.replace('.save all @r1[i]\n', '').replace('.endc', '.endc\n.save all @r1[i]'));
    expect(result.control!.output[0].split(/\s+/).map(Number)).toEqual([-0.002, -0.001, 0, 0.001, 0.002]);
  });

  it('supports the runtime save command as well as dot cards', async () => {
    const result = await simulate(referenceDeck.replace('.save all @r1[i]\n', '').replace('.control', '.control\nsave all @r1[i]'));
    expect(result.control!.output[0].split(/\s+/).map(Number)).toEqual([-0.002, -0.001, 0, 0.001, 0.002]);
  });

  it.each(['missing.@r1[i]', 'dc1.@missing[i]'])('reports structured errors for %s', async expression => {
    await expect(simulate(referenceDeck.replace('{$name}.@r1[i]', expression)))
      .rejects.toMatchObject({ code: expect.stringMatching(/CONTROL/), line: 10, context: `let x = ${expression}` });
  });

  it('continues to index ordinary plot-qualified vectors', async () => {
    const result = await simulate(referenceDeck.replace('{$name}.@r1[i]', '{$name}.out[3]'));
    expect(Number(result.control!.output[0])).toBe(1);
  });
});
