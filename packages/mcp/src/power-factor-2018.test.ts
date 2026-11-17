import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const netlist = 'V1 in 0 10\nR1 in 0 1k\n.tran 10u 1m';
function waveform(voltage: number[], current: number[], timeS: number[], window?: [number, number]) {
  const plan = powerPlan({ netlist, elements: ['V1'], includePowerFactor: true, window });
  if ('error' in plan) throw new Error('Expected transient plan');
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0,
    timeS, voltagesV: { in: voltage }, currentsA: { V1: current } }] }, plan).elements[0];
}

describe('opt-in sampled power factor', () => {
  it('reports +1 for a constant resistive load and -1 for a delivering source', () => {
    expect(waveform([10, 10], [2, 2], [0, 1])).toMatchObject({ rmsVoltageV: 10, apparentPowerVA: 20, powerFactor: 1 });
    expect(waveform([10, 10], [-2, -2], [0, 1])).toMatchObject({ rmsVoltageV: 10, apparentPowerVA: 20, powerFactor: -1 });
  });
  it('reports the phase factor of complete sampled sinusoidal periods', () => {
    const times = Array.from({ length: 1001 }, (_, i) => i / 1000);
    const phi = Math.PI / 3;
    const metric = waveform(times.map(t => 10 * Math.sin(2 * Math.PI * t)), times.map(t => 2 * Math.sin(2 * Math.PI * t - phi)), times);
    expect(Math.abs(metric.powerFactor! - Math.cos(phi))).toBeLessThan(0.002);
  });
  it('integrates clipped irregular piecewise-linear voltage across unequal segments', () => {
    const metric = waveform([10, 0, 2, 20], [1, 1, 1, 1], [0, 1, 3, 4], [1.5, 3.5]);
    expect(metric.rmsVoltageV).toBeCloseTo(Math.sqrt(217) / 4, 12);
  });
  it('reports a reason when apparent power is zero', () => {
    expect(waveform([0, 0], [0, 0], [0, 1])).toMatchObject({ rmsVoltageV: 0, apparentPowerVA: 0, powerFactor: null, powerFactorReason: 'zero_apparent_power' });
  });
  it.each([1e-200, 1e200])('preserves RMS for extreme representable voltage %s', value => {
    const metric = waveform([0, value], [0, 0], [0, 1]);
    expect(metric.rmsVoltageV! / value).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(metric.powerFactor).toBeNull();
  });
  it.each([[1e-200, 1e200], [1e200, 1e-200]])('handles mixed voltage and current scales %s and %s', (v, i) => {
    const metric = waveform([v, v], [i, i], [0, 1]);
    expect(metric.rmsVoltageV! / v).toBeCloseTo(1, 12);
    expect(metric.rmsCurrentA / i).toBeCloseTo(1, 12);
    expect(metric.apparentPowerVA).toBeCloseTo(1, 12);
    expect(metric.powerFactor).toBeCloseTo(1, 12);
  });
  it('validates schemas and keeps disabled output unchanged', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
    const validateInput = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const validateOutput = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    const omitted = await executeTool(tool.name, { netlist, elements: ['R1'] });
    const disabled = await executeTool(tool.name, { netlist, elements: ['R1'], includePowerFactor: false });
    const enabled = await executeTool(tool.name, { netlist, elements: ['R1'], includePowerFactor: true });
    expect(disabled.structuredContent).toEqual(omitted.structuredContent);
    expect((omitted.structuredContent as { elements: object[] }).elements[0]).not.toHaveProperty('powerFactor');
    expect(enabled.structuredContent).toMatchObject({ elements: [{ rmsVoltageV: expect.closeTo(10, 10), apparentPowerVA: expect.closeTo(0.1, 10), powerFactor: expect.closeTo(1, 10) }] });
    expect(validateInput({ netlist, includePowerFactor: true }).valid).toBe(true);
    expect(validateInput({ netlist, includePowerFactor: 'true' }).valid).toBe(false);
    expect(validateOutput(omitted.structuredContent).valid).toBe(true);
    expect(validateOutput(enabled.structuredContent).valid).toBe(true);
    const both = await executeTool(tool.name, { netlist, elements: ['V1', 'R1'], includePowerFactor: true, includeCurrentCrestFactor: true });
    expect(both.structuredContent).toMatchObject({ elements: [
      { powerFactor: expect.closeTo(-1, 10), currentCrestFactor: expect.closeTo(1, 10), energyJ: expect.closeTo(-0.0001, 12) },
      { powerFactor: expect.closeTo(1, 10), currentCrestFactor: expect.closeTo(1, 10), energyJ: expect.closeTo(0.0001, 12) },
    ] });
    expect(validateOutput(both.structuredContent).valid).toBe(true);
    const zero = await executeTool(tool.name, { netlist: 'V1 in 0 0\nR1 in 0 1k\n.tran 10u 1m', elements: ['R1'], includePowerFactor: true });
    expect(zero.structuredContent).toMatchObject({ elements: [{ powerFactor: null, powerFactorReason: 'zero_apparent_power' }] });
    expect(validateOutput(zero.structuredContent).valid).toBe(true);
  });
  it.each(['true', 1, null, []])('rejects nonboolean option %j', async value => {
    expect(await executeTool('spice_power_metrics', { netlist, includePowerFactor: value })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } },
    });
  });
});
