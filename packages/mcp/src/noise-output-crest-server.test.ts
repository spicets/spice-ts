import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nR2 out 0 2k\n.noise V(out) V1 dec 20 10 1000\n.end';

describe('output noise spectral crest MCP protocol', () => {
  it('validates the schema and returns crest for primary and sub-bands', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'crest-test', version: '1.0.0' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_noise_metrics')!;
      const validator = new AjvJsonSchemaValidator();
      const args = { netlist, bandHz: [20, 800], bandsHz: [[30, 300]], includeOutputNoiseCrest: true };
      expect(tool.inputSchema.properties).toHaveProperty('includeOutputNoiseCrest');
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await client.callTool({ name: tool.name, arguments: args });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      const result = response.structuredContent as { outputNoiseSpectralCrest: number; bandResults: { outputNoiseSpectralCrest: number }[] };
      expect(result.outputNoiseSpectralCrest).toBeCloseTo(1, 12);
      expect(result.bandResults[0].outputNoiseSpectralCrest).toBeCloseTo(1, 12);
      for (const invalid of ['true', 1, null, []]) {
        expect(validator.getValidator(tool.inputSchema)({ ...args, includeOutputNoiseCrest: invalid }).valid).toBe(false);
        const response = await client.callTool({ name: tool.name, arguments: { ...args, includeOutputNoiseCrest: invalid } });
        expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      }
      const plain = await client.callTool({ name: tool.name, arguments: { netlist, bandsHz: [[30, 300]] } });
      const disabled = await client.callTool({ name: tool.name, arguments: { netlist, bandsHz: [[30, 300]], includeOutputNoiseCrest: false } });
      expect(JSON.stringify(disabled.structuredContent)).toBe(JSON.stringify(plain.structuredContent));
      expect(plain.structuredContent).not.toHaveProperty('outputNoiseSpectralCrest');
      expect((plain.structuredContent as { bandResults: object[] }).bandResults[0]).not.toHaveProperty('outputNoiseSpectralCrest');
    } finally { await client.close(); await server.close(); }
  });
});
