import { describe, expect, it } from 'vitest';
import { executeTool, DEFAULT_MCP_LIMITS, createToolExecutor } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: '* Original MIT RC optimizer fixture\n.param rval=1k cval=1u\nV1 in 0 DC 0 AC 1\nR1 in out {rval}\nC1 out 0 {cval}\n.ac dec 100 0.01 10meg\n.end' } };
const objective = { kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -10 * Math.log10(2), edge: 'falling' };
const args = { request, parameters: [{ name: 'rval', min: 100, max: 100000 }], objective, target: 1000, maxEvaluations: 40 };
interface Result { bestParams: Record<string, number>; achievedValue: number; converged: boolean; evaluations: number; history: { params: Record<string, number>; value: number; error: number }[] }

describe('spice_optimize', () => {
  it('finds the analytic RC resistance within 1% in at most 40 evaluations, deterministically', async () => {
    const before = JSON.stringify(args);
    const first = await executeTool('spice_optimize', args);
    expect(first.isError, JSON.stringify(first.structuredContent)).not.toBe(true);
    const result = first.structuredContent as unknown as Result;
    expect(result.converged).toBe(true);
    expect(Math.abs(result.bestParams.rval / (1 / (2 * Math.PI * 1e-6 * 1000)) - 1)).toBeLessThan(0.01);
    expect(result.evaluations).toBeLessThanOrEqual(40);
    expect(result.evaluations).toBe(result.history.length);
    expect(JSON.stringify(await executeTool('spice_optimize', args))).toBe(JSON.stringify(first));
    expect(JSON.stringify(args)).toBe(before);
    console.info('RC optimize receipt', JSON.stringify({ resistance: result.bestParams.rval, achievedValue: result.achievedValue, evaluations: result.evaluations }));
  }, 60000);

  it('returns a structured nonconvergence error with the best endpoint and complete history', async () => {
    const response = await executeTool('spice_optimize', { ...args, target: 10000 });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'TARGET_NOT_REACHED' }, bestParams: { rval: 100 }, converged: false } });
    const result = response.structuredContent as unknown as Result;
    expect(result.achievedValue).toBeGreaterThan(1500);
    expect(result.evaluations).toBeLessThanOrEqual(40);
  }, 60000);

  it.each([2, 3])('searches %i parameters within the shared evaluation budget', async count => {
    const source = '* Original MIT divider fixture\n.param a=1 b=1 c=1\nV1 in 0 1\nR1 in out {a*b*c}\nR2 out 0 1\n.op\n.end';
    const response = await executeTool('spice_optimize', { request: { ...request, input: { format: 'spice', source } }, parameters: ['a', 'b', 'c'].slice(0, count).map(name => ({ name, min: 1, max: 4 })), objective: { kind: 'max', signal: 'v(out)', analysis: 0 }, target: 0.1, tolerance: 0.001, maxEvaluations: 80 });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ converged: true });
    expect((response.structuredContent as unknown as Result).evaluations).toBeLessThanOrEqual(80);
  }, 60000);

  it('enforces strict inputs, caps, unknown parameters and tiny budgets', async () => {
    for (const fields of [{ parameters: [] }, { parameters: [{ name: 'rval', min: 1, max: 1 }] }, { parameters: [args.parameters[0], { ...args.parameters[0], name: 'RVAL' }] }, { target: NaN }, { tolerance: 0 }, { maxEvaluations: 1.5 }, { unexpected: true }]) {
      expect(await executeTool('spice_optimize', { ...args, ...fields })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    expect(await executeTool('spice_optimize', { ...args, maxEvaluations: 101 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect(await executeTool('spice_optimize', { ...args, parameters: [{ name: 'missing', min: 1, max: 2 }] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNKNOWN_PARAMETER' } } });
    const tiny = await executeTool('spice_optimize', { ...args, maxEvaluations: 1 });
    expect(tiny.structuredContent).toMatchObject({ evaluations: 1, converged: false });
  });

  it('preserves objective failures, cancellation, quotas and output limits', async () => {
    expect(await executeTool('spice_optimize', { ...args, objective: { ...objective, signal: 'v(missing)' } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'OBJECTIVE_ERROR' } } });
    expect(await executeTool('spice_optimize', args, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
    expect(await createToolExecutor({ streamLimits: { maxConcurrentJobs: 0 } })('spice_optimize', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect(await executeTool('spice_optimize', args, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_optimize']) });
  });
});
