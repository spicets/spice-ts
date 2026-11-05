import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const dc = 'V1 in 0 10\nR1 in 0 1k\n.tran 0.00001 0.001\n.end';
function synthetic(times: number[], voltage: number[], current: number[], window?: [number, number]) {
  const plan = powerPlan({ netlist: dc, elements: ['V1'], includeReturnedPowerPeak: true, window });
  if ('error' in plan) throw new Error('Expected a plan');
  return powerMetrics({ status: 'complete', analyses: [{
    type: 'tran', analysisIndex: 0, timeS: times,
    voltagesV: { in: voltage }, currentsA: { V1: current },
  }] }, plan).elements[0];
}

describe('returned power peak', () => {
  it('finds the quadratic minimum between zero-power endpoints', () => {
    // Independent analytic oracle: -p(t)=t(1-t), with maximum 1/4 at t=1/2.
    const metric = synthetic([0, 1], [0, 1], [-1, 0]);
    expect(metric).toMatchObject({ peakReturnedPowerW: 0.25, peakReturnedPowerTimeS: 0.5 });
  });

  it('clips the quadratic before finding the peak', () => {
    const metric = synthetic([0, 1], [0, 1], [-1, 0], [0.6, 1]);
    expect(Math.abs(metric.peakReturnedPowerW! - 0.24)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(metric.peakReturnedPowerTimeS! - 0.6)).toBeLessThanOrEqual(1e-12);
  });

  it('reports zero and null for absorption and earliest time for constant delivery', () => {
    expect(synthetic([0, 1], [2, 2], [3, 3])).toMatchObject({ peakReturnedPowerW: 0, peakReturnedPowerTimeS: null });
    expect(synthetic([0, 1], [2, 2], [-3, -3], [0.2, 0.8])).toMatchObject({ peakReturnedPowerW: 6, peakReturnedPowerTimeS: 0.2 });
  });

  it('handles sign crossings and nonuniform ties', () => {
    expect(synthetic([0, 1], [2, 2], [1, -1])).toMatchObject({ peakReturnedPowerW: 2, peakReturnedPowerTimeS: 1 });
    expect(synthetic([0, 0.5, 2, 5, 9], [0, 2, 0, 2, 0], [-1, -1, -1, -1, -1]))
      .toMatchObject({ peakReturnedPowerW: 2, peakReturnedPowerTimeS: 0.5 });
  });

  it('uses differential terminal voltage', () => {
    const plan = powerPlan({ netlist: 'V1 in out 1\nR1 in out 1k\n.tran 1u 1m', elements: ['V1'], includeReturnedPowerPeak: true });
    if ('error' in plan) throw new Error('Expected a plan');
    const metric = powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 1],
      voltagesV: { in: [3, 4], out: [3, 3] }, currentsA: { V1: [-1, 0] } }] }, plan).elements[0];
    expect(metric).toMatchObject({ peakReturnedPowerW: 0.25, peakReturnedPowerTimeS: 0.5 });
  });

  it('rejects non-finite output from finite inputs', () => {
    expect(() => synthetic([0, 1], [1e200, 1e200], [-1e200, -1e200])).toThrowError();
  });

  it('exposes valid schema and real MCP source and resistor results without changing default fields', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
    const validateInput = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const validateOutput = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
    const args = { netlist: dc, elements: ['V1', 'R1'], includeReturnedPowerPeak: true };
    expect(validateInput(args).valid).toBe(true);
    const response = await executeTool('spice_power_metrics', args);
    expect(response.isError).not.toBe(true);
    expect(validateOutput(response.structuredContent).valid).toBe(true);
    const report = response.structuredContent as unknown as { elements: { name: string; peakReturnedPowerW: number; peakReturnedPowerTimeS: number | null }[] };
    const source = report.elements.find(e => e.name === 'V1')!;
    const resistor = report.elements.find(e => e.name === 'R1')!;
    expect(source.peakReturnedPowerW).toBeCloseTo(0.1, 12);
    expect(source.peakReturnedPowerTimeS).toBe(0);
    expect(resistor).toMatchObject({ peakReturnedPowerW: 0, peakReturnedPowerTimeS: null });
    const baseline = await executeTool('spice_power_metrics', { netlist: dc, elements: ['V1', 'R1'] });
    expect(validateOutput(baseline.structuredContent).valid).toBe(true);
    const original = baseline.structuredContent as unknown as { elements: Record<string, unknown>[] };
    for (const element of original.elements) {
      expect(element).not.toHaveProperty('peakReturnedPowerW');
      expect(element).not.toHaveProperty('peakReturnedPowerTimeS');
      const withPeak = report.elements.find(e => e.name === element.name)!;
      const { peakReturnedPowerW: _w, peakReturnedPowerTimeS: _t, ...other } = withPeak;
      expect(other).toEqual(element);
    }
    expect(validateOutput({ ...report, elements: [{ ...source, peakReturnedPowerTimeS: 'invalid' }] }).valid).toBe(false);
  });

  it.each(['true', 1, null, {}, []])('rejects invalid option %j via schema and MCP', async value => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)({ netlist: dc, includeReturnedPowerPeak: value }).valid).toBe(false);
    expect(await executeTool('spice_power_metrics', { netlist: dc, includeReturnedPowerPeak: value })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });
});
