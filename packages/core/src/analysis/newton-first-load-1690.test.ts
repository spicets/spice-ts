import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

// ngspice-47 niiter.c:287-290 forces CKTnoncon on the first load/solve,
// even when NIconvTest would accept a sub-vntol change. ngspice runs 7
// iterations for this identical deck: 3 for INITJCT/INITFIX/INITFLOAT at
// the first point and 2 each thereafter. Our linear devices do not opt
// into INITJCT yet, so their corresponding total is 6, not 5.
const deck = `first-load convergence
v1 out 0 0
r1 out 0 1k
.dc v1 0 1u 0.5u
.end`;

describe('Newton first-load convergence (#1690)', () => {
  it('reloads the zero-bias operating point instead of accepting its first solve', async () => {
    const result = await simulate(deck.replace('.dc v1 0 1u 0.5u', '.op'));
    expect(result.dc!.voltage('out')).toBe(0);
    expect(result.convergence!.dc.acceptedSolves).toBe(1);
    // ngspice-47: 3 loads including INITJCT; without that mode we need 2.
    expect(result.convergence!.dc.newtonIterations).toBe(2);
  });

  it('reloads an already-converged initial guess before accepting each solve', async () => {
    const result = await simulate(deck);
    expect([...result.dcSweep!.voltage('out')]).toEqual([0, 0.5e-6, 1e-6]);
    expect(result.convergence!.dc.acceptedSolves).toBe(3);
    expect(result.convergence!.dc.newtonIterations).toBe(6);
  });
});
