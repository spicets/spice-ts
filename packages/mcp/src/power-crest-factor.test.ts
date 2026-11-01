import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const netlist = 'V1 in 0 10\nR1 in 0 1k\n.tran 10u 1m';

function waveform(currents: number[], times = [0, 1], window?: [number, number]) {
  const plan = powerPlan({ netlist, elements: ['V1'], includeCurrentCrestFactor: true, window });
  if ('error' in plan) throw new Error('Expected transient plan');
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0,
    timeS: times, voltagesV: { in: times.map(() => 0) }, currentsA: { V1: currents } }] }, plan).elements[0];
}

describe('current crest factor', () => {
  it('reports opt-in crest factor through the public tool', async () => {
    const response = await executeTool('spice_power_metrics', { netlist, elements: ['R1'], includeCurrentCrestFactor: true });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ elements: [{ peakAbsCurrentA: expect.closeTo(0.01, 12), currentCrestFactor: expect.closeTo(1, 12) }] });
  });

  it.each([1, -1, 1e-200, -1e-200, 1e200, -1e200])('integrates a linear ramp at scale %s', value => {
    const metric = waveform([0, value]);
    expect(metric.peakAbsCurrentA).toBe(Math.abs(value));
    expect(Math.abs(metric.currentCrestFactor! - Math.sqrt(3))).toBeLessThan(1e-12);
    expect(Math.abs(metric.rmsCurrentA / Math.abs(value) - 1 / Math.sqrt(3))).toBeLessThan(1e-12);
  });

  it('clips both endpoints and ignores larger outside samples', () => {
    const metric = waveform([10, 0, 2, 20], [0, 1, 2, 3], [1.25, 1.75]);
    expect(metric.peakAbsCurrentA).toBe(1.5);
    expect(Math.abs(metric.currentCrestFactor! - 1.5 / Math.sqrt(13 / 12))).toBeLessThan(1e-12);
  });

  it('returns zero and null for zero current', () => {
    expect(waveform([0, 0])).toMatchObject({ rmsCurrentA: 0, peakAbsCurrentA: 0, currentCrestFactor: null });
  });

  it('preserves omitted and false response shapes and advertises optional fields', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
    const validateInput = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const validateOutput = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    const omitted = await executeTool(tool.name, { netlist, elements: ['R1'] });
    const disabled = await executeTool(tool.name, { netlist, elements: ['R1'], includeCurrentCrestFactor: false });
    const enabled = await executeTool(tool.name, { netlist, elements: ['R1'], includeCurrentCrestFactor: true });
    expect(disabled.structuredContent).toEqual(omitted.structuredContent);
    const report = omitted.structuredContent as { elements: Record<string, unknown>[] };
    expect(report.elements[0]).not.toHaveProperty('peakAbsCurrentA');
    expect(report.elements[0]).not.toHaveProperty('currentCrestFactor');
    expect(validateInput({ netlist, includeCurrentCrestFactor: true }).valid).toBe(true);
    expect(validateInput({ netlist, includeCurrentCrestFactor: 'true' }).valid).toBe(false);
    expect(validateOutput(omitted.structuredContent).valid).toBe(true);
    expect(validateOutput(enabled.structuredContent).valid).toBe(true);
  });

  it.each(['true', 1, null, []])('rejects a nonboolean option %j', async value => {
    expect(await executeTool('spice_power_metrics', { netlist, includeCurrentCrestFactor: value })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } },
    });
  });
});
