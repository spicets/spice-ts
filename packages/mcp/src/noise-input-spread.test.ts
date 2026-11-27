import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './index.js';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { nets: ['in', 'out'], components: [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'ac', magnitude: 1, dc: 0 } },
  { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
  { type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { capacitance: 1e-9 } },
] }, analyses: [], models: [], subcircuits: [], noiseAnalyses: [{ type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 20, startFreq: 10, stopFreq: 1000 }] };
const request = { apiVersion: '1', input: { format: 'spice-ts', document } };
const spread = (frequencies: number[], density: number[], bandHz: [number, number], bandsHz?: [number, number][]) =>
  noiseMetrics(new NoiseResult(frequencies, 'out', 'V1', density.map(() => 0), density, undefined, undefined), { bandHz, bandsHz, includeInputNoiseSpread: true }) as { inputNoiseSpreadHz: number | null; inputNoiseSpreadReason?: string; bandResults?: { inputNoiseSpreadHz: number | null; inputNoiseSpreadReason?: string }[] };

describe('input noise spectral spread', () => {
  it('integrates a flat PSD over clipped irregular bands', () => {
    const r = spread([2, 7, 19, 40], [1, 1, 1, 1], [4, 31], [[6, 12], [11, 29]]);
    expect(r.inputNoiseSpreadHz).toBeCloseTo(27 / Math.sqrt(12), 12);
    expect(r.bandResults![0].inputNoiseSpreadHz).toBeCloseTo(6 / Math.sqrt(12), 12);
    expect(r.bandResults![1].inputNoiseSpreadHz).toBeCloseTo(18 / Math.sqrt(12), 12);
  });
  it('integrates a triangular PSD analytically', () => {
    const f = [1, 2, 5, 9];
    const r = spread(f, f.map(x => Math.sqrt(x - 1)), [1, 9]);
    expect(r.inputNoiseSpreadHz).toBeCloseTo(8 / Math.sqrt(18), 12);
  });
  it.each([1e-200, 1e200])('preserves spread for density scale %s', scale => {
    const r = spread([1, 2, 4], [scale, scale, scale], [1, 4]);
    expect(r.inputNoiseSpreadHz).toBeCloseTo(3 / Math.sqrt(12), 12);
  });
  it('retains finite spread across a near-maximum frequency range', () => {
    const result = spread([1, 1e308], [1e-155, 1e-155], [1, 1e308]);
    expect(result.inputNoiseSpreadHz! / (1e308 / Math.sqrt(12))).toBeCloseTo(1, 12);
  });
  it('retains narrow high-frequency spread', () => {
    const a = 1e15; const r = spread([a, a + 1, a + 4], [1, 1, 1], [a, a + 4]);
    expect(r.inputNoiseSpreadHz).toBeCloseTo(4 / Math.sqrt(12), 12);
  });
  it('retains a weak distant PSD tail in the second moment', () => {
    const result = spread([1, 2, 3, 1e150], [1, 1, 1e-200, 1e-200], [1, 1e150]);
    expect(result.inputNoiseSpreadHz! / 4.714045207910317e24).toBeCloseTo(1, 12);
  });
  it('retains finite spread when a zero-power tail extends the band', () => {
    const result = spread([1, 2, 3, 1e200], [1, 1, 0, 0], [1, 1e200]);
    expect(result.inputNoiseSpreadHz).toBeCloseTo(Math.sqrt(37 / 162), 12);
  });
  it('retains an earlier weak lobe when the later lobe dominates power', () => {
    const result = spread([1, 2, 3, 1e9, 1e9 + 1, 1e9 + 2], [1e-9, 1e-9, 0, 0, 1, 1], [1, 1e9 + 2]);
    expect(result.inputNoiseSpreadHz).toBeCloseTo(1.1083298519020788, 8);
  });
  it('integrates independently derived linear PSD moments on clipped irregular bands', () => {
    // p(f)=2f+3. Integrate p, f*p and f²*p exactly.
    const f = [2, 7, 19, 40];
    const bands: [number, number][] = [[4, 31], [6, 12], [11, 29]];
    const s = new NoiseResult(f, 'out', 'V1', [1, 1, 1, 1], f.map(x => Math.sqrt(2 * x + 3)), undefined, undefined);
    const options = { bandHz: bands[0], bandsHz: bands.slice(1), includeOutputNoiseSpread: true, includeInputNoiseCentroid: true, includeOutputNoiseCentroid: true, inputNoiseBandwidthAtHz: 8, outputNoiseBandwidthAtHz: 8 };
    const before = noiseMetrics(s, options);
    const result = noiseMetrics(s, { ...options, includeInputNoiseSpread: true });
    const actual = [result.inputNoiseSpreadHz!, ...result.bandResults!.map(x => x.inputNoiseSpreadHz!)];
    const expected = bands.map(([a, b]) => {
      const m0 = (b * b + 3 * b) - (a * a + 3 * a);
      const m1 = (2 * b ** 3 / 3 + 3 * b ** 2 / 2) - (2 * a ** 3 / 3 + 3 * a ** 2 / 2);
      const m2 = (b ** 4 / 2 + b ** 3) - (a ** 4 / 2 + a ** 3);
      return Math.sqrt(m2 / m0 - (m1 / m0) ** 2);
    });
    const errors = actual.map((value, i) => Math.abs(value - expected[i]));
    console.log('linear PSD spread expected Hz', expected, 'actual Hz', actual, 'absolute errors Hz', errors);
    errors.forEach(error => expect(error).toBeLessThan(1e-12));
    expect(result.inputNoiseSpreadHz).not.toBeCloseTo(result.outputNoiseSpreadHz!, 3);
    const { inputNoiseSpreadHz: _spread, bandResults: _bands, ...remaining } = result;
    const { bandResults: _oldBands, ...oldRemaining } = before;
    expect(remaining).toEqual(oldRemaining);
    result.bandResults!.forEach((row, i) => {
      const { inputNoiseSpreadHz: _value, ...other } = row;
      expect(other).toEqual(before.bandResults![i]);
    });
  });
  it('preserves structured validation errors', () => {
    for (const args of [
      { netlist: '', includeInputNoiseSpread: 'true' },
      { netlist: '', bandHz: [4, 2], includeInputNoiseSpread: true },
      { netlist: '', bandsHz: [[1, 0]], includeInputNoiseSpread: true },
    ]) {
      try { noiseMetricsArgs(args); throw new Error('expected validation error'); }
      catch (error) { expect(error).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', retryable: false }); }
    }
    try { spread([2, 7, 19, 40], [1, 1, 1, 1], [1, 20]); throw new Error('expected range error'); }
    catch (error) { expect(error).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', retryable: false }); }
  });
  it('reports zero power explicitly', () => {
    const r = spread([1, 2, 4], [0, 0, 0], [1, 4], [[1, 2]]);
    expect(r).toMatchObject({ inputNoiseSpreadHz: null, inputNoiseSpreadReason: 'zero integrated input noise', bandResults: [{ inputNoiseSpreadHz: null, inputNoiseSpreadReason: 'zero integrated input noise' }] });
  });
  it('advertises and exercises the MCP schema and real resistor noise', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(); const client = new Client({ name: 'spread-test', version: '1.0.0' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_noise_metrics')!;
      const validate = new AjvJsonSchemaValidator();
      const args = { request, bandHz: [20, 800], bandsHz: [[30, 300]], includeInputNoiseSpread: true };
      expect(tool.inputSchema.properties).toHaveProperty('includeInputNoiseSpread');
      const output = (tool.outputSchema!.oneOf as { properties: { bandResults: { items: { properties: object } } } }[])[0].properties;
      expect(output).toHaveProperty('inputNoiseSpreadHz');
      expect(output.bandResults.items.properties).toHaveProperty('inputNoiseSpreadHz');
      expect(validate.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await client.callTool({ name: tool.name, arguments: args });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(validate.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      const r = response.structuredContent as { inputNoiseSpreadHz: number; bandResults: { inputNoiseSpreadHz: number }[] };
      expect(r.inputNoiseSpreadHz).toBeCloseTo(780 / Math.sqrt(12), 8);
      expect(r.bandResults[0].inputNoiseSpreadHz).toBeCloseTo(270 / Math.sqrt(12), 8);
      for (const value of ['true', 1, null, []]) {
        expect(validate.getValidator(tool.inputSchema)({ ...args, includeInputNoiseSpread: value }).valid).toBe(false);
        const invalid = await client.callTool({ name: tool.name, arguments: { ...args, includeInputNoiseSpread: value } });
        expect(invalid.isError).toBe(true);
      }
      for (const selector of [{}, { includeInputNoiseSpread: false }]) {
        const plain = await client.callTool({ name: tool.name, arguments: { request, bandsHz: [[30, 300]], ...selector } });
        expect(plain.structuredContent).not.toHaveProperty('inputNoiseSpreadHz');
        expect((plain.structuredContent as { bandResults: object[] }).bandResults[0]).not.toHaveProperty('inputNoiseSpreadHz');
      }
    } finally { await client.close(); await server.close(); }
  });
});
