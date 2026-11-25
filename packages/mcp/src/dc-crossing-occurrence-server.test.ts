import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './index.js';

const source = '* flat independent source\nV1 in 0 0\nV2 out 0 2\nR1 in 0 1k\nR2 out 0 1k\n.dc V1 0 3 1\n.end';
const base = { request: { apiVersion: '1', input: { format: 'spice', source } }, sweptSource: 'V1', output: 'v(out)', outputLevelsV: [2] };

describe('DC crossing occurrence MCP', () => {
  it('advertises, validates and returns real flat-source results', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'dc-occurrence-test', version: '1' });
    try {
      await server.connect(st);
      await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_dc_metrics')!;
      expect(tool.inputSchema.properties?.crossingOccurrence).toMatchObject({ type: 'integer', minimum: 1, maximum: 128 });
      const query = (args: Record<string, unknown>) => client.callTool({ name: tool.name, arguments: args });
      const first = await query({ ...base, crossingOccurrence: 1 });
      const defaultResult = await query(base);
      const second = await query({ ...base, crossingOccurrence: 2 });
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(second.structuredContent).valid).toBe(true);
      expect(first.structuredContent).toEqual(defaultResult.structuredContent);
      expect(first.structuredContent).toMatchObject({ levelCrossings: [{ outputLevelV: 2, sweepPoint: 0 }] });
      expect(second.structuredContent).toMatchObject({ levelCrossings: [{ outputLevelV: 2, sweepPoint: null }] });
      for (const args of [{ ...base, crossingOccurrence: 0 }, { ...base, outputLevelsV: undefined, crossingOccurrence: 2 }]) {
        // The SDK's callTool validates error payloads against the success schema; inspect the raw MCP response instead.
        expect(await client.request({ method: 'tools/call', params: { name: tool.name, arguments: args } }, CallToolResultSchema)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
