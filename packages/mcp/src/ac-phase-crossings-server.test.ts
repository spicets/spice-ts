import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './index.js';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const deck = `* RC\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 20 1 100k\n.end`;
const base = { request: { apiVersion: '1', input: { format: 'spice', source: deck } }, output: 'out', input: 'in' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
const validator = new AjvJsonSchemaValidator();

describe('phase crossings MCP', () => {
  it('lists and calls the tool over MCP transport', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'phase-crossings-test', version: '1.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const schema = listed.tools.find(t => t.name === 'spice_ac_metrics');
      expect(schema?.inputSchema.properties).toHaveProperty('phaseCrossingsDeg');
      const response = await client.callTool({ name: tool.name, arguments: { ...base, phaseCrossingsDeg: [-45, -120] } });
      expect(response.isError).not.toBe(true);
      expect(validator.getValidator(schema!.outputSchema!)(response.structuredContent).valid).toBe(true);
      expect(response.structuredContent).toMatchObject({ phaseCrossings: [{ targetDeg: -45, frequencyHz: expect.any(Number) }, { targetDeg: -120, frequencyHz: null, reason: 'NO_PHASE_CROSSING' }] });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('advertises schema, validates input and emits compatible structured output', async () => {
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    expect((tool.inputSchema.properties as Record<string, unknown>).phaseCrossingsDeg).toMatchObject({ type: 'array', minItems: 1, maxItems: 32, items: { type: 'number' } });
    const args = { ...base, phaseCrossingsDeg: [-45, -45, -120] };
    expect(input(args).valid).toBe(true);
    const response = await executeTool(tool.name, args);
    expect(response.isError).not.toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    const result = response.structuredContent as { phaseCrossings: { targetDeg: number; frequencyHz: number | null; reason?: string }[] };
    expect(result.phaseCrossings[0].frequencyHz).toBeCloseTo(1 / (2 * Math.PI * 1e-3), 1);
    expect(result.phaseCrossings[1]).toEqual(result.phaseCrossings[0]);
    expect(result.phaseCrossings[2]).toEqual({ targetDeg: -120, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
    const legacy = await executeTool(tool.name, base);
    const { phaseCrossings: _crossings, ...rest } = response.structuredContent as Record<string, unknown>;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(legacy.structuredContent));
    for (const targets of [[], Array(33).fill(0), [NaN], [Infinity], [-Infinity], ['-45'], null]) {
      expect(await executeTool(tool.name, { ...base, phaseCrossingsDeg: targets })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const targets of [[], Array(33).fill(0), ['-45'], null]) expect(input({ ...base, phaseCrossingsDeg: targets }).valid).toBe(false);
    expect(input({ ...base, phaseCrossingsDeg: Array(32).fill(-45) }).valid).toBe(true);
  });
  it('uses one simulation and differential input and output', async () => {
    const phase = (degrees: number) => ({ magnitude: 1, phaseDegrees: degrees });
    const zero = phase(0);
    const trace: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: [10, 1000], currentPhasors: {}, voltagePhasors: {
      op: [phase(-25), phase(-115)], om: [zero, zero].map(() => ({ magnitude: 0, phaseDegrees: 0 })),
      ip: [phase(20), phase(20)], im: [zero, zero].map(() => ({ magnitude: 0, phaseDegrees: 0 })),
    } }] };
    const simulate = vi.fn(async () => trace);
    const response = await executeTool(tool.name, { ...base, output: 'v(op,om)', input: 'v(ip,im)', phaseCrossingsDeg: [-90, -90] }, { simulate });
    expect(response.isError).not.toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
    const crossings = (response.structuredContent as { phaseCrossings: { frequencyHz: number }[] }).phaseCrossings;
    expect(crossings[0].frequencyHz).toBeCloseTo(100);
    expect(crossings[1]).toEqual(crossings[0]);
  });
  it('selects a stepped sweep', async () => {
    const request = { ...base.request, input: { ...base.request.input, source: deck.replace('.end', '.step param R1 list 1k 2k\n.end') } };
    const get = async (step: number) => {
      const response = await executeTool(tool.name, { ...base, request, step, phaseCrossingsDeg: [-45] });
      expect(response.isError).not.toBe(true);
      return (response.structuredContent as { phaseCrossings: { frequencyHz: number }[] }).phaseCrossings[0].frequencyHz;
    };
    expect(await get(0)).toBeCloseTo(1 / (2 * Math.PI * 1e-3), 1);
    expect(await get(1)).toBeCloseTo(1 / (2 * Math.PI * 2e-3), 1);
  });
});
