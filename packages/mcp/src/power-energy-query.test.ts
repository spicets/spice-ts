import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { powerMetrics, powerMetricsArgs, powerPlan } from './power-metrics.js';
import type { PowerReport } from './power-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const netlist = 'V1 in 0 2\nR1 in 0 2\n.tran 0.01 1\n.end';
const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
const inputValid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
const outputValid = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);

describe('cumulative energy queries', () => {
  it('integrates clipped constant and ramp power on an irregular grid in request order', () => {
    const times = [0, 0.3, 0.7, 1];
    const queries = [0.75, 0.25, 0.5, 0.25, 1];
    const plan = powerPlan({ netlist, elements: ['V1'], window: [0.25, 1], energyTimesS: queries });
    if ('error' in plan) throw new Error('Expected plan');
    const result = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: times, voltagesV: { in: [2, 2, 2, 2] }, currentsA: { V1: [1, 1, 1, 1] } }] };
    const constant = powerMetrics(result, plan).elements[0];
    expect(constant.energySamples).toEqual([{ timeS: 0.75, energyJ: 1 }, { timeS: 0.25, energyJ: 0 }, { timeS: 0.5, energyJ: 0.5 }, { timeS: 0.25, energyJ: 0 }, { timeS: 1, energyJ: 1.5 }]);
    expect(constant.energySamples![4].energyJ).toBe(constant.energyJ);
    const ramp = powerMetrics({ ...result, analyses: [{ ...result.analyses[0], voltagesV: { in: times }, currentsA: { V1: [1, 1, 1, 1] } }] }, plan).elements[0];
    for (const [index, t] of queries.entries()) expect(ramp.energySamples![index].energyJ).toBeCloseTo((t * t - 0.25 ** 2) / 2, 12);
  });

  it('retains signed returned power and leaves legacy results unchanged', () => {
    const args = { netlist, elements: ['V1'] };
    const plan = powerPlan({ ...args, energyTimesS: [0, 0.5, 1] });
    const oldPlan = powerPlan(args);
    if ('error' in plan || 'error' in oldPlan) throw new Error('Expected plan');
    const result = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 0.4, 1], voltagesV: { in: [1, 1, 1] }, currentsA: { V1: [1, 0.2, -1] } }] };
    const report = powerMetrics(result, plan);
    const { energySamples, ...element } = report.elements[0];
    expect(energySamples![1].energyJ).toBeCloseTo(0.25, 12);
    expect(energySamples![2].energyJ).toBeCloseTo(0, 12);
    expect(element).toEqual(powerMetrics(result, oldPlan).elements[0]);
  });

  it.each([[], Array(129).fill(0), [NaN], [Infinity], [-Infinity], ['1'], null, 1, {}])('rejects invalid timestamp lists %j', energyTimesS => {
    expect(() => powerMetricsArgs({ netlist, energyTimesS })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('accepts 128 timestamps and rejects non-finite computed energy', () => {
    expect(powerMetricsArgs({ netlist, energyTimesS: Array(128).fill(0) }).energyTimesS).toHaveLength(128);
    const plan = powerPlan({ netlist, elements: ['V1'], energyTimesS: [0.5] });
    if ('error' in plan) throw new Error('Expected plan');
    const result = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1], voltagesV: { in: [1e308, 1e308] }, currentsA: { V1: [2, 2] } }] };
    expect(() => powerMetrics(result, plan)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    const cancellation = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 16], voltagesV: { in: [5e307, 5e307] }, currentsA: { V1: [1, -1] } }] };
    const legacy = powerPlan({ netlist, elements: ['V1'] });
    const sampled = powerPlan({ netlist, elements: ['V1'], energyTimesS: [8] });
    if ('error' in legacy || 'error' in sampled) throw new Error('Expected plan');
    expect(powerMetrics(cancellation, legacy).elements[0].energyJ).toBe(0);
    expect(() => powerMetrics(cancellation, sampled)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('runs a real resistor simulation once and validates schemas', async () => {
    const args = { netlist, elements: ['V1', 'R1'], energyTimesS: [0.0005, 0, 0.001, 0.0005], window: [0, 0.001] };
    expect(inputValid(args).valid).toBe(true);
    let calls = 0;
    const response = await executeTool('spice_power_metrics', args, { simulate: async request => { calls++; return simulateProtocolV1(request); } });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(outputValid(response.structuredContent).valid).toBe(true);
    const report = response.structuredContent as unknown as PowerReport;
    expect(outputValid({ ...report, elements: [{ ...report.elements[0], energySamples: [{ timeS: 0, energyJ: 'bad' }] }] }).valid).toBe(false);
    for (const e of report.elements) {
      const sign = e.name === 'V1' ? -1 : 1;
      expect(e.energySamples![0].energyJ).toBeCloseTo(sign * 0.001, 10);
      expect(e.energySamples![1].energyJ).toBe(0);
      expect(e.energySamples![2].energyJ).toBe(e.energyJ);
      expect(e.energySamples![3]).toEqual(e.energySamples![0]);
    }
  });

  it('rejects invalid bounds and multi-window requests with structured errors', async () => {
    for (const args of [{ energyTimesS: [-0.1] }, { energyTimesS: [1.1] }, { window: [0.2, 0.8], energyTimesS: [0.1] }, { windows: [[0, 1]], energyTimesS: [0.5] }, { energyTimesS: [] }, { energyTimesS: [Infinity] }, { energyTimesS: ['0'] }]) {
      let calls = 0;
      const response = await executeTool('spice_power_metrics', { netlist, ...args }, { simulate: async request => { calls++; return simulateProtocolV1(request); } });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      if ('windows' in args || !Array.isArray(args.energyTimesS) || !args.energyTimesS.length || !args.energyTimesS.every(t => typeof t === 'number' && Number.isFinite(t))) expect(calls).toBe(0);
    }
  });
});
