import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { simulateNoiseProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';

const netlist = 'V1 in 0 AC 1\nR1 in out 1k\n.noise V(out) V1 dec 20 10 1000\n.end';
const tool = MCP_TOOLS.find(t => t.name === 'spice_noise_metrics')!;
const validator = new AjvJsonSchemaValidator();

describe('noise bandwidth MCP integration', () => {
  it('runs one real simulation and validates input and output schemas', async () => {
    const args = { netlist, bandHz: [20, 70], bandsHz: [[10, 110], [20, 70]], outputNoiseBandwidthAtHz: 100 };
    let calls = 0;
    class Worker extends EventEmitter {
      postMessage(message: { operation: string; request: Parameters<typeof simulateNoiseProtocolV1>[0] }): void {
        expect(message.operation).toBe('noise');
        calls++;
        void simulateNoiseProtocolV1(message.request).then(result => this.emit('message', { type: 'result', result }), error => this.emit('error', error));
      }
      terminate(): number { return 0; }
    }
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_noise_metrics', args, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(calls).toBe(1);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const result = response.structuredContent as unknown as { outputEquivalentNoiseBandwidthHz: number; bandResults: { outputEquivalentNoiseBandwidthHz: number }[] };
    expect(result.outputEquivalentNoiseBandwidthHz).toBeCloseTo(50, 8);
    expect(result.bandResults[0].outputEquivalentNoiseBandwidthHz).toBeCloseTo(100, 8);
    expect(result.bandResults[1].outputEquivalentNoiseBandwidthHz).toBeCloseTo(50, 8);
    expect(validator.getValidator(tool.outputSchema!)({ ...response.structuredContent, unexpected: true }).valid).toBe(false);
  });
  it.each([0, -1, NaN, Infinity, -Infinity, null, '10', undefined, 9, 1001])('rejects invalid or outside reference %s with structured error', async value => {
    const response = await executeTool('spice_noise_metrics', { netlist, outputNoiseBandwidthAtHz: value });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
});
