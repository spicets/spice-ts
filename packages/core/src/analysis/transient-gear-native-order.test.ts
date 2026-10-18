import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../parser/index.js';
import { resolveOptions } from '../types.js';
import { createDriverFromCompiled } from './transient-driver.js';
import * as stepping from './transient-step.js';
import { LinearReactiveTruncation } from './transient-reactive-truncation.js';

// Source-derived native trajectory, not an instrumented native trace:
// ngspice-47 a80f6e3 dctran.c:785-831 skips the first truncation check,
// trials only 1 -> 2, and retains 1 when newdelta <= 1.05 * delta.
const RC = `RC refinement
V1 in 0 DC 1
R1 in out 1k
C1 out 0 1n
.options method=gear maxord=3
.tran 20n 2u 0 20n uic
.end`;

afterEach(() => vi.restoreAllMocks());

function driver(uic = true) {
  const compiled = parse(RC).compile();
  return createDriverFromCompiled(compiled, resolveOptions({ integrationMethod: 'gear2', maxOrder: 3 }, 2e-6), {
    stopTime: 2e-6, timestep: 20e-9, maxTimestep: 20e-9, useInitialConditions: uic,
    ...(uic ? { initialSolution: new Float64Array(compiled.nodeCount + compiled.branchCount) } : {}),
  });
}

function order(attempt: stepping.StepAttempt): number {
  return attempt.integrationMethod === 'euler' || !attempt.prevPrevSolution ? 1 : attempt.order ?? 2;
}

describe('public Gear MAXORD=3 native order policy (#1417)', () => {
  it('never raises the RC deck beyond native order two and matches the native endpoint', () => {
    const sim = driver();
    const spy = vi.spyOn(stepping, 'attemptStep');
    try {
      const points = sim.advanceUntil(2e-6).filter(point => point.time > 0);
      const orders = spy.mock.calls.map(call => order(call[1]));
      expect(orders.slice(0, 2)).toEqual([1, 1]);
      expect(orders).toContain(2);
      expect(Math.max(...orders)).toBe(2);
      // Identical deck, ngspice-47 -b -r; compare.ts h=20ns.
      expect(points).toHaveLength(111);
      expect(points.at(-1)!.voltages.get('out')).toBeCloseTo(1 - Math.exp(-2) + 0.00003507889002785092, 12);
    } finally { sim.dispose(); }
  });

  it('starts with two BE steps, then trials order two rather than selecting from history', () => {
    const sim = driver(false);
    const spy = vi.spyOn(stepping, 'attemptStep');
    try {
      for (let i = 0; i < 8; i++) sim.advance();
      expect(spy.mock.calls.map(call => order(call[1]))).toEqual([1, 1, 2, 2, 2, 2, 2, 2]);
    } finally { sim.dispose(); }
  });

  it('keeps order one at the inclusive trial threshold and raises only above it', () => {
    const sim = driver(false);
    const spy = vi.spyOn(stepping, 'attemptStep');
    const trunc = vi.spyOn(LinearReactiveTruncation.prototype, 'timestep');
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

  it('restarts at order one after the UIC breakpoint and reset', () => {
    const sim = driver();
    const spy = vi.spyOn(stepping, 'attemptStep');
    try {
      sim.advanceUntil(20e-9);
      spy.mockClear();
      sim.advance();
      expect(order(spy.mock.calls[0][1])).toBe(1);
      sim.advanceUntil(200e-9);
      expect(spy.mock.calls.some(call => order(call[1]) === 2)).toBe(true);
      expect(spy.mock.calls.every(call => order(call[1]) <= 2)).toBe(true);
      sim.reset();
      spy.mockClear();
      sim.advance();
      expect(order(spy.mock.calls[0][1])).toBe(1);
    } finally { sim.dispose(); }
  });

  it('lowers a failed Newton attempt to order one without discarding accepted history', () => {
    const sim = driver(false);
    const spy = vi.spyOn(stepping, 'attemptStep');
    try {
      for (let i = 0; i < 8; i++) sim.advance();
      spy.mockClear();
      spy.mockReturnValueOnce({ ok: false, reason: 'nr-divergence', iterations: 100, oscillated: false,
        lastSolution: new Float64Array(), prevIterSolution: new Float64Array() });
      sim.advance();
      const [failed, retry] = spy.mock.calls.map(call => call[1]);
      expect(order(failed)).toBe(2);
      expect(order(retry)).toBe(1);
      expect(retry.prevPrevSolution).toEqual(failed.prevPrevSolution);
      expect(retry.dt).toBeLessThan(failed.dt);
    } finally { sim.dispose(); }
  });
});
