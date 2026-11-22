import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';
import { executeTool, MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const base = { request: { apiVersion: '1', input: { format: 'spice', source: '* matching\nR1 in 0 100\n.ac lin 1 100 100\n.end' } }, port };
const validator = new AjvJsonSchemaValidator();
const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;

describe('matching metrics MCP integration', () => {
  it('lists and runs a real simulation over MCP and validates the schemas', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'matching-test', version: '1' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const schema = (await client.listTools()).tools.find(t => t.name === 'spice_impedance')!;
      const args = { ...base, referenceResistanceOhm: 50, includeMatchingMetrics: true };
      expect(validator.getValidator(schema.inputSchema)(args).valid).toBe(true);
      const response = await client.callTool({ name: tool.name, arguments: args });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      const output = validator.getValidator(schema.outputSchema!);
      expect(output(response.structuredContent).valid).toBe(true);
      const data = response.structuredContent as { points: { returnLossDb: number; vswr: number }[] };
      expect(data.points[0].returnLossDb).toBeCloseTo(20 * Math.log10(3), 5);
      expect(data.points[0].vswr).toBeCloseTo(2, 5);
      const malformed = { ...data, points: [{ ...data.points[0], vswr: null }] };
      expect(output(malformed).valid).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it.each([{ includeMatchingMetrics: true }, { includeMatchingMetrics: 'yes', referenceResistanceOhm: 50 }, { includeMatchingMetrics: true, referenceResistanceOhm: 0 }])('returns structured validation error %#', async input => {
    const response = await executeTool(tool.name, { ...base, ...input });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
});
