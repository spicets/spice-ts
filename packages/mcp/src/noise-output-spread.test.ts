import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './index.js';
import { noiseMetrics } from './noise-metrics.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nR2 out 0 2k\n.noise V(out) V1 dec 20 10 1000\n.end';
const spread = (frequencies: number[], density: number[], bandHz: [number, number], bandsHz?: [number, number][]) =>
  noiseMetrics(new NoiseResult(frequencies, 'out', 'V1', density, density, undefined, undefined), { bandHz, bandsHz, includeOutputNoiseSpread: true }) as { outputNoiseSpreadHz: number | null; outputNoiseSpreadReason?: string; bandResults?: { outputNoiseSpreadHz: number | null; outputNoiseSpreadReason?: string }[] };

describe('output noise spectral spread', () => {
  it('integrates a flat PSD over clipped irregular bands', () => {
    const r = spread([2, 7, 19, 40], [1, 1, 1, 1], [4, 31], [[6, 12], [11, 29]]);
    expect(r.outputNoiseSpreadHz).toBeCloseTo(27 / Math.sqrt(12), 12);
    expect(r.bandResults![0].outputNoiseSpreadHz).toBeCloseTo(6 / Math.sqrt(12), 12);
    expect(r.bandResults![1].outputNoiseSpreadHz).toBeCloseTo(18 / Math.sqrt(12), 12);
  });
  it('integrates a triangular PSD analytically', () => {
    const f = [1, 2, 5, 9];
    const r = spread(f, f.map(x => Math.sqrt(x - 1)), [1, 9]);
    expect(r.outputNoiseSpreadHz).toBeCloseTo(8 / Math.sqrt(18), 12);
  });
  it.each([1e-200, 1e200])('preserves spread for density scale %s', scale => {
    const r = spread([1, 2, 4], [scale, scale, scale], [1, 4]);
    expect(r.outputNoiseSpreadHz).toBeCloseTo(3 / Math.sqrt(12), 12);
  });
  it('retains narrow high-frequency spread', () => {
    const a = 1e15; const r = spread([a, a + 1, a + 4], [1, 1, 1], [a, a + 4]);
    expect(r.outputNoiseSpreadHz).toBeCloseTo(4 / Math.sqrt(12), 12);
  });
  it('reports zero power explicitly', () => {
    const r = spread([1, 2, 4], [0, 0, 0], [1, 4], [[1, 2]]);
    expect(r).toMatchObject({ outputNoiseSpreadHz: null, outputNoiseSpreadReason: 'zero integrated output noise', bandResults: [{ outputNoiseSpreadHz: null, outputNoiseSpreadReason: 'zero integrated output noise' }] });
  });
  it('advertises and exercises the MCP schema and real resistor noise', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(); const client = new Client({ name: 'spread-test', version: '1.0.0' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_noise_metrics')!;
      const validate = new AjvJsonSchemaValidator();
      const args = { netlist, bandHz: [20, 800], bandsHz: [[30, 300]], includeOutputNoiseSpread: true };
      expect(tool.inputSchema.properties).toHaveProperty('includeOutputNoiseSpread');
      expect(validate.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await client.callTool({ name: tool.name, arguments: args });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(validate.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      const r = response.structuredContent as { outputNoiseSpreadHz: number; bandResults: { outputNoiseSpreadHz: number }[] };
      expect(r.outputNoiseSpreadHz).toBeCloseTo(780 / Math.sqrt(12), 8);
      expect(r.bandResults[0].outputNoiseSpreadHz).toBeCloseTo(270 / Math.sqrt(12), 8);
      for (const value of ['true', 1, null, []]) {
        expect(validate.getValidator(tool.inputSchema)({ ...args, includeOutputNoiseSpread: value }).valid).toBe(false);
        const invalid = await client.callTool({ name: tool.name, arguments: { ...args, includeOutputNoiseSpread: value } });
        expect(invalid.isError).toBe(true);
      }
      for (const selector of [{}, { includeOutputNoiseSpread: false }]) {
        const plain = await client.callTool({ name: tool.name, arguments: { netlist, bandsHz: [[30, 300]], ...selector } });
        expect(plain.structuredContent).not.toHaveProperty('outputNoiseSpreadHz');
        expect((plain.structuredContent as { bandResults: object[] }).bandResults[0]).not.toHaveProperty('outputNoiseSpreadHz');
      }
    } finally { await client.close(); await server.close(); }
  });
});
