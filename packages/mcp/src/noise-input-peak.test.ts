import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { NoiseResult, simulateNoiseProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const spectrum = (frequencies: number[], input: number[], output: number[] = input, source = 'V1') =>
  new NoiseResult(frequencies, 'out', source, output, input, undefined, undefined);

describe('input noise sampled peak', () => {
  it('finds the independent input peak in the primary band', () => {
    const args = noiseMetricsArgs({ netlist: 'test', includeInputNoisePeak: true, includeOutputNoisePeak: true, bandHz: [10, 100] });
    const result = noiseMetrics(spectrum([10, 30, 100], [1, 4, 2], [5, 2, 1]), args);
    expect(result).toMatchObject({ inputNoisePeak: { frequencyHz: 30, inputNoisePerSqrtHz: 4 }, outputNoisePeak: { frequencyHz: 10, outputNoiseVPerSqrtHz: 5 } });
  });
  it('interpolates PSD at clipped endpoints rather than amplitudes', () => {
    const rising = noiseMetrics(spectrum([10, 30], [1, 3]), { bandHz: [15, 20], includeInputNoisePeak: true }).inputNoisePeak!;
    expect(rising.frequencyHz).toBe(20);
    expect(rising.inputNoisePerSqrtHz).toBeCloseTo(Math.sqrt(5), 14);
    const falling = noiseMetrics(spectrum([10, 30], [3, 1]), { bandHz: [15, 25], includeInputNoisePeak: true }).inputNoisePeak!;
    expect(falling.frequencyHz).toBe(15);
    expect(falling.inputNoisePerSqrtHz).toBeCloseTo(Math.sqrt(7), 14);
  });
  it('resolves ties and zero at the earliest endpoint on nonuniform and logarithmic grids', () => {
    for (const values of [[2, 2, 2, 2], [0, 0, 0, 0], [1, 3, 3, 1]]) {
      const peak = noiseMetrics(spectrum([1, 10, 100, 1000], values), { bandHz: [2, 200], includeInputNoisePeak: true }).inputNoisePeak!;
      expect(peak.frequencyHz).toBe(values[0] === values[1] ? 2 : 10);
      expect(peak.inputNoisePerSqrtHz).toBe(values[1]);
    }
    expect(noiseMetrics(spectrum([1, 7, 100], [4, 1, 4]), { includeInputNoisePeak: true }).inputNoisePeak).toEqual({ frequencyHz: 1, inputNoisePerSqrtHz: 4 });
  });
  it('preserves finite tiny and large densities and subnormal ordering', () => {
    for (const scale of [1e-200, 1e200]) {
      const peak = noiseMetrics(spectrum([10, 30], [scale, 3 * scale]), { bandHz: [15, 20], includeInputNoisePeak: true }).inputNoisePeak!;
      expect(peak.frequencyHz).toBe(20);
      expect(peak.inputNoisePerSqrtHz / scale).toBeCloseTo(Math.sqrt(5), 14);
    }
    const m = Number.MIN_VALUE;
    expect(noiseMetrics(spectrum([10, 30], [m, 3 * m]), { bandHz: [15, 20], includeInputNoisePeak: true }).inputNoisePeak).toEqual({ frequencyHz: 20, inputNoisePerSqrtHz: 2 * m });
  });
  it('preserves legacy shape and confines the peak to the primary band', () => {
    const s = spectrum([10, 30, 100], [1, 2, 10], [8, 3, 1], 'I1');
    const options = { bandHz: [10, 30] as [number, number], bandsHz: [[30, 100]] as [number, number][] };
    const legacy = noiseMetrics(s, options);
    expect(noiseMetrics(s, { ...options, includeInputNoisePeak: false })).toEqual(legacy);
    const result = noiseMetrics(s, { ...options, includeInputNoisePeak: true });
    expect(result.inputUnit).toBe('A');
    expect(result.inputNoisePeak).toEqual({ frequencyHz: 30, inputNoisePerSqrtHz: 2 });
    expect(result.bandResults![0]).not.toHaveProperty('inputNoisePeak');
    const { inputNoisePeak: _peak, ...rest } = result;
    expect(rest).toEqual(legacy);
    expect(noiseMetrics(s, { includeOutputNoisePeak: true })).not.toHaveProperty('inputNoisePeak');
    expect(noiseMetrics(s, { includeInputNoisePeak: true })).not.toHaveProperty('outputNoisePeak');
  });
  it.each([null, 'true', 1, [], {}, undefined])('rejects invalid flag %s', async value => {
    const response = await executeTool('spice_noise_metrics', { netlist: 'test', includeInputNoisePeak: value });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
  it('rejects invalid or extrapolated bands and nonfinite spectra with structured errors', () => {
    for (const bandHz of [[0, 20], [20, 10], [10, Infinity]]) {
      expect(() => noiseMetricsArgs({ netlist: 'test', includeInputNoisePeak: true, bandHz })).toThrowError();
    }
    for (const bandHz of [[9, 20], [10, 31]] as [number, number][]) {
      expect(() => noiseMetrics(spectrum([10, 30], [1, 2]), { bandHz, includeInputNoisePeak: true })).toThrowError();
    }
    expect(() => noiseMetrics(spectrum([10, 30], [1, Infinity]), { includeInputNoisePeak: true })).toThrowError();
    expect(() => noiseMetrics(spectrum([10, 30], [1e308, 1e308]), { includeInputNoisePeak: true })).toThrowError();
  });
  it('reports the independently recomputed clipped RC input peak after one MCP simulation', async () => {
    const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.noise V(out) V1 dec 20 10 1000\n.end';
    const args = { netlist, bandHz: [21, 213], includeInputNoisePeak: true, includeOutputNoisePeak: true };
    const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    let calls = 0;
    let direct: NoiseResult | undefined;
    class Worker extends EventEmitter {
      postMessage(message: { operation: string; request: Parameters<typeof simulateNoiseProtocolV1>[0] }): void {
        calls++;
        void simulateNoiseProtocolV1(message.request).then(result => { direct = result; this.emit('message', { type: 'result', result }); }, error => this.emit('error', error));
      }
      terminate(): number { return 0; }
    }
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_noise_metrics', args, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const f = direct!.frequencies, d = direct!.inputNoiseDensity;
    const at = (hz: number) => {
      const i = f.findIndex(x => x >= hz);
      if (f[i] === hz) return d[i];
      const t = (hz - f[i - 1]) / (f[i] - f[i - 1]);
      return Math.sqrt((1 - t) * d[i - 1] ** 2 + t * d[i] ** 2);
    };
    const frequencies = [args.bandHz[0], ...f.filter(x => x > args.bandHz[0] && x < args.bandHz[1]), args.bandHz[1]];
    const expected = frequencies.map(frequencyHz => ({ frequencyHz, inputNoisePerSqrtHz: at(frequencyHz) })).reduce((a, b) => b.inputNoisePerSqrtHz > a.inputNoisePerSqrtHz ? b : a);
    const result = response.structuredContent as unknown as { inputUnit: string; inputNoisePeak: typeof expected };
    expect(result.inputUnit).toBe('V');
    expect(result.inputNoisePeak.frequencyHz).toBe(expected.frequencyHz);
    expect(result.inputNoisePeak.inputNoisePerSqrtHz / expected.inputNoisePerSqrtHz).toBeCloseTo(1, 14);
  });
});
