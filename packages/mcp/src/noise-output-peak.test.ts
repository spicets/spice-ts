import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NoiseResult, simulateNoiseProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.noise V(out) V1 dec 20 10 1000\n.end';
const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
const validator = new AjvJsonSchemaValidator();
const spectrum = (frequencies: number[], densities: number[]) => new NoiseResult(frequencies, 'out', 'V1', densities, densities.map(() => 1), undefined, undefined);

describe('output noise sampled peak', () => {
  it('accepts the option through the public schema and executes one simulation', async () => {
    const args = { netlist, includeOutputNoisePeak: true };
    let calls = 0;
    let direct: NoiseResult | undefined;
    class Worker extends EventEmitter {
      postMessage(message: { operation: string; request: Parameters<typeof simulateNoiseProtocolV1>[0] }): void {
        calls++;
        void simulateNoiseProtocolV1(message.request).then(result => {
          direct = result;
          this.emit('message', { type: 'result', result });
        }, error => this.emit('error', error));
      }
      terminate(): number { return 0; }
    }
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_noise_metrics', args, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const samples = direct!.frequencies.map((frequencyHz, i) => ({ frequencyHz, outputNoiseVPerSqrtHz: direct!.outputNoiseDensity[i] }));
    const peak = samples.reduce((a, b) => b.outputNoiseVPerSqrtHz > a.outputNoiseVPerSqrtHz ? b : a);
    expect(response.structuredContent).toMatchObject({ outputNoisePeak: peak });
  });
  it.each([null, 'true', 1, [], {}, undefined])('rejects nonboolean option %s as INVALID_REQUEST', async value => {
    const args = { netlist, includeOutputNoisePeak: value };
    if (value !== undefined) expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(false);
    const response = await executeTool('spice_noise_metrics', args);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
  it('preserves all old output when omitted or false and limits the peak to the primary band', () => {
    const s = spectrum([10, 30, 110], [1, 3, 5]);
    const options = { bandHz: [10, 30] as [number, number], bandsHz: [[30, 110]] as [number, number][], spotFrequenciesHz: [20], outputNoiseBandwidthAtHz: 30 };
    const old = noiseMetrics(s, options);
    expect(old.integratedOutputNoiseVrms).toBeCloseTo(10, 12);
    expect(old.integratedInputNoiseRms).toBeCloseTo(Math.sqrt(20), 12);
    expect(old.outputEquivalentNoiseBandwidthHz).toBeCloseTo(100 / 9, 12);
    expect(noiseMetrics(s, { ...options, includeOutputNoisePeak: false })).toEqual(old);
    expect(old).not.toHaveProperty('outputNoisePeak');
    const { outputNoisePeak, ...rest } = noiseMetrics(s, { ...options, includeOutputNoisePeak: true });
    expect(rest).toEqual(old);
    expect(outputNoisePeak).toEqual({ frequencyHz: 30, outputNoiseVPerSqrtHz: 3 });
    expect(rest.bandResults![0]).not.toHaveProperty('outputNoisePeak');
  });
  it('computes both clipped endpoints using linear PSD, including a band without interior samples', () => {
    const s = spectrum([10, 30, 110], [1, 3, 5]);
    const peak = (bandHz: [number, number]) => noiseMetrics(s, { bandHz, includeOutputNoisePeak: true }).outputNoisePeak!;
    expect(peak([15, 20]).frequencyHz).toBe(20);
    expect(peak([15, 20]).outputNoiseVPerSqrtHz).toBeCloseTo(Math.sqrt(5), 14);
    const decreasing = spectrum([10, 30], [3, 1]);
    const result = noiseMetrics(decreasing, { bandHz: [15, 25], includeOutputNoisePeak: true }).outputNoisePeak!;
    expect(result.frequencyHz).toBe(15);
    expect(result.outputNoiseVPerSqrtHz).toBeCloseTo(Math.sqrt(7), 14);
  });
  it('retains subnormal clipped boundary peaks without premature rounding', () => {
    const m = Number.MIN_VALUE;
    const result = noiseMetrics(spectrum([10, 30], [m, 2 * m]), { bandHz: [15, 20], includeOutputNoisePeak: true }).outputNoisePeak;
    expect(result).toEqual({ frequencyHz: 20, outputNoiseVPerSqrtHz: 2 * m });
    const roundedTie = noiseMetrics(spectrum([10, 30], [m, 3 * m]), { bandHz: [15, 20], includeOutputNoisePeak: true }).outputNoisePeak;
    expect(roundedTie).toEqual({ frequencyHz: 20, outputNoiseVPerSqrtHz: 2 * m });
  });
  it('keeps representable peak densities at extreme scales', () => {
    for (const scale of [1e-200, 1e200]) {
      const peak = noiseMetrics(spectrum([10, 30], [scale, 3 * scale]), { bandHz: [15, 20], includeOutputNoisePeak: true }).outputNoisePeak!;
      expect(peak.frequencyHz).toBe(20);
      expect(peak.outputNoiseVPerSqrtHz / scale).toBeCloseTo(Math.sqrt(5), 14);
    }
  });
  it('rejects bands outside the sweep without extrapolation', () => {
    expect(() => noiseMetrics(spectrum([10, 30], [1, 2]), { bandHz: [9, 20], includeOutputNoisePeak: true })).toThrowError();
  });
  it('finds an interior peak and resolves flat ties to the earliest frequency', () => {
    expect(noiseMetrics(spectrum([10, 30, 110], [1, 3, 2]), noiseMetricsArgs({ netlist: 'test', includeOutputNoisePeak: true })).outputNoisePeak).toEqual({ frequencyHz: 30, outputNoiseVPerSqrtHz: 3 });
    expect(noiseMetrics(spectrum([10, 30, 110], [2, 2, 2]), noiseMetricsArgs({ netlist: 'test', bandHz: [20, 70], includeOutputNoisePeak: true })).outputNoisePeak).toEqual({ frequencyHz: 20, outputNoiseVPerSqrtHz: 2 });
  });
});
