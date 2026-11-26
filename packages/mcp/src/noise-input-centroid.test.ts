import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NoiseResult, simulateNoiseProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';

const frequencies = [2, 7, 19, 40];
const spectrum = (input: number[], source = 'V1') => new NoiseResult(frequencies, 'out', source, [1, 2, 3, 4], input, undefined, undefined);
const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n.noise V(out) V1 dec 20 1 1000\n.end';
const document = {
  format: 'spice-ts', schemaVersion: '1.0',
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'ac', magnitude: 1, dc: 0 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { capacitance: 1e-9 } },
  ] }, analyses: [], models: [], subcircuits: [], noiseAnalyses: [{ type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 20, startFreq: 1, stopFreq: 1000 }],
};
const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
const validator = new AjvJsonSchemaValidator();

describe('input-referred noise centroid', () => {
  it('finds the midpoint of a flat input PSD independently of output', () => {
    const result = noiseMetrics(spectrum([2, 2, 2, 2]), { includeInputNoiseCentroid: true, includeOutputNoiseCentroid: true, bandHz: [4, 31], bandsHz: [[6, 12]] });
    expect(result.inputNoiseCentroidHz).toBe(17.5);
    expect(result.bandResults![0].inputNoiseCentroidHz).toBe(9);
    expect(result.outputNoiseCentroidHz).not.toBe(result.inputNoiseCentroidHz);
  });
  it.each(['V1', 'I1'])('integrates a sloped PSD analytically for %s, including irregular and clipped nested bands', source => {
    // PSD = 2f+3; analytic integrals are f²+3f and 2f³/3+3f²/2.
    const primitive = (f: number) => f * f + 3 * f;
    const moment = (f: number) => 2 * f ** 3 / 3 + 3 * f * f / 2;
    const bands: [number, number][] = [[4, 31], [6, 12], [11, 29]];
    const result = noiseMetrics(spectrum(frequencies.map(f => Math.sqrt(2 * f + 3)), source), { includeInputNoiseCentroid: true, bandHz: bands[0], bandsHz: bands.slice(1) });
    expect(result.inputUnit).toBe(source === 'I1' ? 'A' : 'V');
    const values = [result.inputNoiseCentroidHz!, ...result.bandResults!.map(row => row.inputNoiseCentroidHz!)];
    const errors = bands.map(([a, b], i) => Math.abs(values[i] - (moment(b) - moment(a)) / (primitive(b) - primitive(a))));
    console.log('analytic centroid absolute errors Hz', source, errors);
    errors.forEach(error => expect(error).toBeLessThanOrEqual(1e-12));
  });
  it.each([1e-200, 1e200])('retains representable results for density scale %s', scale => {
    const result = noiseMetrics(spectrum([scale, scale, scale, scale]), { bandHz: [4, 31], includeInputNoiseCentroid: true });
    expect(result.inputNoiseCentroidHz).toBe(17.5);
  });
  it('distinguishes zero input noise from nonzero output noise and preserves default shapes', () => {
    const s = spectrum([0, 0, 0, 0]);
    const options = { bandsHz: [[6, 12]] as [number, number][] };
    const legacy = noiseMetrics(s, options);
    expect(noiseMetrics(s, { ...options, includeInputNoiseCentroid: false })).toEqual(legacy);
    expect(legacy).not.toHaveProperty('inputNoiseCentroidHz');
    expect(legacy.bandResults![0]).not.toHaveProperty('inputNoiseCentroidHz');
    const selected = noiseMetrics(s, { ...options, includeInputNoiseCentroid: true });
    expect(selected.integratedOutputNoiseVrms).toBeGreaterThan(0);
    expect(selected).toMatchObject({ inputNoiseCentroidHz: null, inputNoiseCentroidReason: 'zero integrated input noise', bandResults: [{ inputNoiseCentroidHz: null, inputNoiseCentroidReason: 'zero integrated input noise' }] });
  });
  it('reports nonrepresentable normalized power rather than a bogus centroid', () => {
    const s = new NoiseResult([1e-100, 2e-100, 3e-100, 1e308], 'out', 'V1', [0, 0, 0, 0], [0, 1, 0, 0], undefined, undefined);
    expect(noiseMetrics(s, { includeInputNoiseCentroid: true })).toMatchObject({ inputNoiseCentroidHz: null, inputNoiseCentroidReason: 'nonrepresentable centroid' });
  });
  it.each([null, 'true', 1, [], {}, undefined])('rejects nonboolean selector %s', async value => {
    const result = await executeTool('spice_noise_metrics', { netlist, includeInputNoiseCentroid: value });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
  it('rejects malformed, nonfinite and extrapolated inputs', () => {
    for (const bandHz of [[0, 20], [20, 10], [10, Infinity], [NaN, 20]]) expect(() => noiseMetricsArgs({ netlist, includeInputNoiseCentroid: true, bandHz })).toThrow();
    expect(() => noiseMetrics(spectrum([1, Infinity, 1, 1]), { includeInputNoiseCentroid: true })).toThrow();
    expect(() => noiseMetrics(spectrum([1, 1, 1, 1]), { bandHz: [1, 20], includeInputNoiseCentroid: true })).toThrow();
  });
  it.each([{ netlist }, { request: { apiVersion: '1', input: { format: 'spice-ts', document } } }])('serializes valid MCP content after one simulation: %s', async input => {
    let calls = 0;
    class Worker extends EventEmitter {
      postMessage(message: { operation: string; request: Parameters<typeof simulateNoiseProtocolV1>[0] }): void {
        expect(message.operation).toBe('noise'); calls++;
        void simulateNoiseProtocolV1(message.request).then(result => this.emit('message', { type: 'result', result }), error => this.emit('error', error));
      }
      terminate(): number { return 0; }
    }
    const args = { ...input, includeInputNoiseCentroid: true, bandsHz: [[10, 100]] };
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    const result = await executeTool('spice_noise_metrics', args, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    const serialized = JSON.parse(JSON.stringify(result.structuredContent));
    expect(validator.getValidator(tool.outputSchema!)(serialized).valid).toBe(true);
    expect(serialized.inputNoiseCentroidHz).toBeGreaterThan(0);
    expect(serialized.bandResults[0].inputNoiseCentroidHz).toBeGreaterThan(0);
  });
});
