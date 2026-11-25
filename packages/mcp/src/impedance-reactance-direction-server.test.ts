import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';

describe('directional reactance MCP integration', () => {
  it('advertises the selector and interpolates measured RLC samples', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'reactance-direction-test', version: '1' });
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_impedance')!;
      expect(tool.inputSchema.properties?.reactanceCrossingDirection).toMatchObject({ enum: ['rising', 'falling', 'either'] });
      const args = { request: { apiVersion: '1', input: { format: 'spice', source: '* series RLC\nR1 in a 10\nL1 a b 10m\nC1 b 0 1u\nRleak b 0 1g\n.ac dec 10 100 10000\n.end' } }, port: { positive: 'in', negative: '0' }, reactanceLevelsOhm: [0], reactanceCrossingDirection: 'rising' };
      expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await client.callTool({ name: tool.name, arguments: args });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      const report = response.structuredContent as { points: { frequencyHz: number; reactanceOhm: number }[]; reactanceCrossings: { frequencyHz: number }[] };
      const i = report.points.findIndex((p, index) => index > 0 && report.points[index - 1].reactanceOhm < 0 && p.reactanceOhm >= 0);
      expect(i).toBeGreaterThan(0);
      const a = report.points[i - 1]; const b = report.points[i];
      const fraction = -a.reactanceOhm / (b.reactanceOhm - a.reactanceOhm);
      const expected = a.frequencyHz * (b.frequencyHz / a.frequencyHz) ** fraction;
      expect(Math.abs(report.reactanceCrossings[0].frequencyHz / expected - 1)).toBeLessThan(1e-10);
      const falling = await client.callTool({ name: tool.name, arguments: { ...args, reactanceCrossingDirection: 'falling' } });
      expect(falling.isError).not.toBe(true);
      expect((falling.structuredContent as { reactanceCrossings: { frequencyHz: number | null }[] }).reactanceCrossings[0].frequencyHz).toBeNull();
    } finally { await client.close(); await server.close(); }
  });
});
