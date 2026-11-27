import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { simulateNoiseProtocolV1 } from '@spice-ts/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';

const netlist = (source: 'V' | 'I') => `${source}1 in 0 AC 1\nR1 in out 1k\nR2 out 0 2k\n.noise V(out) ${source}1 dec 20 10 1000\n.end`;
const validator = new AjvJsonSchemaValidator();

class Worker extends EventEmitter {
  postMessage(message: { request: Parameters<typeof simulateNoiseProtocolV1>[0] }): void {
    void simulateNoiseProtocolV1(message.request).then(result => this.emit('message', { type: 'result', result }), error => this.emit('error', error));
  }
  terminate(): number { return 0; }
}

describe('input crest MCP', () => {
  it.each(['V', 'I'] as const)('executes a real %s-source noise analysis with selected bands', async source => {
    const args = { netlist: netlist(source), bandHz: [20, 800], bandsHz: [[30, 300]], includeInputNoiseCrest: true, includeOutputNoiseCrest: true };
    const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
    const response = await executeTool(tool.name, args, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const result = response.structuredContent as unknown as { inputUnit: string; inputNoiseSpectralCrest: number; outputNoiseSpectralCrest: number; bandResults: { inputNoiseSpectralCrest: number; outputNoiseSpectralCrest: number }[] };
    expect(result.inputUnit).toBe(source === 'I' ? 'A' : 'V');
    expect(result.inputNoiseSpectralCrest).toBeCloseTo(1, 12);
    expect(result.outputNoiseSpectralCrest).toBeCloseTo(1, 12);
    expect(result.bandResults[0].inputNoiseSpectralCrest).toBeCloseTo(1, 12);
    expect(result.bandResults[0].outputNoiseSpectralCrest).toBeCloseTo(1, 12);
  });

  it('advertises schemas, rejects nonbooleans and preserves omitted/false results over MCP', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'input-crest-test', version: '1.0.0' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_noise_metrics')!;
      expect(tool.inputSchema.properties).toHaveProperty('includeInputNoiseCrest');
      const successSchema = (tool.outputSchema as unknown as { oneOf: { properties?: object }[] }).oneOf[0];
      expect(successSchema.properties).toHaveProperty('inputNoiseSpectralCrest');
      expect(successSchema.properties).toHaveProperty('inputNoiseSpectralCrestReason');
      const args = { netlist: netlist('V'), bandHz: [20, 800], bandsHz: [[30, 300]], includeInputNoiseCrest: true };
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await client.callTool({ name: tool.name, arguments: args });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      expect(response.structuredContent).toHaveProperty('inputNoiseSpectralCrest');
      for (const invalid of ['true', 1, null, []]) {
        expect(validator.getValidator(tool.inputSchema)({ ...args, includeInputNoiseCrest: invalid }).valid).toBe(false);
        const rejected = await client.callTool({ name: tool.name, arguments: { ...args, includeInputNoiseCrest: invalid } });
        expect(rejected).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
      }
      const plain = await client.callTool({ name: tool.name, arguments: { netlist: netlist('V'), bandsHz: [[30, 300]], includeOutputNoiseCrest: true } });
      const disabled = await client.callTool({ name: tool.name, arguments: { netlist: netlist('V'), bandsHz: [[30, 300]], includeOutputNoiseCrest: true, includeInputNoiseCrest: false } });
      expect(JSON.stringify(disabled.structuredContent)).toBe(JSON.stringify(plain.structuredContent));
      expect(plain.structuredContent).not.toHaveProperty('inputNoiseSpectralCrest');
    } finally { await client.close(); await server.close(); }
  });
});
