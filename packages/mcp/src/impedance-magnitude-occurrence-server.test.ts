import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';
import { executeTool } from './server.js';

const port = { positive: 'in', negative: '0' };
const capacitance = 0.0028144773233982714;
const request = { apiVersion: '1', input: { format: 'spice', source: `* series RLC\nR1 in a 1\nL1 a b 1\nC1 b 0 ${capacitance}\nRleak b 0 1g\n.ac lin 5 1 5\n.end` } };

describe('magnitude occurrence MCP protocol', () => {
  it('advertises the selector and returns the second analytically sampled crossing', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'occurrence-test', version: '1' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_impedance')!;
      expect(tool.inputSchema.properties?.magnitudeCrossingOccurrence).toMatchObject({ type: 'integer', minimum: 1, maximum: 128 });
      const args = { request, port, magnitudeLevelsOhm: [20], magnitudeCrossingOccurrence: 2 };
      const validateInput = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      expect(validateInput(args).valid).toBe(true);
      expect(validateInput({ request, port }).valid).toBe(true);
      expect(validateInput({ request, port, magnitudeLevelsOhm: [20] }).valid).toBe(true);
      expect(validateInput({ request, port, magnitudeCrossingOccurrence: 1 }).valid).toBe(false);
      expect(validateInput({ ...args, magnitudeLevelsOhm: [] }).valid).toBe(false);
      expect(validateInput({ ...args, magnitudeCrossingOccurrence: 129 }).valid).toBe(false);
      const response = await client.callTool({ name: tool.name, arguments: args });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      const result = response.structuredContent as { magnitudeCrossings: { frequencyHz: number }[] };
      const magnitude = (f: number) => {
        const omega = 2 * Math.PI * f;
        const b = omega * capacitance;
        const denominator = 1e-18 + b * b;
        return Math.hypot(1 + 1e-9 / denominator, omega - b / denominator);
      };
      const expected = 4 + (20 - magnitude(4)) / (magnitude(5) - magnitude(4));
      expect(Math.abs(result.magnitudeCrossings[0].frequencyHz - expected)).toBeLessThanOrEqual(1e-12);
    } finally { await client.close(); await server.close(); }
  });
  it('returns a structured error when occurrence has no magnitude levels', async () => {
    const response = await executeTool('spice_impedance', { request, port, magnitudeCrossingOccurrence: 1 });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
});
