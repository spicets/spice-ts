import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const netlist = 'V1 in 0 10\nR1 in 0 1k\n.tran 10u 1m\n.end';
const extrema = (minimumCurrentA: number, minimumCurrentTimeS: number, maximumCurrentA: number, maximumCurrentTimeS: number) =>
  ({ minimumCurrentA, minimumCurrentTimeS, maximumCurrentA, maximumCurrentTimeS });

function synthetic(timeS: number[], current: number[], options: Record<string, unknown> = {}) {
  const plan = powerPlan({ netlist, elements: ['V1'], ...options });
  if ('error' in plan) throw new Error('Expected transient plan');
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS,
    voltagesV: { in: timeS.map(() => 1) }, currentsA: { V1: current } }] }, plan);
}

describe('signed current extrema', () => {
  it('finds analytic extrema on clipped nonuniform linear segments', () => {
    const report = synthetic([0, 1, 3], [-2, 4, 0], { window: [0.5, 2], includeCurrentExtrema: true });
    expect(report.elements[0]).toMatchObject(extrema(1, 0.5, 4, 1));
  });

  it('reports boundary extrema and independent windows with signed values', () => {
    const report = synthetic([0, 1, 3], [-2, 4, 0], { window: [0, 3], windows: [[0, 0.5], [2, 3]], includeCurrentExtrema: true });
    expect(report.elements[0]).toMatchObject(extrema(-2, 0, 4, 1));
    expect(report.windowResults![0].elements[0]).toMatchObject(extrema(-2, 0, 1, 0.5));
    expect(report.windowResults![1].elements[0]).toMatchObject(extrema(0, 3, 2, 2));
  });

  it.each([0, -3, 5])('uses the earliest time for constant current %s', value => {
    expect(synthetic([0, 1, 3], [value, value, value], { window: [0.5, 2], includeCurrentExtrema: true }).elements[0])
      .toMatchObject(extrema(value, 0.5, value, 0.5));
  });

  it('uses earliest extrema when distinct samples tie', () => {
    expect(synthetic([0, 1, 2, 3, 4], [-1, 3, -1, 3, 0], { includeCurrentExtrema: true }).elements[0])
      .toMatchObject(extrema(-1, 0, 3, 1));
  });

  it('does not extrapolate beyond accepted samples', () => {
    expect(() => synthetic([0, 1, 3], [-2, 4, 0], { window: [0, 4], includeCurrentExtrema: true })).toThrow();
  });

  it('rejects non-finite accepted currents with a structured error', () => {
    expect(() => synthetic([0, 1, 3], [-2, Infinity, 0], { includeCurrentExtrema: true }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('leaves the shape unchanged when false or omitted', () => {
    const omitted = synthetic([0, 1, 3], [-2, 4, 0]);
    const disabled = synthetic([0, 1, 3], [-2, 4, 0], { includeCurrentExtrema: false });
    expect(disabled).toEqual(omitted);
    expect(omitted.elements[0]).not.toHaveProperty('minimumCurrentA');
    expect(omitted.elements[0]).not.toHaveProperty('maximumCurrentTimeS');
  });

  it('advertises the schema and exposes signed source/load currents over MCP', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'current-extrema-test', version: '1' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_power_metrics')!;
      expect(tool.inputSchema.properties).toHaveProperty('includeCurrentExtrema', { type: 'boolean' });
      const validator = new AjvJsonSchemaValidator();
      const args = { netlist, elements: ['V1', 'R1'], includeCurrentExtrema: true };
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const result = await client.callTool({ name: tool.name, arguments: args });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(result.structuredContent).valid).toBe(true);
      const report = result.structuredContent as { elements: { name: string; minimumCurrentA: number; maximumCurrentA: number; minimumCurrentTimeS: number; maximumCurrentTimeS: number }[] };
      const source = report.elements.find(e => e.name === 'V1')!;
      const load = report.elements.find(e => e.name === 'R1')!;
      expect(source.minimumCurrentA).toBeCloseTo(-0.01, 10);
      expect(source.maximumCurrentA).toBeCloseTo(-0.01, 10);
      expect(load.minimumCurrentA).toBeCloseTo(0.01, 10);
      expect(load.maximumCurrentA).toBeCloseTo(0.01, 10);
      expect(source.minimumCurrentTimeS).toBe(0);
      expect(load.maximumCurrentTimeS).toBe(0);
      for (const invalid of ['true', 1, null, []]) {
        expect(validator.getValidator(tool.inputSchema)({ ...args, includeCurrentExtrema: invalid }).valid).toBe(false);
        const response = await client.callTool({ name: tool.name, arguments: { ...args, includeCurrentExtrema: invalid } });
        expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      }
      for (const option of [{}, { includeCurrentExtrema: false }]) {
        const plain = await client.callTool({ name: tool.name, arguments: { netlist, ...option } });
        expect((plain.structuredContent as { elements: object[] }).elements[0]).not.toHaveProperty('minimumCurrentA');
      }
    } finally { await client.close(); await server.close(); }
  });
});
