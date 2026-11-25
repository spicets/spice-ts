import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.noise V(out) V1 dec 20 10 1000\n.end';
const base = { netlist, bandHz: [10, 1000], bandsHz: [[10, 100], [100, 1000]] };

describe('input noise fractions MCP protocol', () => {
  it('discovers schemas and returns structured success and validation errors', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'input-fraction-test', version: '1.0.0' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_noise_metrics')!;
      expect(tool.inputSchema.properties).toHaveProperty('includeInputNoiseBandFractions');
      const validator = new AjvJsonSchemaValidator();
      const selected = { ...base, includeInputNoiseBandFractions: true, includeOutputNoiseBandFractions: true };
      expect(validator.getValidator(tool.inputSchema)(selected).valid).toBe(true);
      const reply = await client.callTool({ name: tool.name, arguments: selected });
      expect(reply.isError, JSON.stringify(reply.structuredContent)).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(reply.structuredContent).valid).toBe(true);
      const rows = (reply.structuredContent as { bandResults: { inputNoisePowerFraction: number; outputNoisePowerFraction: number }[] }).bandResults;
      expect(rows[0].inputNoisePowerFraction + rows[1].inputNoisePowerFraction).toBeCloseTo(1, 10);
      expect(rows[0].outputNoisePowerFraction + rows[1].outputNoisePowerFraction).toBeCloseTo(1, 10);
      for (const arguments_ of [{ ...base, includeInputNoiseBandFractions: 'true' }, { netlist, includeInputNoiseBandFractions: true }, { ...base, bandHz: [20, 1000], includeInputNoiseBandFractions: true }]) {
        const error = await client.callTool({ name: tool.name, arguments: arguments_ });
        expect(error).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
      }
    } finally { await client.close(); await server.close(); }
  });
});
