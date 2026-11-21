import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import type { PowerReport } from './power-metrics.js';

const netlist = 'V1 in 0 PULSE(0 10 0 1u 1u 10m 20m)\nR1 in out 1k\nC1 out 0 1u\n.tran 0.000001 0.003\n.end';
const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
const inputValid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
const outputValid = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);
const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components: [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'dc', dc: 10 } },
  { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
], nets: ['in'] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }], models: [], subcircuits: [] };

describe('charge MCP integration', () => {
  it('preserves legacy shape and independently integrates windows with one simulation', async () => {
    const args = { netlist, elements: ['V1', 'R1', 'C1'], window: [0, 0.002], windows: [[0.0002, 0.001], [0.001, 0.002]] };
    let calls = 0;
    const charged = await executeTool('spice_power_metrics', { ...args, includeCharge: true }, { simulate: async request => { calls++; return simulateProtocolV1(request); } });
    expect(charged.isError, JSON.stringify(charged.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(outputValid(charged.structuredContent).valid).toBe(true);
    const report = charged.structuredContent as unknown as PowerReport;
    const legacy = await executeTool('spice_power_metrics', args);
    const falseOption = await executeTool('spice_power_metrics', { ...args, includeCharge: false });
    expect(falseOption.structuredContent).toEqual(legacy.structuredContent);
    const strip = (r: PowerReport) => ({ ...r, elements: r.elements.map(({ chargeC: _q, averageCurrentA: _i, ...e }) => e) });
    const { windowResults, ...top } = report;
    const old = legacy.structuredContent as unknown as PowerReport;
    const { windowResults: _w, ...oldTop } = old;
    expect(strip(top)).toEqual(oldTop);
    for (const [i, window] of args.windows.entries()) {
      const single = await executeTool('spice_power_metrics', { netlist, elements: args.elements, window, includeCharge: true });
      expect(windowResults![i]).toEqual(single.structuredContent);
      expect(strip(windowResults![i])).toEqual(old.windowResults![i]);
    }
    expect(outputValid({ ...report, elements: [{ ...report.elements[0], chargeC: 'bad' }] }).valid).toBe(false);
  });

  it('compares integrated capacitor current with C times voltage change', async () => {
    let start = 0; let end = 0;
    const response = await executeTool('spice_power_metrics', { netlist, elements: ['C1'], includeCharge: true }, {
      simulate: async request => {
        const result = await simulateProtocolV1(request);
        const trace = result.analyses.find(a => a.type === 'tran');
        if (!trace || trace.type !== 'tran') throw new Error('Missing transient');
        const v = trace.voltagesV.out; start = v[0]; end = v[v.length - 1];
        return result;
      },
    });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const q = (response.structuredContent as unknown as PowerReport).elements[0].chargeC!;
    // Trapezoidal integration of accepted-timepoint current differs from the solver's discrete charge by O(dt).

    expect(end - start).toBeGreaterThan(9);
    expect(Math.abs(q - 1e-6 * (end - start))).toBeLessThan(2e-8);
  });

  it('uses the existing inductor and voltage-source branch orientations', async () => {
    const response = await executeTool('spice_power_metrics', { netlist: 'V1 in 0 1\nR1 in out 1\nL1 out 0 1m\n.tran 1u 1m\n.end', elements: ['V1', 'L1', 'R1'], includeCharge: true });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const elements = (response.structuredContent as unknown as PowerReport).elements;
    expect(elements.find(e => e.name === 'V1')!.chargeC).toBeCloseTo(-0.001, 10);
    expect(elements.find(e => e.name === 'L1')!.chargeC).toBeCloseTo(0.001, 10);
    expect(elements.find(e => e.name === 'R1')!.chargeC).toBeCloseTo(0.001, 10);
  });

  it('supports native JSON requests', async () => {
    const args = { request: { apiVersion: '1', input: { format: 'spice-ts', document } }, elements: ['V1', 'R1'], includeCharge: true };
    expect(inputValid(args).valid).toBe(true);
    const response = await executeTool('spice_power_metrics', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(outputValid(response.structuredContent).valid).toBe(true);
    const r = response.structuredContent as unknown as PowerReport;
    expect(r.elements[0].chargeC).toBeCloseTo(-1e-5, 12);
    expect(r.elements[1].chargeC).toBeCloseTo(1e-5, 12);
  });

  it.each(['true', 1, null, {}, []])('rejects invalid includeCharge %j', async includeCharge => {
    const args = { netlist, includeCharge };
    expect(inputValid(args).valid).toBe(false);
    expect(await executeTool('spice_power_metrics', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
});
