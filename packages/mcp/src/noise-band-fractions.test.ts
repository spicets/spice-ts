import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NoiseResult, simulateNoiseProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { noiseMetrics, noiseMetricsArgs } from './noise-metrics.js';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';

const spectrum = (f: number[], out: number[]) => new NoiseResult(f, 'out', 'V1', out, out, undefined, undefined);
const options = { includeOutputNoiseBandFractions: true, bandsHz: [[10, 35], [35, 110], [10, 110]] as [number, number][] };

describe('output noise band power fractions', () => {
  it('reports analytic flat-PSD power shares at extreme uniform scales', () => {
    for (const scale of [1, 1e-200, 1e200]) {
      const rows = noiseMetrics(spectrum([10, 110], [scale, scale]), options).bandResults!;
      for (const [index, expected] of [0.25, 0.75, 1].entries()) expect(rows[index].outputNoisePowerFraction).toBeCloseTo(expected, 12);
    }
  });
  it('integrates off-grid pieces and overlapping bands of a non-flat PSD', () => {
    // PSD rises linearly from 1 to 9 at 60 Hz, then to 25 at 110 Hz.
    // Primitive: first segment x + .08*x², second 250 + 9*x + .16*x².
    const primitive = (f: number) => f <= 60 ? (f - 10) + 0.08 * (f - 10) ** 2 : 250 + 9 * (f - 60) + 0.16 * (f - 60) ** 2;
    const bands: [number, number][] = [[20, 75], [75, 100], [40, 90]];
    const rows = noiseMetrics(spectrum([10, 60, 110], [1, 3, 5]), { bandHz: [20, 100], bandsHz: bands, includeOutputNoiseBandFractions: true }).bandResults!;
    const total = primitive(100) - primitive(20);
    for (const [i, [a, b]] of bands.entries()) expect(rows[i].outputNoisePowerFraction).toBeCloseTo((primitive(b) - primitive(a)) / total, 12);
    expect(rows[0].outputNoisePowerFraction! + rows[1].outputNoisePowerFraction!).toBeCloseTo(1, 12);
    expect(rows[0].outputNoisePowerFraction! + rows[1].outputNoisePowerFraction! + rows[2].outputNoisePowerFraction!).toBeGreaterThan(1);
  });
  it('reports a null and reason for zero power', () => {
    for (const row of noiseMetrics(spectrum([10, 110], [0, 0]), options).bandResults!) expect(row).toMatchObject({ outputNoisePowerFraction: null, outputNoisePowerFractionReason: 'zero integrated output noise' });
  });
  it('validates selectors and retains legacy independent bands', () => {
    for (const bad of [true, 1, 'true', null]) {
      const request = bad === true ? { includeOutputNoiseBandFractions: bad } : { includeOutputNoiseBandFractions: bad, bandsHz: [[10, 20]] };
      expect(() => noiseMetricsArgs({ netlist: 'x', ...request })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
    for (const bandsHz of [[], [[0, 10]], [[10, 10]], [[10, Infinity]]]) expect(() => noiseMetricsArgs({ netlist: 'x', bandsHz, includeOutputNoiseBandFractions: true })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    const s = spectrum([10, 110], [1, 1]);
    for (const bandsHz of [[[10, 30]], [[90, 120]]] as [number, number][][]) expect(() => noiseMetrics(s, { bandHz: [20, 100], bandsHz, includeOutputNoiseBandFractions: true })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    const legacy = { bandHz: [20, 100] as [number, number], bandsHz: [[10, 30]] as [number, number][] };
    expect(noiseMetrics(s, { ...legacy, includeOutputNoiseBandFractions: false })).toEqual(noiseMetrics(s, legacy));
    expect(noiseMetrics(s, legacy).bandResults![0]).not.toHaveProperty('outputNoisePowerFraction');
  });
  it('discovers the option and runs the real MCP noise handler once per request', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
    const validate = new AjvJsonSchemaValidator();
    const netlist = 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.noise V(out) V1 dec 20 10 1000\n.end';
    const args = { netlist, bandHz: [10, 1000], bandsHz: [[10, 100], [100, 1000]] };
    let calls = 0;
    class Worker extends EventEmitter {
      postMessage(message: { request: Parameters<typeof simulateNoiseProtocolV1>[0] }): void {
        calls++;
        void simulateNoiseProtocolV1(message.request).then(result => this.emit('message', { type: 'result', result }), error => this.emit('error', error));
      }
      terminate(): number { return 0; }
    }
    const run = (a: object) => executeTool('spice_noise_metrics', a, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    const selected = { ...args, includeOutputNoiseBandFractions: true };
    expect(validate.getValidator(tool.inputSchema)(selected).valid).toBe(true);
    for (const invalid of [
      { ...args, includeOutputNoiseBandFractions: 'true' },
      { netlist, includeOutputNoiseBandFractions: true },
      { ...args, includeOutputNoiseBandFractions: true, bandsHz: [[9, 100]] },
      { ...args, includeOutputNoiseBandFractions: true, bandHz: [20, 1000] },
      { ...args, includeOutputNoiseBandFractions: true, bandHz: [100, 20] },
    ]) {
      const response = await run(invalid);
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    }
    calls = 0;
    const base = await run(args); const result = await run(selected);
    expect(calls).toBe(2);
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(validate.getValidator(tool.outputSchema!)(result.structuredContent).valid).toBe(true);
    const a = base.structuredContent as unknown as { integratedOutputNoiseVrms: number; bandResults: { integratedOutputNoiseVrms: number }[] };
    const b = result.structuredContent as unknown as { integratedOutputNoiseVrms: number; bandResults: { integratedOutputNoiseVrms: number; outputNoisePowerFraction: number }[] };
    expect(b.integratedOutputNoiseVrms).toBe(a.integratedOutputNoiseVrms);
    expect(b.bandResults.map(r => r.integratedOutputNoiseVrms)).toEqual(a.bandResults.map(r => r.integratedOutputNoiseVrms));
    expect(b.bandResults[0].outputNoisePowerFraction + b.bandResults[1].outputNoisePowerFraction).toBeCloseTo(1, 10);
  });
});
