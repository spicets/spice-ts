import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const dc = 'V1 in 0 10\nR1 in 0 1k\n.tran 10u 1m\n.end';
interface Report {
  elements: { name: string; averagePowerW: number; rmsCurrentA: number; peakPowerW: number; peakTimeS: number }[];
  efficiency: number | null;
  window: [number, number];
}
async function run(netlist: string, extra = {}) {
  const response = await executeTool('spice_power_metrics', { netlist, ...extra });
  expect(response.isError).not.toBe(true);
  const schema = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!.outputSchema!;
  expect(new AjvJsonSchemaValidator().getValidator(schema)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as Report;
}

describe('spice_power_metrics', () => {
  it('reports 0.1 W absorption and negative source delivery from a DC transient', async () => {
    const result = await run(dc);
    const load = result.elements.find(e => e.name === 'R1')!;
    expect(Math.abs(load.averagePowerW / 0.1 - 1)).toBeLessThan(1e-9);
    expect(load.rmsCurrentA).toBeCloseTo(0.01, 12);
    expect(load.peakPowerW).toBeCloseTo(0.1, 12);
    expect(result.elements.find(e => e.name === 'V1')!.averagePowerW).toBeCloseTo(-0.1, 12);
    expect(result.efficiency).toBeNull();
  });

  it('integrates sinusoidal power and squared current over integer periods', async () => {
    const result = await run('V1 in 0 SIN(0 1 1k)\nR1 in 0 1k\n.tran 1u 2m', { elements: ['r1'], window: [0, 0.002] });
    const load = result.elements[0];
    expect(Math.abs(load.averagePowerW / 0.0005 - 1)).toBeLessThan(1e-3);
    expect(Math.abs(load.rmsCurrentA / (Math.SQRT1_2 * 0.001) - 1)).toBeLessThan(1e-3);
    expect(load.peakPowerW).toBeCloseTo(0.001, 7);
  });

  it('computes divider efficiency from signed input delivery and output absorption', async () => {
    const result = await run('V1 in 0 10\nRs in out 1k\nRload out 0 3k\n.tran 10u 1m', {
      elements: ['V1', 'Rload'], input: ['v1'], output: ['rload'], window: [0.000123, 0.000789],
    });
    expect(Math.abs(result.efficiency! / 0.75 - 1)).toBeLessThan(1e-6);
    expect(result.window).toEqual([0.000123, 0.000789]);
  });

  it.each([
    { elements: ['missing'] }, { window: [1, 0] }, { window: [-1, 1] },
    { window: [0, Infinity] }, { elements: [] }, { input: ['V1'] },
    { input: ['V1'], output: ['missing'] }, { surprise: true },
    { window: [0, 2] }, { elements: ['R1', 'r1'] },
  ])('returns structured invalid arguments: %j', async extra => {
    expect(await executeTool('spice_power_metrics', { netlist: dc, ...extra })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });

  it('returns NOT_TRANSIENT when no transient is present', async () => {
    expect(await executeTool('spice_power_metrics', { netlist: 'V1 in 0 10\nR1 in 0 1k\n.op' })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'NOT_TRANSIENT' } },
    });
  });

  it('advertises the tool in capabilities', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({
      tools: expect.arrayContaining(['spice_power_metrics']),
    });
  });

  it('clips nonuniform segments and trapezoidally integrates power and squared current', () => {
    const plan = powerPlan({ netlist: dc, elements: ['V1'], window: [0.5, 2] });
    if ('error' in plan) throw new Error('Expected a plan');
    const report = powerMetrics({ status: 'complete', analyses: [{
      type: 'tran', analysisIndex: 0, timeS: [0, 1, 3],
      voltagesV: { in: [2, 2, 2] }, currentsA: { V1: [0, 1, 3] },
    }] }, plan);
    // p(t)=2t; i^2 is interpolated between accepted samples, not re-squared at clipped edges.
    expect(report.elements[0].averagePowerW).toBeCloseTo(2.5, 12);
    expect(report.elements[0].rmsCurrentA).toBeCloseTo(Math.sqrt(2.25), 12);
    expect(report.elements[0]).toMatchObject({ peakPowerW: 4, peakTimeS: 2 });
  });

  it('handles floating terminal voltages and probe-name collisions', async () => {
    const result = await run('V1 a 0 12\nV2 b 0 2\nR1 a b 1k\nV__power_0 __power_0 0 0\n.tran 10u 1m', { elements: ['R1'] });
    expect(result.elements[0].averagePowerW).toBeCloseTo(0.1, 12);
  });

  it('uses simulated capacitor current during a charging transient', async () => {
    const result = await run('V1 in 0 PWL(0 0 1u 0 1.001u 1)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 10m', { elements: ['C1'] });
    // Average capacitor absorption is the stored 0.5*C*V^2 divided by duration.
    expect(Math.abs(result.elements[0].averagePowerW / 0.00005 - 1)).toBeLessThan(0.002);
  });

  it('returns null efficiency for zero or absorbing designated input', async () => {
    const result = await run(dc, { input: ['R1'], output: ['V1'] });
    expect(result.efficiency).toBeNull();
  });

  it.each([
    `${dc}\n.step param r 1 2 1`,
    '.subckt sub a b\nR1 a b 1k\n.ends\nX1 in 0 sub\nV1 in 0 10\n.tran 1u 1m',
    'V1 in 0 10\nR1 in 0 1k\n.op\n.tran 10u 1m',
    'V1 in 0 10\nM1 in in 0 0 model\n.model model NMOS\n.tran 10u 1m',
  ])('rejects unsupported decks rather than emitting incomplete metrics', async netlist => {
    expect(await executeTool('spice_power_metrics', { netlist })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });

  it('preserves solver failures and resource limits', async () => {
    expect(await executeTool('spice_power_metrics', { netlist: 'V1 a 0 1\nV2 a 0 2\nR1 a 0 1k\n.tran 1u 1m' })).toMatchObject({ isError: true });
    expect(await executeTool('spice_power_metrics', { netlist: dc }, { limits: { ...DEFAULT_MCP_LIMITS, maxDocumentBytes: 10 } })).toMatchObject({ isError: true });
  });
});
