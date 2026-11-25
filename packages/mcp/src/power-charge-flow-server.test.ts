import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import type { PowerReport } from './power-metrics.js';

const netlist = 'V1 in 0 10\nR1 in 0 1000\n.tran 10u 1m\n.end';
const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
const inputValid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
const outputValid = new AjvJsonSchemaValidator().getValidator(tool.outputSchema!);

describe('charge flow MCP integration', () => {
  it('uses source and series-probe signs, preserving charge and window order with one simulation', async () => {
    const args = { netlist, elements: ['V1', 'R1'], includeCharge: true, includeChargeFlow: true, windows: [[0.0005, 0.001], [0, 0.00025]] };
    expect(inputValid(args).valid).toBe(true);
    let calls = 0;
    const response = await executeTool('spice_power_metrics', args, { simulate: async request => { calls++; return simulateProtocolV1(request); } });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(outputValid(response.structuredContent).valid).toBe(true);
    const report = response.structuredContent as unknown as PowerReport;
    expect(report.windowResults!.map(r => r.window)).toEqual(args.windows);
    for (const r of [report, ...report.windowResults!]) {
      const duration = r.window[1] - r.window[0];
      const [source, resistor] = r.elements;
      expect(source.positiveChargeC).toBe(0);
      expect(source.negativeChargeC).toBeCloseTo(0.01 * duration, 14);
      expect(resistor.positiveChargeC).toBeCloseTo(0.01 * duration, 14);
      expect(resistor.negativeChargeC).toBe(0);
      for (const e of r.elements) expect(e.chargeC).toBeCloseTo(e.positiveChargeC! - e.negativeChargeC!, 14);
    }
    expect(outputValid({ ...report, elements: [{ ...report.elements[0], positiveChargeC: 'bad' }] }).valid).toBe(false);
  });
  it('omits the fields by default and when false', async () => {
    const args = { netlist, elements: ['R1'] };
    const baseline = await executeTool('spice_power_metrics', args);
    const disabled = await executeTool('spice_power_metrics', { ...args, includeChargeFlow: false });
    expect(disabled.structuredContent).toEqual(baseline.structuredContent);
    expect((baseline.structuredContent as unknown as PowerReport).elements[0]).not.toHaveProperty('positiveChargeC');
    expect((baseline.structuredContent as unknown as PowerReport).elements[0]).not.toHaveProperty('negativeChargeC');
  });
  it.each(['true', 1, null, {}, []])('rejects invalid includeChargeFlow %j', async includeChargeFlow => {
    const args = { netlist, includeChargeFlow };
    expect(inputValid(args).valid).toBe(false);
    expect(await executeTool('spice_power_metrics', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
});
