import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { powerMetrics, powerMetricsArgs, powerPlan, type PowerReport } from './power-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const netlist = 'V1 in 0 PULSE(0 1 0 1u 1u 2m 4m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 1m\n.end';
const flags = { elements: ['V1', 'R1'], input: ['V1'], output: ['R1'], includeCurrentCrestFactor: true, includePowerFactor: true, includeEnergyFlow: true, includeReturnedPowerPeak: true };
const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
const validator = new AjvJsonSchemaValidator();
const inputValid = validator.getValidator(tool.inputSchema);
const outputValid = validator.getValidator(tool.outputSchema!);

describe('multi-window power', () => {
  it('reduces clipped windows against analytic linear-ramp integrals', () => {
    const plan = powerPlan({ netlist: 'V1 in 0 1\n.tran 0.1 1', elements: ['V1'], windows: [[0.25, 0.75], [0.5, 1]] });
    if ('error' in plan) throw new Error('Expected plan');
    const times = [0, 0.125, 0.625, 1];
    const report = powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: times, voltagesV: { in: times }, currentsA: { V1: times.map(t => 1 - t) } }] }, plan);
    const first = report.windowResults![0].elements[0];
    expect(first.energyJ).toBeCloseTo(11 / 96, 12);
    expect(first.averagePowerW).toBeCloseTo(11 / 48, 12);
    expect(first.rmsCurrentA).toBeCloseTo(Math.sqrt(13 / 48), 12);
    expect(first.peakPowerW).toBeCloseTo(0.25, 12);
    expect(first.peakTimeS).toBeCloseTo(0.5, 12);
    const second = report.windowResults![1].elements[0];
    expect(second.energyJ).toBeCloseTo(1 / 12, 12);
    expect(second.averagePowerW).toBeCloseTo(1 / 6, 12);
    expect(second.rmsCurrentA).toBeCloseTo(Math.sqrt(1 / 12), 12);
    expect(second.peakPowerW).toBeCloseTo(0.25, 12);
  });

  it('integrates signed power independently over unequal clipped intervals', () => {
    const windows: [number, number][] = [[0.1, 0.4], [0.4, 0.9], [0.1, 0.4]];
    const plan = powerPlan({ netlist: 'V1 in 0 1\n.tran 0.1 1', elements: ['V1'], windows });
    if ('error' in plan) throw new Error('Expected plan');
    const times = [0, 0.2, 0.6, 1];
    const report = powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: times, voltagesV: { in: times }, currentsA: { V1: times.map(t => 0.5 - t) } }] }, plan);
    expect(report.windowResults!.map(r => r.window)).toEqual(windows);
    for (const [index, [a, b]] of windows.entries()) {
      const energy = (t: number) => t * t / 4 - t * t * t / 3;
      const currentSquared = (t: number) => t / 4 - t * t / 2 + t * t * t / 3;
      const metric = report.windowResults![index].elements[0];
      expect(metric.energyJ).toBeCloseTo(energy(b) - energy(a), 12);
      expect(metric.averagePowerW).toBeCloseTo((energy(b) - energy(a)) / (b - a), 12);
      expect(metric.rmsCurrentA).toBeCloseTo(Math.sqrt((currentSquared(b) - currentSquared(a)) / (b - a)), 12);
    }
    expect(report.windowResults![0].elements[0].peakPowerW).toBeCloseTo(0.0625, 12);
    expect(report.windowResults![0].elements[0].peakTimeS).toBeCloseTo(0.25, 12);
    expect(report.windowResults![1].elements[0].energyJ).toBeLessThan(0);
  });

  it.each([[], Array.from({ length: 17 }, () => [0, 1]), null, [null], [[0]], [[0, 1, 2]], [[0, 0]], [[1, 0]], [[-1, 1]], [[0, Infinity]], [[NaN, 1]], 'bad'])('rejects malformed windows %s', windows => {
    expect(() => powerMetricsArgs({ netlist, windows })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('accepts 16 windows, and rejects out-of-trace bounds through MCP', async () => {
    expect(powerMetricsArgs({ netlist, windows: Array.from({ length: 16 }, () => [0, 0.001]) }).windows).toHaveLength(16);
    for (const windows of [[[0, 0.002]], [[0.0001, 0.0011]]]) {
      const response = await executeTool('spice_power_metrics', { netlist, windows });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const windows of [[], [[0, Infinity]], [[0.5, 0.5]]]) {
      const response = await executeTool('spice_power_metrics', { netlist, windows });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const partial = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0.2, 0.8], voltagesV: { in: [1, 1] }, currentsA: { V1: [1, 1] } }] };
    const response = await executeTool('spice_power_metrics', { netlist, elements: ['V1'], windows: [[0.1, 0.4]] }, { simulate: async () => partial });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('executes one real simulation and matches separate windows, schema and legacy output', async () => {
    const windows = [[0.0001, 0.0004], [0.0003, 0.0009], [0.0001, 0.0004]];
    const args = { netlist, ...flags, window: [0, 0.0008], windows };
    expect(inputValid(args).valid).toBe(true);
    expect(inputValid({ ...args, windows: [] }).valid).toBe(false);
    expect(inputValid({ ...args, windows: Array.from({ length: 17 }, () => [0, 1]) }).valid).toBe(false);
    let calls = 0;
    const multi = await executeTool('spice_power_metrics', args, { simulate: async request => { calls++; return simulateProtocolV1(request); } });
    expect(multi.isError, JSON.stringify(multi.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(outputValid(multi.structuredContent).valid).toBe(true);
    const report = multi.structuredContent as unknown as PowerReport;
    const { windowResults, ...top } = report;
    const legacy = await executeTool('spice_power_metrics', { netlist, ...flags, window: args.window });
    expect(legacy.isError).not.toBe(true);
    expect(legacy.structuredContent).toEqual(top);
    expect(legacy.structuredContent).not.toHaveProperty('windowResults');
    for (const [i, window] of windows.entries()) {
      const single = await executeTool('spice_power_metrics', { netlist, ...flags, window });
      expect(single.isError).not.toBe(true);
      expect(windowResults![i]).toEqual(single.structuredContent);
      expect(windowResults![i]).not.toHaveProperty('windowResults');
      expect(windowResults![i].elements[0]).toHaveProperty('powerFactor');
      expect(windowResults![i].elements[0]).toHaveProperty('currentCrestFactor');
      expect(windowResults![i].elements[0]).toHaveProperty('absorbedEnergyJ');
      expect(windowResults![i].elements[0]).toHaveProperty('peakReturnedPowerW');
    }
    expect(outputValid({ ...report, windowResults: [{ ...windowResults![0], windowResults }] }).valid).toBe(false);
    expect(outputValid({ ...report, windowResults: [{ ...windowResults![0], elements: [{}] }] }).valid).toBe(false);
  });

  it('rejects nonfinite child metrics rather than returning invalid JSON', () => {
    const plan = powerPlan({ netlist: 'V1 in 0 1\n.tran 0.1 1', elements: ['V1'], window: [0, 0.5], windows: [[0.5, 1]] });
    if ('error' in plan) throw new Error('Expected plan');
    const result = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 0.5, 1], voltagesV: { in: [0, 0, 1e308] }, currentsA: { V1: [0, 0, 1e308] } }] };
    expect(() => powerMetrics(result, plan)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
