import { describe, expect, it } from 'vitest';
import { simulate } from './simulate.js';
import { InvalidCircuitError } from './errors.js';
import { UnsupportedControlCommandError } from './parser/control/errors.js';

const pair = (l1 = '1u', l2 = '4u', k = '0.99') => `Coupled pair
.subckt pair a
R1 a n1 1k
R2 a n2 1k
L1 n1 0 ${l1}
L2 n2 0 ${l2}
K12 L1 L2 ${k}
.ends
V1 a 0 1
Xcase a pair
.control
op
remcirc
quit 0
.endc
.end`;

const triple = (k13: string) => `Coupled triple
V1 a 0 1
R1 a n1 1k
R2 a n2 1k
R3 a n3 1k
L1 n1 0 10u
L2 n2 0 11u
L3 n3 0 10u
K12 L1 L2 0.96
K23 L2 L3 0.99
K13 L1 L3 ${k13}
.op
.end`;

describe('coupled inductance setup (#1419)', () => {
  it.each(['0.99', '-0.99', '1', '-1'])('simulates a viable pair with k=%s and trailing remcirc', async k => {
    await expect(simulate(pair('1u', '4u', k))).resolves.toBeDefined();
  });

  it.each([
    ['1u', '4u', '1.005'], ['1u', '4u', '-1.005'],
    ['-1u', '4u', '0.001'], ['1u', '-4u', '0.001'],
  ])('rejects a non-PD pair (%s, %s, %s) with instance identities', async (a, b, k) => {
    await expect(simulate(pair(a, b, k))).rejects.toMatchObject({
      name: 'InvalidCircuitError',
      message: expect.stringMatching(/not positive definite.*Xcase\.L1.*Xcase\.L2.*Xcase\.K12/i),
    });
    await expect(simulate(pair(a, b, k))).rejects.toBeInstanceOf(InvalidCircuitError);
  });

  it('accepts the viable near-boundary 3x3 system', async () => {
    await expect(simulate(triple('0.9898988607'))).resolves.toBeDefined();
  });

  it.each(['1', '-1'])('accepts a rank-one 3x3 ideal transformer with k13=%s', async k13 => {
    const deck = triple(k13).replace('K12 L1 L2 0.96', `K12 L1 L2 ${k13}`)
      .replace('K23 L2 L3 0.99', 'K23 L2 L3 1');
    await expect(simulate(deck)).resolves.toBeDefined();
  });

  it('rejects an indefinite group with a zero Cholesky pivot and nonzero residual coupling', async () => {
    const deck = triple('0').replace('K12 L1 L2 0.96', 'K12 L1 L2 1')
      .replace('K23 L2 L3 0.99', 'K23 L2 L3 1');
    await expect(simulate(deck)).rejects.toThrow(/not positive definite/);
  });

  it('merges two previously separate pairs into a viable 4x4 group', async () => {
    const deck = triple('0.01').replace('K12 L1 L2 0.96\nK23 L2 L3 0.99',
      'L4 n4 0 5u\nR4 a n4 1k\nK12 L1 L2 0.01\nK34 L3 L4 0.01\nK23 L2 L3 0.01');
    await expect(simulate(deck)).resolves.toBeDefined();
    await expect(simulate(deck.replace('K23 L2 L3 0.01', 'K23 L2 L3 1.01'))).rejects.toThrow(/not positive definite/);
  });

  it('does not implicate a separate viable group in the error', async () => {
    const deck = pair('1u', '4u', '1.005').replace('Xcase a pair',
      'Xcase a pair\nLgood1 good1 0 1u\nRgood1 a good1 1k\nLgood2 good2 0 1u\nRgood2 a good2 1k\nKgood Lgood1 Lgood2 0.5');
    try {
      await simulate(deck);
      expect.fail('expected a non-PD error');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCircuitError);
      expect((error as Error).message).not.toMatch(/good/);
    }
  });

  it('rejects the non-PD 3x3 system although every |k| is below one', async () => {
    await expect(simulate(triple('0.9898988608'))).rejects.toThrow(/not positive definite.*(?=.*K12)(?=.*K23)(?=.*K13)/);
  });

  it('rechecks the inductance matrix after control alter', async () => {
    const deck = triple('0.98').replace('.op', '.control\nop\nalter K13 0.9898988608\nop\nremcirc\nquit\n.endc');
    await expect(simulate(deck)).rejects.toThrow(/not positive definite/);
  });

  it('accepts remcirc at the end without quit', async () => {
    await expect(simulate(pair().replace('quit 0\n', ''))).resolves.toBeDefined();
  });

  it.each(['op', 'quit\nop', 'echo later', 'remcirc'])('rejects non-trailing circuit removal before %s', async tail => {
    await expect(simulate(pair().replace('quit 0', tail))).rejects.toBeInstanceOf(UnsupportedControlCommandError);
  });

  it.each(['remcirc other', 'if 1\nremcirc\nend'])('rejects circuit-management use: %s', async command => {
    await expect(simulate(pair().replace('remcirc', command))).rejects.toBeInstanceOf(UnsupportedControlCommandError);
  });
});
