import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';
import { executeTool } from './server.js';

const deck = `* passive lead network\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 in out 1u\nR2 out 0 1k\n.ac dec 100 1 100k\n.end`;
const base = { request: { apiVersion: '1', input: { format: 'spice', source: deck } }, output: 'out', input: 'in' };

describe('phase crossing direction MCP', () => {
  it('advertises the option and returns ascending and descending crossings of a real lead network', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'phase-direction-test', version: '1.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const schema = (await client.listTools()).tools.find(t => t.name === 'spice_ac_metrics')!;
      expect(schema.inputSchema.properties?.phaseCrossingDirection).toMatchObject({ type: 'string', enum: ['ascending', 'descending', 'either'] });
      const query = async (phaseCrossingDirection: string) => client.callTool({ name: schema.name, arguments: { ...base, phaseCrossingsDeg: [10, 30], phaseCrossingDirection } });
      const ascending = await query('ascending');
      const descending = await query('descending');
      expect(ascending.isError).not.toBe(true);
      expect(descending.isError).not.toBe(true);
      expect(new AjvJsonSchemaValidator().getValidator(schema.outputSchema!)(ascending.structuredContent).valid).toBe(true);
      const a = (ascending.structuredContent as { phaseCrossings: { frequencyHz: number | null; reason?: string }[] }).phaseCrossings;
      const d = (descending.structuredContent as { phaseCrossings: { frequencyHz: number | null }[] }).phaseCrossings;
      expect(a[0].frequencyHz).toBeGreaterThan(1);
      expect(d[0].frequencyHz!).toBeGreaterThan(a[0].frequencyHz!);
      expect(a[1]).toEqual({ targetDeg: 30, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
      const either = await query('either');
      expect((either.structuredContent as { phaseCrossings: unknown[] }).phaseCrossings[0]).toEqual(a[0]);
      for (const args of [{ ...base, phaseCrossingDirection: 'ascending' }, { ...base, phaseCrossingsDeg: [10], phaseCrossingDirection: 'sideways' }]) {
        expect(await executeTool(schema.name, args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
        expect(await client.callTool({ name: schema.name, arguments: args })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
