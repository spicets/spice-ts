import { describe, expect, it, vi } from 'vitest';
import { parse } from '../parser/index.js';
import { resolveOptions } from '../types.js';
import { createDriverFromCompiled } from './transient-driver.js';
import * as stepping from './transient-step.js';
import { LinearReactiveTruncation } from './transient-reactive-truncation.js';

function driver(breakpoint = false) {
  const compiled = parse(`RC internal history
V1 in 0 ${breakpoint ? 'PWL(0 1 500n 1 501n 0 2u 0)' : 'DC 1'}
R1 in out 1k
C1 out 0 1n
.tran 10n 2u`).compile();
  return createDriverFromCompiled(compiled, resolveOptions({ integrationMethod: 'gear2' }, 2e-6), {
    stopTime: 2e-6, timestep: 1e-8, maxTimestep: 1e-8, experimentalGearOrder: 3,
  });
}

describe('internal Gear-3 accepted history', () => {
  it('reduces RC step-response error versus Gear-2 without exact startup seeds', () => {
    const errors: number[][] = [];
    for (const order of [2, 3]) {
      const row: number[] = [];
      for (const h of [20e-9, 10e-9, 5e-9, 2.5e-9]) {
        const compiled = parse(`RC refinement
V1 in 0 DC 1
R1 in out 1k
C1 out 0 1n
.tran 10n 2u uic`).compile();
        const sim = createDriverFromCompiled(compiled, resolveOptions({ integrationMethod: 'gear2' }, 2e-6), {
          stopTime: 2e-6, timestep: h, maxTimestep: h, useInitialConditions: true,
          initialSolution: new Float64Array(compiled.nodeCount + compiled.branchCount),
          experimentalGearOrder: order === 3 ? 3 : undefined,
        });
        try {
          const steps = sim.advanceUntil(2e-6);
          row.push(Math.abs(steps.at(-1)!.voltages.get('out')! - (1 - Math.exp(-2))));
        } finally { sim.dispose(); }
      }
      errors.push(row);
    }
    // Startup remains BE/BDF2; this is NOT a third-order convergence claim.
    errors[1].forEach((error, i) => {
      expect(error).toBeLessThan(errors[0][i]);
      if (i > 0) expect(error).toBeLessThan(errors[1][i - 1]);
    });
  });

  it('retains all accepted intervals and solutions across an LTE retry', () => {
    const sim = driver();
    const attempt = vi.spyOn(stepping, 'attemptStep');
    const truncation = vi.spyOn(LinearReactiveTruncation.prototype, 'timestep');
    try {
      for (let i = 0; i < 12; i++) sim.advance();
      attempt.mockClear();
      truncation.mockImplementationOnce((_solution, integration) => integration.dt / 4);
      sim.advance();
      const [failed, retry] = attempt.mock.calls.map(call => call[1]);
      expect(failed.order).toBe(3);
      expect(retry.order).toBe(3);
      expect(retry.prevSolution).toEqual(failed.prevSolution);
      expect(retry.prevPrevSolution).toEqual(failed.prevPrevSolution);
      expect(retry.thirdPrevSolution).toEqual(failed.thirdPrevSolution);
      expect(retry.prevDt).toBe(failed.prevDt);
      expect(retry.prevPrevDt).toBe(failed.prevPrevDt);
      expect(retry.dt).toBe(failed.dt / 4);
    } finally { attempt.mockRestore(); truncation.mockRestore(); sim.dispose(); }
  });

  it('reaches order three, preserves accepted history on Newton rejection, and resets', () => {
    const sim = driver();
    const spy = vi.spyOn(stepping, 'attemptStep');
    try {
      for (let i = 0; i < 12; i++) sim.advance();
      const before = spy.mock.calls.at(-1)![1];
      expect(before.order).toBe(3);
      expect(before.thirdPrevSolution).toBeDefined();
      spy.mockClear();
      spy.mockReturnValueOnce({ ok: false, reason: 'nr-divergence', iterations: 100, oscillated: false,
        lastSolution: new Float64Array(), prevIterSolution: new Float64Array() });
      sim.advance();
      const [failed, retry] = spy.mock.calls.map(call => call[1]);
      expect(failed.order).toBe(3);
      expect(retry.integrationMethod).toBe('euler');
      expect(retry.thirdPrevSolution).toEqual(failed.thirdPrevSolution);
      expect(retry.prevPrevDt).toBe(failed.prevPrevDt);
      expect(retry.dt).toBeLessThan(failed.dt);
      sim.reset();
      spy.mockClear();
      sim.advance();
      expect(spy.mock.calls[0][1].integrationMethod).toBe('euler');
      expect(spy.mock.calls[0][1].thirdPrevSolution).toBeUndefined();
    } finally { spy.mockRestore(); sim.dispose(); }
  });

  it('drops all higher-order solution history after a breakpoint', () => {
    const sim = driver(true);
    const spy = vi.spyOn(stepping, 'attemptStep');
    try {
      sim.advanceUntil(500e-9);
      expect(spy.mock.calls.some(call => call[1].order === 3)).toBe(true);
      spy.mockClear();
      sim.advance();
      const first = spy.mock.calls[0][1];
      expect(first.integrationMethod).toBe('euler');
      expect(first.prevPrevSolution).toBeUndefined();
      expect(first.thirdPrevSolution).toBeUndefined();
      sim.advanceUntil(800e-9);
      expect(spy.mock.calls.some(call => call[1].order === 3)).toBe(true);
    } finally { spy.mockRestore(); sim.dispose(); }
  });
});
