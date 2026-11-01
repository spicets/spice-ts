import { describe, expect, it } from 'vitest';
import { DEFAULT_MCP_LIMITS, executeTool } from './server.js';
import { powerPlan } from './power-metrics.js';

interface Report {
  elements: { name: string; averagePowerW: number; rmsCurrentA: number }[];
}

describe('controlled-source power metrics', () => {
  it.each([
    ['E', '2', 0.004, 0.002],
    ['G', '0.001', 0.001, 0.001],
  ])('measures linear %s output power and load balance', async (type, gain, watts, amps) => {
    const netlist = `Vcontrol ctl 0 1\n${type}1 out 0 ctl 0 ${gain}\nRload out 0 1k\n.tran 10u 1m`;
    const response = await executeTool('spice_power_metrics', { netlist, elements: [`${type}1`, 'Rload', 'Vcontrol'] });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const report = response.structuredContent as unknown as Report;
    const source = report.elements.find(e => e.name === `${type}1`)!;
    const load = report.elements.find(e => e.name === 'Rload')!;
    const control = report.elements.find(e => e.name === 'Vcontrol')!;
    expect(source.averagePowerW).toBeCloseTo(-watts, 10);
    expect(load.averagePowerW).toBeCloseTo(watts, 10);
    expect(source.averagePowerW + load.averagePowerW).toBeCloseTo(0, 10);
    expect(source.rmsCurrentA).toBeCloseTo(amps, 10);
    expect(load.rmsCurrentA).toBeCloseTo(amps, 10);
    expect(control.rmsCurrentA).toBeCloseTo(0, 10);
  });

  it.each([['E', '2', 0.004, 0.002], ['G', '0.001', 0.001, 0.001]])(
    'preserves reversed %s output terminals and control wiring despite probe collisions', async (type, gain, watts, amps) => {
      const netlist = `Vcontrol ctl 0 1\n${type}1 0 out ctl 0 ${gain}\nRload out 0 1k\nV__power_0 __power_0 0 0\n.tran 10u 1m`;
      const plan = powerPlan({ netlist, elements: [`${type}1`, 'Rload'] });
      if ('error' in plan) throw new Error(plan.error.message);
      expect(plan.netlist).toContain(`${type}1 __power_1 out ctl 0 ${gain}`);
      const response = await executeTool('spice_power_metrics', { netlist, elements: [`${type}1`, 'Rload'] });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      const [source, load] = (response.structuredContent as unknown as Report).elements;
      expect(source.averagePowerW).toBeCloseTo(-watts, 10);
      expect(load.averagePowerW).toBeCloseTo(watts, 10);
      expect(source.rmsCurrentA).toBeCloseTo(amps, 10);
      expect(source.averagePowerW + load.averagePowerW).toBeCloseTo(0, 10);
    },
  );

  it.each(['E', 'G'])('rejects unsupported %s POLY cards with a structured error', async type => {
    const netlist = `Vcontrol ctl 0 1\n${type}1 out 0 poly(1) ctl 0 0 1\nRload out 0 1k\n.tran 10u 1m`;
    const response = await executeTool('spice_power_metrics', { netlist, elements: [`${type}1`] });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: expect.any(String) } } });
  });

  it.each([['E', '2', 0.004], ['G', '0.001', 0.001]])('handles parenthesized %s terminal pairs', async (type, gain, watts) => {
    const netlist = `Vcontrol ctl 0 1\n${type}1 (out 0) (ctl 0) ${gain}\nRload out 0 1k\n.tran 10u 1m`;
    const response = await executeTool('spice_power_metrics', { netlist, elements: [`${type}1`, 'Rload'] });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const [source, load] = (response.structuredContent as unknown as Report).elements;
    expect(source.averagePowerW).toBeCloseTo(-watts, 10);
    expect(load.averagePowerW).toBeCloseTo(watts, 10);
  });

  it('leaves a control terminal shared with the output node untouched', async () => {
    const netlist = 'V1 out 0 1\nG1 out 0 out 0 0.001\nR1 out 0 1k\n.tran 10u 1m';
    const response = await executeTool('spice_power_metrics', { netlist, elements: ['G1', 'R1', 'V1'] });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const [source, load, supply] = (response.structuredContent as unknown as Report).elements;
    expect(source.averagePowerW).toBeCloseTo(0.001, 10);
    expect(load.averagePowerW).toBeCloseTo(0.001, 10);
    expect(supply.averagePowerW).toBeCloseTo(-0.002, 10);
    expect(source.rmsCurrentA).toBeCloseTo(0.001, 10);
  });

  it('retains the selection limit', async () => {
    const netlist = 'Vcontrol ctl 0 1\nE1 out 0 ctl 0 2\nRload out 0 1k\n.tran 10u 1m';
    const response = await executeTool('spice_power_metrics', { netlist, elements: Array.from({ length: 129 }, (_, i) => `E${i}`) });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('preserves server resource limits for controlled-source measurements', async () => {
    const netlist = 'Vcontrol ctl 0 1\nE1 out 0 ctl 0 2\nRload out 0 1k\n.tran 10u 1m';
    const response = await executeTool('spice_power_metrics', { netlist, elements: ['E1'] },
      { limits: { ...DEFAULT_MCP_LIMITS, maxDocumentBytes: 10 } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: expect.any(String) } } });
  });
});
