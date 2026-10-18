import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '../parser/index.js';
import { resolveOptions } from '../types.js';
import { createDriverFromCompiled } from './transient-driver.js';
import * as stepping from './transient-step.js';
import { LinearReactiveTruncation } from './transient-reactive-truncation.js';

// ngspice-47 a80f6e3, dctran.c:793-835: only 1 -> 2 is tried,
// and only if the order-2 bound exceeds 1.05 * delta. No 2 -> 3 raise.
afterEach(() => vi.restoreAllMocks());

function driver(cap: 1 | 2 | 3) {
  const compiled = parse(`RC order policy
V1 in 0 DC 1
R1 in out 1k
C1 out 0 1n
.tran 10n 2u`).compile();
  return createDriverFromCompiled(compiled, resolveOptions({ integrationMethod: 'gear2', maxOrder: Math.min(cap, 2) }, 2e-6), {
    stopTime: 2e-6, timestep: 1e-8, maxTimestep: 1e-8,
    experimentalGearOrder: cap === 3 ? 3 : undefined,
  });
}

function order(attempt: stepping.StepAttempt): number {
  return attempt.integrationMethod === 'euler' || !attempt.prevPrevSolution ? 1 : attempt.order ?? 2;
}

describe('literal ngspice-47 Gear order policy', () => {
  it.each([2, 3] as const)('matches the native RC UIC endpoint and point count (maxord=%s)', cap => {
    const deck = readFileSync(new URL('../../../../benchmarks/gear-order-policy/rc.cir', import.meta.url), 'utf8');
    const compiled = parse(deck).compile();
    const sim = createDriverFromCompiled(compiled, resolveOptions({ integrationMethod: 'gear2' }, 2e-6), {
      stopTime: 2e-6, timestep: 1e-8, maxTimestep: 1e-8, useInitialConditions: true,
      initialSolution: new Float64Array(compiled.nodeCount + compiled.branchCount),
      experimentalGearOrder: cap === 3 ? 3 : undefined,
    });
    try {
      const points = sim.advanceUntil(2e-6).filter(step => step.time > 0);
      // ngspice-47 compare.ts, h=10ns, identical electrical deck for both caps.
      expect(points).toHaveLength(211);
      expect(points.at(-1)!.voltages.get('out')!).toBeCloseTo(1 - Math.exp(-2) + 8.845837409787727e-6, 12);
    } finally { sim.dispose(); }
  });

  it.each([1, 2, 3] as const)('starts BE twice and never exceeds order two (maxord=%s)', cap => {
    const sim = driver(cap);
    const spy = vi.spyOn(stepping, 'attemptStep');
    try {
      for (let i = 0; i < 8; i++) sim.advance();
      expect(spy.mock.calls.map(call => order(call[1]))).toEqual(cap === 1
        ? [1, 1, 1, 1, 1, 1, 1, 1] : [1, 1, 2, 2, 2, 2, 2, 2]);
    } finally { sim.dispose(); }
  });

  it.each([2, 3] as const)('does not raise merely because history exists (maxord=%s)', cap => {
    const sim = driver(cap);
    const spy = vi.spyOn(stepping, 'attemptStep');
    const trunc = vi.spyOn(LinearReactiveTruncation.prototype, 'timestep');
    // Accept order one, but reject the trial raise at the inclusive threshold.
    trunc.mockImplementation((_solution, integration, options) => options.order === 2 ? 1.05 * integration.dt : Infinity);
    try {
      for (let i = 0; i < 6; i++) sim.advance();
      expect(spy.mock.calls.map(call => order(call[1]))).toEqual([1, 1, 1, 1, 1, 1]);
      expect(trunc.mock.calls.some(call => call[2].order === 2)).toBe(true);
      trunc.mockImplementation(() => Infinity);
      sim.advance();
      sim.advance();
      expect(order(spy.mock.calls.at(-1)![1])).toBe(2);
    } finally { sim.dispose(); }
  });
});
