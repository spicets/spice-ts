import { describe, expect, it } from 'vitest';
import { NoiseResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { noiseMetrics, noiseMetricsArgs, noiseMetricsOutputSchema } from './noise-metrics.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n.noise V(out) V1 dec 10 1 1e4\n.end';
const noiseAnalysis = { type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 10, startFreq: 1, stopFreq: 1e4 };
const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { nets: ['in', 'out'], components: [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'ac', magnitude: 1, dc: 0 } },
  { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
  { type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { capacitance: 1e-9 } },
] }, analyses: [], models: [], subcircuits: [], noiseAnalyses: [noiseAnalysis] };
const validator = new AjvJsonSchemaValidator();
const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;

describe('output-referred noise SNR', () => {
  it('uses the integrated output noise over the clipped band', () => {
    const args = noiseMetricsArgs({ netlist: 'test', bandHz: [2, 4], outputSignalRms: 30 });
    const spectrum = new NoiseResult([1, 5], 'out', 'I1', [3, 3], [2, 2], undefined, undefined);
    const result = noiseMetrics(spectrum, args);
    const expected = 20 * (Math.log10(30) - Math.log10(3 * Math.sqrt(2)));
    expect(result.integratedOutputNoiseVrms).toBeCloseTo(3 * Math.sqrt(2), 12);
    expect(result).toMatchObject({ outputSignalToNoiseRatioDb: expect.closeTo(expected, 12) });
  });
  it('keeps input and output SNR independent for current and voltage sources', () => {
    for (const [source, unit] of [['I1', 'A'], ['V1', 'V']]) {
      const spectrum = new NoiseResult([1, 5], 'out', source, [3, 3], [2, 2], undefined, undefined);
      const args = { bandHz: [2, 4] as [number, number], signalRms: 10, outputSignalRms: 30 };
      const result = noiseMetrics(spectrum, args);
      expect(result.inputUnit).toBe(unit);
      const inputSnr = 20 * (Math.log10(10) - Math.log10(2 * Math.sqrt(2)));
      expect(result).toMatchObject({
        signalToNoiseRatioDb: expect.closeTo(inputSnr, 12),
        outputSignalToNoiseRatioDb: expect.closeTo(20 * (Math.log10(30) - Math.log10(3 * Math.sqrt(2))), 12),
      });
      expect(noiseMetrics(spectrum, { ...args, outputSignalRms: undefined })).toMatchObject({ signalToNoiseRatioDb: expect.closeTo(inputSnr, 12) });
    }
  });
  it('omits output fields when not requested', () => {
    const spectrum = new NoiseResult([1, 2], 'out', 'V1', [1, 1], [1, 1], undefined, undefined);
    const result = noiseMetrics(spectrum, { signalRms: 1 });
    expect(result).not.toHaveProperty('outputSignalToNoiseRatioDb');
    expect(result).not.toHaveProperty('outputSignalToNoiseRatioReason');
  });
  it('returns a documented null for zero output noise', () => {
    const spectrum = new NoiseResult([1, 2], 'out', 'V1', [0, 0], [1, 1], undefined, undefined);
    const result = noiseMetrics(spectrum, { outputSignalRms: 1 });
    expect(result).toMatchObject({ outputSignalToNoiseRatioDb: null, outputSignalToNoiseRatioReason: 'zero integrated output noise' });
    expect(validator.getValidator(noiseMetricsOutputSchema)(result).valid).toBe(true);
  });
  it.each([Number.MAX_VALUE, Number.MIN_VALUE])('avoids ratio overflow for signal %s', outputSignalRms => {
    const density = outputSignalRms === Number.MAX_VALUE ? 0.5 : 2;
    const spectrum = new NoiseResult([1, 2], 'out', 'V1', [density, density], [1, 1], undefined, undefined);
    expect(noiseMetrics(spectrum, { outputSignalRms })).toMatchObject({ outputSignalToNoiseRatioDb: expect.closeTo(20 * (Math.log10(outputSignalRms) - Math.log10(density)), 12) });
  });
  it.each([0, -1, NaN, Infinity, -Infinity, '1', null, undefined])('rejects invalid outputSignalRms %s', async outputSignalRms => {
    const args = { netlist, outputSignalRms };
    expect(await executeTool('spice_noise_metrics', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    if (outputSignalRms !== undefined) expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(false);
  });
  it('accepts text and native JSON through the handler and validates both schemas', async () => {
    let previous: unknown;
    for (const input of [{ netlist }, { request: { apiVersion: '1', input: { format: 'spice-ts', document } } }]) {
      const args = { ...input, bandHz: [15, 1234], signalRms: 0.001, outputSignalRms: 0.002 };
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await executeTool('spice_noise_metrics', args);
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      const result = response.structuredContent as unknown as { integratedOutputNoiseVrms: number; outputSignalToNoiseRatioDb: number };
      expect(result.outputSignalToNoiseRatioDb).toBeCloseTo(20 * (Math.log10(0.002) - Math.log10(result.integratedOutputNoiseVrms)), 12);
      if (previous) expect(result).toEqual(previous);
      previous = result;
    }
  });
});
