import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nR2 out 0 2k\n.noise V(out) V1 dec 20 10 1000\n.end';

describe('output noise centroid MCP protocol', () => {
  it('advertises and validates the opt-in selector and returns a resistor-noise centroid', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'centroid-test', version: '1.0.0' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_noise_metrics')!;
      expect(tool.inputSchema.properties).toHaveProperty('includeOutputNoiseCentroid');
      const validator = new AjvJsonSchemaValidator();
      const args = { netlist, bandHz: [20, 800], bandsHz: [[30, 300]], includeOutputNoiseCentroid: true };
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const result = await client.callTool({ name: tool.name, arguments: args });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(result.structuredContent).valid).toBe(true);
      const data = result.structuredContent as { outputNoiseCentroidHz: number; bandResults: { outputNoiseCentroidHz: number }[] };
      expect(data.outputNoiseCentroidHz).toBeCloseTo(410, 9);
      expect(data.bandResults[0].outputNoiseCentroidHz).toBeCloseTo(165, 9);
      console.log('resistor deck primary / band centroid Hz', data.outputNoiseCentroidHz, data.bandResults[0].outputNoiseCentroidHz);
      for (const invalid of ['true', 1, null, []]) {
        expect(validator.getValidator(tool.inputSchema)({ ...args, includeOutputNoiseCentroid: invalid }).valid).toBe(false);
        const response = await client.callTool({ name: tool.name, arguments: { ...args, includeOutputNoiseCentroid: invalid } });
        expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      }
      const plain = await client.callTool({ name: tool.name, arguments: { netlist, bandsHz: [[30, 300]] } });
      expect(plain.structuredContent).not.toHaveProperty('outputNoiseCentroidHz');
      expect((plain.structuredContent as { bandResults: object[] }).bandResults[0]).not.toHaveProperty('outputNoiseCentroidHz');
    } finally { await client.close(); await server.close(); }
  });
});
