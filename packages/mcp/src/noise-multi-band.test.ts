import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NoiseResult, simulateNoiseProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';

const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
const validator = new AjvJsonSchemaValidator();
const inputValid = validator.getValidator(tool.inputSchema);
const outputValid = validator.getValidator(tool.outputSchema!);
const spectrum = (out: number[], input = out) => new NoiseResult([10, 110], 'out', 'I1', out, input, undefined, undefined);
const relative = (actual: number, expected: number) => expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-12);

describe('multi-band noise integration', () => {
  it('integrates independent constant-density bands', () => {
    const result = noiseMetrics(spectrum([2, 2], [3, 3]), { bandsHz: [[10, 110], [20, 45]] });
    expect(result.bandResults?.map(b => [b.bandHz, b.inputUnit])).toEqual([[[10, 110], 'A'], [[20, 45], 'A']]);
    for (const [index, out, input] of [[0, 20, 30], [1, 10, 15]]) {
      relative(result.bandResults![index].integratedOutputNoiseVrms, out);
      relative(result.bandResults![index].integratedInputNoiseRms, input);
    }
  });

  it('integrates clipped linear PSD, retaining order, overlap and duplicates independently of legacy selectors', () => {
    // Endpoint output PSDs are 1 and 9; hence PSD(f) = 1 + 0.08*(f-10).
    const s = spectrum([1, 3], [2, 6]);
    const bands: [number, number][] = [[40, 80], [20, 90], [40, 80]];
    const args = { bandHz: [10, 20] as [number, number], signalRms: 10, outputSignalRms: 10, outputNoisePercentiles: [50] };
    const legacy = noiseMetrics(s, args);
    const result = noiseMetrics(s, { ...args, bandsHz: bands });
    const { bandResults, ...unchanged } = result;
    expect(unchanged).toEqual(legacy);
    expect(bandResults?.map(b => b.bandHz)).toEqual(bands);
    for (const [index, [low, high]] of bands.entries()) {
      const power = (high - low) * (1 + 0.04 * (low + high - 20));
      relative(bandResults![index].integratedOutputNoiseVrms, Math.sqrt(power));
      relative(bandResults![index].integratedInputNoiseRms, 2 * Math.sqrt(power));
    }
    expect(noiseMetrics(s, {})).not.toHaveProperty('bandResults');
  });

  it('handles zero and representable extreme density scales', () => {
    expect(noiseMetrics(spectrum([0, 0]), { bandsHz: [[20, 45]] }).bandResults![0]).toMatchObject({ integratedOutputNoiseVrms: 0, integratedInputNoiseRms: 0 });
    for (const density of [1e-300, 1e300]) {
      const result = noiseMetrics(spectrum([density, density]), { bandsHz: [[20, 45]] });
      relative(result.bandResults![0].integratedOutputNoiseVrms, density * 5);
    }
    expect(() => noiseMetrics(spectrum([Number.MAX_VALUE, Number.MAX_VALUE]), { bandsHz: [[20, 45]] })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it.each([[], [[1]], [[1, 2, 3]], [[0, 2]], [[2, 2]], [[3, 2]], [[1, Infinity]], [[NaN, 2]], Array.from({ length: 17 }, () => [10, 20]), null])('rejects malformed bands %s', bandsHz => {
    expect(() => noiseMetricsArgs({ netlist: 'x', bandsHz })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('accepts the maximum and rejects bands outside the sweep', () => {
    const bandsHz = Array.from({ length: 16 }, () => [10, 110]);
    expect(noiseMetricsArgs({ netlist: 'x', bandsHz }).bandsHz).toEqual(bandsHz);
    for (const band of [[9, 20], [100, 111]] as [number, number][]) {
      expect(() => noiseMetrics(spectrum([1, 1]), { bandsHz: [band] })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
  });

  it('simulates a resistor once through the MCP tool and matches analytic thermal noise', async () => {
    const netlist = 'V1 in 0 AC 1\nR1 in out 1k\n.temp 27\n.noise V(out) V1 dec 20 10 1000\n.end';
    const args = { netlist, bandHz: [10, 1000], bandsHz: [[10, 110], [20, 45], [20, 45]] };
    expect(inputValid(args).valid).toBe(true);
    let calls = 0;
    class Worker extends EventEmitter {
      postMessage(message: { operation: string; request: Parameters<typeof simulateNoiseProtocolV1>[0] }): void {
        expect(message.operation).toBe('noise');
        calls++;
        void simulateNoiseProtocolV1(message.request).then(result => this.emit('message', { type: 'result', result }), error => this.emit('error', error));
      }
      terminate(): number { return 0; }
    }
    const response = await executeTool('spice_noise_metrics', args, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(outputValid(response.structuredContent).valid).toBe(true);
    const results = (response.structuredContent as unknown as { bandResults: { bandHz: number[]; inputUnit: string; integratedOutputNoiseVrms: number; integratedInputNoiseRms: number }[] }).bandResults;
    expect(results.map(r => r.bandHz)).toEqual(args.bandsHz);
    for (const r of results) {
      // Johnson-Nyquist one-sided PSD, independent of the simulator's integration.
      const expected = Math.sqrt(4 * 1.380649e-23 * 300.15 * 1000 * (r.bandHz[1] - r.bandHz[0]));
      expect(r.inputUnit).toBe('V');
      expect(Math.abs(r.integratedOutputNoiseVrms / expected - 1)).toBeLessThan(0.01);
      expect(Math.abs(r.integratedInputNoiseRms / expected - 1)).toBeLessThan(0.01);
    }
  });
});
