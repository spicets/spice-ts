import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool, MCP_TOOLS } from './server.js';
import { tranMetrics, type TranMetrics } from './tran-metrics.js';

const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
// Original analytic probes, MIT licensed with this package. No external fixtures.
const rc = 'V1 in 0 PWL(0 0 100u 0 100.001u 1)\nR1 in out 1k\nC1 out 0 1u\n.tran 5u 15m\n.end';
const rlc = 'V1 in 0 PWL(0 0 100u 0 100.001u 1)\nR1 in n 10\nL1 n out 1m\nC1 out 0 1u\n.tran 0.5u 3m\n.end';
function samples(y: number[], x = y.map((_, i) => i)): SimulationResultV1 {
  return { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: x, voltagesV: { out: y }, currentsA: { V1: y.map(v => -v) } }] };
}
const validator = new AjvJsonSchemaValidator();
const schema = () => MCP_TOOLS.find(t => t.name === 'spice_tran_metrics')!.outputSchema!;
async function run(source: string) {
  const response = await executeTool('spice_tran_metrics', { request: request(source), signal: 'v(out)' });
  expect(response.isError).not.toBe(true);
  expect(validator.getValidator(schema())(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as TranMetrics;
}

describe('spice_tran_metrics', () => {
  it('reports sampled slope extrema on nonuniform rising and falling steps', () => {
    const times = [0, 1, 3, 4, 10];
    const rising = tranMetrics(samples([0, 1, 5, 6, 6], times), { signal: 'v(out)' });
    const falling = tranMetrics(samples([6, 5, 1, 0, 0], times), { signal: 'v(out)' });
    expect(rising).toMatchObject({ maxRiseSlewPerS: 2, maxFallSlewPerS: 0, slewUnit: 'V/s' });
    expect(falling).toMatchObject({ maxRiseSlewPerS: 0, maxFallSlewPerS: -2, slewUnit: 'V/s' });
  });
  it('reports both signs for bipolar overshoot, including current and time offsets', () => {
    const y = [-2, -3, 1, 3, 2, 2, 2];
    const times = [0, 1, 2, 3, 4, 5, 10];
    for (const offset of [0, 100]) {
      const result = samples(y, times.map(t => t + offset));
      expect(tranMetrics(result, { signal: 'v(out)' })).toMatchObject({
        maxRiseSlewPerS: 4, maxFallSlewPerS: -1, slewUnit: 'V/s',
      });
      expect(tranMetrics(result, { signal: 'i(v1)' })).toMatchObject({
        maxRiseSlewPerS: 1, maxFallSlewPerS: -4, slewUnit: 'A/s',
      });
    }
  });

  it('rejects overflowing slew arithmetic without returning nonfinite metrics', () => {
    const result = samples([0, 1, 1, 1], [0, Number.MIN_VALUE, 1, 10]);
    expect(tranMetrics(result, { signal: 'v(out)' })).toMatchObject({ error: { code: 'INVALID_DATA' } });
  });

  it('matches an independent adjacent-sample RC reference from core', async () => {
    const simulation = await executeTool('spice_simulate', { request: request(rc) });
    expect(simulation.isError).not.toBe(true);
    const result = simulation.structuredContent as unknown as SimulationResultV1;
    const analysis = result.analyses.find(a => a.type === 'tran')!;
    if (analysis.type !== 'tran') throw new Error('Expected transient');
    const slopes = analysis.timeS.slice(1).map((time, i) =>
      (analysis.voltagesV.out[i + 1] - analysis.voltagesV.out[i]) / (time - analysis.timeS[i]));
    const expectedRise = Math.max(0, ...slopes);
    const expectedFall = Math.min(0, ...slopes);
    const metrics = tranMetrics(result, { signal: 'v(out)' }) as TranMetrics;
    const riseError = Math.abs(metrics.maxRiseSlewPerS - expectedRise);
    const fallError = Math.abs(metrics.maxFallSlewPerS - expectedFall);
    expect(riseError).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expectedRise)));
    expect(fallError).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expectedFall)));
    const publicMetrics = await run(rc);
    expect(publicMetrics).toMatchObject({ maxRiseSlewPerS: expectedRise, maxFallSlewPerS: expectedFall, slewUnit: 'V/s' });
    const { slewUnit: _slewUnit, ...missingUnit } = publicMetrics;
    expect(validator.getValidator(schema())(missingUnit).valid).toBe(false);
  });

  it('matches analytic RC rise time within 1%', async () => {
    const m = await run(rc);
    expect(Math.abs(m.riseTimeS! / (Math.log(9) * 0.001) - 1)).toBeLessThan(0.01);
    expect(m.fallTimeS).toBeNull();
    expect(m.initialValue).toBeCloseTo(0, 6);
    expect(m.finalValue).toBeCloseTo(1, 5);
    expect(m.overshootPercent).toBeLessThan(0.01);
    expect(Math.abs(m.settlingTimeS - (0.0001 - Math.log(0.02) * 0.001))).toBeLessThan(0.00002);
  });

  it('matches analytic underdamped RLC overshoot within 1%', async () => {
    const m = await run(rlc);
    const zeta = 10 / 2 * Math.sqrt(1e-6 / 1e-3);
    const overshoot = 100 * Math.exp(-zeta * Math.PI / Math.sqrt(1 - zeta * zeta));
    expect(Math.abs(m.overshootPercent / overshoot - 1)).toBeLessThan(0.01);
    expect(m.peakValue).toBeCloseTo(1 + overshoot / 100, 3);
    expect(Math.abs(m.peakTimeS - (0.0001 + Math.PI / (Math.sqrt(1 / 1e-9) * Math.sqrt(1 - zeta * zeta))))).toBeLessThan(1e-6);
  });

  it('handles falling, negative, offset and current signals with linear interpolation', () => {
    const result = samples([3, 3, 2.8, 1.2, 1, 0.8, 1, 1, 1, 1, 1]);
    const falling = tranMetrics(result, { signal: 'V(OUT)', finalValue: 1 }) as TranMetrics;
    expect(falling).toMatchObject({
      initialValue: 3, finalValue: 1, riseTimeS: null,
      undershootPercent: 0, peakValue: 0.8, peakTimeS: 5,
    });
    expect(falling.fallTimeS).toBeCloseTo(1, 12);
    expect(falling.overshootPercent).toBeCloseTo(10, 12);
    const current = tranMetrics(result, { signal: 'i(v1)', finalValue: -1 }) as TranMetrics;
    expect(current).toMatchObject({ fallTimeS: null, peakValue: -0.8, unit: 'A' });
    expect(current.riseTimeS).toBeCloseTo(1, 12);
  });

  it.each([
    ['NOT_TRANSIENT', { status: 'complete', analyses: [] }, { signal: 'v(out)' }],
    ['SIGNAL_NOT_FOUND', samples([0, 1, 1]), { signal: 'v(missing)' }],
    ['NO_TRANSITION', samples([1, 1, 1]), { signal: 'v(out)' }],
    ['NO_TRANSITION', samples([0, 0.2, 0.4]), { signal: 'v(out)', finalValue: 1 }],
    ['NOT_SETTLED', samples([0, 0.1, 0.9, 1.5, 0.5, 1.4, 0.6, 1]), { signal: 'v(out)', finalValue: 1 }],
  ])('returns structured %s without throwing', async (code, result, args) => {
    const m = tranMetrics(result as SimulationResultV1, args);
    expect(m).toMatchObject({ error: { code } });
    expect(validator.getValidator(schema())(m).valid).toBe(true);
    const response = await executeTool('spice_tran_metrics', { request: request(rc), ...args }, {
      simulate: async () => result as SimulationResultV1,
    });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code } } });
    expect(validator.getValidator(schema())(response.structuredContent).valid).toBe(true);
  });

  it('rejects malformed vectors, ambiguous selections and invalid selectors', async () => {
    expect(tranMetrics(samples([0, 1, 1], [0, 0, 1]), { signal: 'v(out)' })).toMatchObject({ error: { code: 'INVALID_DATA' } });
    expect(tranMetrics(samples([0, 1, 1], [0, 2, 1]), { signal: 'v(out)' })).toMatchObject({ error: { code: 'INVALID_DATA' } });
    expect(tranMetrics(samples([0, Infinity, 1]), { signal: 'v(out)' })).toMatchObject({ error: { code: 'INVALID_DATA' } });
    expect(tranMetrics(samples([0, NaN, 1]), { signal: 'v(out)' })).toMatchObject({ error: { code: 'INVALID_DATA' } });
    const result = samples([0, 1, 1]);
    result.analyses.push({ ...result.analyses[0] });
    expect(tranMetrics(result, { signal: 'v(out)' })).toMatchObject({ error: { code: 'NOT_TRANSIENT' } });
    for (const extra of [{ settlingBandPercent: 0 }, { settlingBandPercent: 100 }, { finalValue: Infinity }, { analysis: -1 }, { unknown: 1 }]) {
      expect(await executeTool('spice_tran_metrics', { request: request(rc), signal: 'v(out)', ...extra })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
  });

  it('selects an analysis and honors the settling band without extrapolating', () => {
    const result = samples([0, -0.1, 0.1, 0.9, 1.03, 1.03, 1.03, 1.03, 1.03, 1.03, 1.03]);
    expect(tranMetrics(result, { signal: 'v(out)', finalValue: 1 })).toMatchObject({ error: { code: 'NOT_SETTLED' } });
    const m = tranMetrics(result, { signal: 'v(out)', analysis: 0, finalValue: 1, settlingBandPercent: 5 }) as TranMetrics;
    expect(m.undershootPercent).toBeCloseTo(10, 10);
    expect(m.overshootPercent).toBeCloseTo(3, 10);
    expect(m.settlingTimeS).toBeCloseTo(3 + 0.05 / 0.13, 10);
    expect(tranMetrics(result, { signal: 'v(out)', analysis: 1 })).toMatchObject({ error: { code: 'NOT_TRANSIENT' } });
  });

  it('uses explicit endpoint levels and interpolates uneven time samples', () => {
    const m = tranMetrics(samples([0.05, 0.2, 0.8, 1, 1], [0, 1, 3, 5, 10]), {
      signal: 'v(out)', initialValue: 0, finalValue: 1,
    }) as TranMetrics;
    expect(m.initialValue).toBe(0);
    expect(m.riseTimeS).toBeCloseTo(4 - 1 / 3, 12);
    expect(m.settlingTimeS).toBeCloseTo(4.8, 12);
    expect(tranMetrics(samples([0, 1], [0, 1, 2]), { signal: 'v(out)' })).toMatchObject({ error: { code: 'INVALID_DATA' } });
  });

  it('preserves simulation resource bounds', async () => {
    const response = await executeTool('spice_tran_metrics', {
      request: { ...request(rc), options: { limits: { maxResultPoints: 0 } } }, signal: 'v(out)',
    });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('advertises schemas and capabilities, returns typed errors through the executor', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_tran_metrics']) });
    const args = { request: request('V1 out 0 1\nR1 out 0 1k\n.op'), signal: 'v(out)' };
    expect(validator.getValidator(MCP_TOOLS.find(t => t.name === 'spice_tran_metrics')!.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_tran_metrics', args);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_TRANSIENT' } } });
    expect(validator.getValidator(schema())(response.structuredContent).valid).toBe(true);
  });
});
