import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { simulateProtocolV1 } from '@spice-ts/core';
import { executeTool, MCP_TOOLS } from './server.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const netlist = 'V1 in 0 10\nR1 in 0 1k\n.tran 10u 1m';

function waveform(values: number[], times: number[], window?: [number, number], reverse = false) {
  const plan = powerPlan({ netlist, elements: ['V1'], window, includeVoltageCrestFactor: true });
  if ('error' in plan) throw new Error('Expected transient plan');
  if (reverse) [plan.probes[0].positive, plan.probes[0].negative] = [plan.probes[0].negative, plan.probes[0].positive];
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0,
    timeS: times, voltagesV: { in: values }, currentsA: { V1: times.map(() => 0) } }] }, plan).elements[0];
}

describe('voltage crest factor', () => {
  it('is one for DC and null for zero', () => {
    expect(waveform([5, 5], [0, 1]).voltageCrestFactor).toBeCloseTo(1, 12);
    expect(waveform([0, 0], [0, 1]).voltageCrestFactor).toBeNull();
  });

  it('integrates a piecewise-linear sampled sine and is invariant to terminal reversal', () => {
    const times = [0, 1, 2, 3, 4];
    const values = [0, 1, 0, -1, 0];
    // Four unit-width linear ramps each integrate v² to 1/3.
    expect(waveform(values, times).voltageCrestFactor).toBeCloseTo(Math.sqrt(3), 12);
    expect(waveform(values, times, undefined, true).voltageCrestFactor).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('uses clipped window endpoints for an offset pulse', () => {
    // On [0.5, 2.5], voltage rises 2→3, stays at 3, then falls 3→2.
    // Integral of v² is 19/3 + 9 = 46/3; divide by duration 2.
    expect(waveform([1, 3, 3, 1], [0, 1, 2, 3], [0.5, 2.5]).voltageCrestFactor).toBeCloseTo(3 / Math.sqrt(23 / 3), 12);
  });

  it.each([1e-300, 1e300, Number.MIN_VALUE])('preserves ratios at finite scale %s', scale => {
    expect(waveform([0, scale], [0, 1]).voltageCrestFactor).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('validates public schemas, preserves existing metrics and simulates once', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
    const input = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const output = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    const args = { netlist, elements: ['R1'], includePowerFactor: true, includeCurrentCrestFactor: true, includeCharge: true, windows: [[0, 0.0005]] };
    let calls = 0;
    const enabled = await executeTool(tool.name, { ...args, includeVoltageCrestFactor: true }, { simulate: async request => { calls++; return simulateProtocolV1(request); } });
    const omitted = await executeTool(tool.name, args);
    const disabled = await executeTool(tool.name, { ...args, includeVoltageCrestFactor: false });
    expect(enabled.isError, JSON.stringify(enabled.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(disabled.structuredContent).toEqual(omitted.structuredContent);
    expect(input({ ...args, includeVoltageCrestFactor: true }).valid).toBe(true);
    expect(input({ ...args, includeVoltageCrestFactor: 'true' }).valid).toBe(false);
    expect(output(enabled.structuredContent).valid).toBe(true);
    const report = enabled.structuredContent as { elements: Record<string, unknown>[]; windowResults: { elements: Record<string, unknown>[] }[] };
    expect(report.elements[0].voltageCrestFactor).toBeCloseTo(1, 12);
    expect(report.windowResults[0].elements[0].voltageCrestFactor).toBeCloseTo(1, 12);
    const strip = (r: typeof report) => ({ ...r, elements: r.elements.map(({ voltageCrestFactor: _v, ...e }) => e), windowResults: r.windowResults.map(w => ({ ...w, elements: w.elements.map(({ voltageCrestFactor: _v, ...e }) => e) })) });
    expect(strip(report)).toEqual(omitted.structuredContent);
    expect(output({ ...report, elements: [{ ...report.elements[0], voltageCrestFactor: 'bad' }] }).valid).toBe(false);
    expect(output({ ...report, elements: [{ ...report.elements[0], voltageCrestFactor: null }] }).valid).toBe(true);
  });
});
