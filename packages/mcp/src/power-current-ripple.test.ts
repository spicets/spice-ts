import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { powerMetrics, powerMetricsArgs, powerPlan, type PowerReport } from './power-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const netlist = 'V1 in 0 PWL(0 0 0.3m 2 0.7m 1 1m 3)\nR1 in 0 1k\n.tran 10u 1m\n.end';
function synthetic(times: number[], current: number[], windows?: [number, number][]) {
  const plan = powerPlan({ netlist: 'V1 in 0 1\n.tran 0.1 1', elements: ['V1'], includeCurrentRipple: true, windows });
  if ('error' in plan) throw new Error('Expected plan');
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0,
    timeS: times, voltagesV: { in: times.map(() => 0) }, currentsA: { V1: current } }] }, plan);
}
function close(actual: number, expected: number, tolerance = 1e-12) {
  expect(Math.abs(actual / expected - 1)).toBeLessThan(tolerance);
}
// Independent direct integrals of centered piecewise linear segments on a clipped interval.
function oracle(times: number[], values: number[], start: number, stop: number) {
  const pieces: [number, number, number][] = [];
  for (let i = 1; i < times.length; i++) {
    const a = Math.max(start, times[i - 1]); const b = Math.min(stop, times[i]);
    if (a >= b) continue;
    const at = (t: number) => values[i - 1] + (values[i] - values[i - 1]) * (t - times[i - 1]) / (times[i] - times[i - 1]);
    pieces.push([at(a), at(b), b - a]);
  }
  const mean = pieces.reduce((sum, [a, b, dt]) => sum + (a + b) * dt / 2, 0) / (stop - start);
  return Math.sqrt(pieces.reduce((sum, [a, b, dt]) => sum + dt * ((a - mean) ** 2 + (a - mean) * (b - mean) + (b - mean) ** 2) / 3, 0) / (stop - start));
}

describe('DC-removed current RMS', () => {
  it('handles constant DC and an analytic linear ramp', () => {
    expect(synthetic([0, 1], [9, 9]).elements[0].rmsAcCurrentA).toBe(0);
    close(synthetic([0, 1], [0, 2]).elements[0].rmsAcCurrentA!, 1 / Math.sqrt(3));
  });
  it('integrates unequal segments and independently clipped windows, with sign and translation invariance', () => {
    const times = [0, 0.2, 0.7, 1]; const values = [1, 3, -1, 2];
    const windows: [number, number][] = [[0.1, 0.9], [0.25, 0.65], [0, 1]];
    for (const transformed of [values, values.map(x => -x), values.map(x => x + 32)]) {
      const report = synthetic(times, transformed, windows);
      for (const [index, [start, stop]] of windows.entries()) close(report.windowResults![index].elements[0].rmsAcCurrentA!, oracle(times, values, start, stop));
    }
  });
  it('preserves resolvable ripple under large DC bias and extreme current scales', () => {
    close(synthetic([0, 1], [1e15, 1e15 + 2]).elements[0].rmsAcCurrentA!, 1 / Math.sqrt(3));
    for (const scale of [1e-200, 1e200]) close(synthetic([0, 1], [0, scale]).elements[0].rmsAcCurrentA!, scale / Math.sqrt(12));
    close(synthetic([0, 0.5, 1], [1e308, 0, -1e308]).elements[0].rmsAcCurrentA!, 1e308 / Math.sqrt(3));
  });
  it('returns a structured numeric error for non-finite metrics', () => {
    expect(() => synthetic([0, 1], [1e308, -1e308])).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
  it('keeps omitted and false reports unchanged', () => {
    const plan = powerPlan({ netlist, elements: ['V1'] });
    if ('error' in plan) throw new Error('Expected plan');
    const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 1], voltagesV: { in: [0, 0] }, currentsA: { V1: [0, 2] } }] };
    const omitted = powerMetrics(result, plan);
    expect(powerMetrics(result, { ...plan, args: { ...plan.args, includeCurrentRipple: false } })).toEqual(omitted);
    expect(omitted.elements[0]).not.toHaveProperty('rmsAcCurrentA');
  });
  it.each(['true', 1, null, {}, []])('rejects invalid option %j as a structured error', async value => {
    expect(() => powerMetricsArgs({ netlist, includeCurrentRipple: value })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(await executeTool('spice_power_metrics', { netlist, includeCurrentRipple: value })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
  it('exposes schemas and matches independent integration of actual MCP resistor samples in one simulation', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    const args = { netlist, elements: ['R1'], includeCurrentRipple: true, windows: [[0.0001, 0.0009], [0.0003, 0.0007]] };
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    expect(validator.getValidator(tool.inputSchema)({ ...args, includeCurrentRipple: 'yes' }).valid).toBe(false);
    let sampled: SimulationResultV1 | undefined; let calls = 0;
    const response = await executeTool(tool.name, args, { simulate: async request => { calls++; sampled = await simulateProtocolV1(request); return sampled; } });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const report = response.structuredContent as unknown as PowerReport;
    const trace = sampled!.analyses.find(a => a.type === 'tran')!;
    if (trace.type !== 'tran') throw new Error('Expected transient');
    const plan = powerPlan(args as Parameters<typeof powerPlan>[0]);
    if ('error' in plan) throw new Error('Expected plan');
    const values = trace.currentsA[plan.probes[0].branch];
    for (const [i, [start, stop]] of args.windows.entries()) close(report.windowResults![i].elements[0].rmsAcCurrentA!, oracle(trace.timeS, values, start, stop), 1e-10);
  });
});
