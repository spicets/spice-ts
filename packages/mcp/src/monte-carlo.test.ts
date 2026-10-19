import { describe, expect, it } from 'vitest';
import { createToolExecutor, executeTool, DEFAULT_MCP_LIMITS } from './server.js';
import { runMonteCarlo } from './monte-carlo.js';

const request = { apiVersion: '1', input: { format: 'spice', source: '* divider\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op\n.end' } };
const args = { request, runs: 200, seed: 12345, tolerances: ['R1', 'R2'].map(element => ({ element, sigma: 0.01, distribution: 'gaussian' })), measurements: [{ kind: 'at', signal: 'v(out)', analysis: 0, at: 0 }] };

describe('spice_monte_carlo', () => {
  it('returns byte-identical seeded results and analytic divider statistics for 200 runs', async () => {
    const before = JSON.stringify(args);
    const first = await executeTool('spice_monte_carlo', args, { limits: { ...DEFAULT_MCP_LIMITS, maxWallTimeMs: 120000 } });
    expect(first.isError, JSON.stringify(first.structuredContent)).not.toBe(true);
    const second = await executeTool('spice_monte_carlo', args, { limits: { ...DEFAULT_MCP_LIMITS, maxWallTimeMs: 120000 } });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const data = first.structuredContent as { statistics: { count: number; mean: number; std: number; min: number; max: number; p5: number; p95: number; unit: string }[] };
    const s = data.statistics[0];
    const expectedStd = 10 * 0.01 / Math.sqrt(8);
    expect(s.count).toBe(200);
    expect(s.unit).toBe('V');
    expect(Math.abs(s.mean - 5)).toBeLessThan(4 * expectedStd / Math.sqrt(200));
    expect(s.std).toBeGreaterThan(expectedStd * 0.75);
    expect(s.std).toBeLessThan(expectedStd * 1.25);
    expect(s.min).toBeLessThan(s.p5);
    expect(s.p5).toBeLessThan(s.mean);
    expect(s.mean).toBeLessThan(s.p95);
    expect(s.p95).toBeLessThan(s.max);
    expect(JSON.stringify(args)).toBe(before);
  }, 240000);

  it('supports bounded uniform R/C/L draws and existing transient measurements', async () => {
    const result = await executeTool('spice_monte_carlo', { ...args, runs: 4,
      request: { ...request, input: { format: 'spice', source: '* RC\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 0.1m 1m\n.end' } },
      tolerances: [{ element: 'C1', sigma: 0.01, distribution: 'uniform' }],
      measurements: [{ kind: 'avg', signal: 'v(out)', analysis: 0 }],
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ runs: 4, seed: 12345, statistics: [{ count: 4, mean: expect.closeTo(1), unit: 'V' }] });
  });

  it('validates run limits, seed, tolerances, unknown elements and measures', async () => {
    for (const change of [{ runs: 0 }, { runs: -1 }, { runs: 1.5 }, { seed: NaN }, { seed: -1 }, { tolerances: [] },
      { tolerances: [{ element: 'Rmissing', sigma: 0.01, distribution: 'gaussian' }] },
      { tolerances: [{ element: 'R1', sigma: -1, distribution: 'uniform' }] },
      { tolerances: [{ element: 'R1', sigma: 1, distribution: 'uniform' }] }]) {
      expect(await executeTool('spice_monte_carlo', { ...args, ...change })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    expect(await executeTool('spice_monte_carlo', { ...args, runs: 1001 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxMonteCarloRuns', maximum: 1000 } } } });
    expect(await executeTool('spice_monte_carlo', { ...args, runs: 1, measurements: [{ kind: 'at', signal: 'v(missing)', analysis: 0, at: 0 }] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('honors cancellation, bytes, quota and discovery', async () => {
    const execute = createToolExecutor({ streamLimits: { maxConcurrentJobs: 0 } });
    expect(await execute('spice_monte_carlo', { ...args, runs: 1 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect(await executeTool('spice_monte_carlo', { ...args, runs: 1 }, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
    expect(await executeTool('spice_monte_carlo', { ...args, runs: 1 }, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_monte_carlo']) });
  });

  it('uses a shared deadline rather than one independent budget per run', async () => {
    expect(await executeTool('spice_monte_carlo', { ...args, runs: 2 }, {
      limits: { ...DEFAULT_MCP_LIMITS, maxWallTimeMs: 20 },
      simulate: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { status: 'complete', analyses: [] }; },
    })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('computes sample std and interpolated percentiles exactly, including N=1', async () => {
    let value = 0;
    const result = await runMonteCarlo({ ...args, runs: 3 }, request as Parameters<typeof runMonteCarlo>[1], async () => ({
      content: [], structuredContent: { measurements: [{ value: ++value, unit: 'V' }] },
    }), () => {});
    expect(result.statistics).toEqual([{ count: 3, unit: 'V', mean: 2, std: expect.closeTo(1, 14), min: 1, max: 3, p5: expect.closeTo(1.1), p95: expect.closeTo(2.9) }]);
    const single = await executeTool('spice_monte_carlo', { ...args, runs: 1, tolerances: [{ element: 'r1', sigma: 0, distribution: 'uniform' }] });
    expect(single.structuredContent).toMatchObject({ statistics: [{ count: 1, mean: 5, std: 0, min: 5, max: 5, p5: 5, p95: 5 }] });
  });
});
