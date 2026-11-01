import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { PoleZeroResult } from '@spice-ts/core';
import { pzMetrics } from './pz-metrics.js';
import { executeTool, MCP_TOOLS, type ExecutionWorker } from './server.js';

const result = (poles: { real: number; imaginary: number }[], zeros: { real: number; imaginary: number }[] = []) =>
  new PoleZeroResult('in', '0', 'out', '0', poles, zeros);
const pair = (real: number, imaginary: number) => [{ real, imaginary }, { real, imaginary: -imaginary }];
const request = { apiVersion: '1', input: { format: 'spice', source: 'R1 in 0 1k\nC1 in 0 1u\n.pz in 0 in 0 cur pz\n.end' } };
const outputValid = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_pz_metrics')!.outputSchema!);

describe('finite pole-zero metrics', () => {
  it('preserves a representable scaled frequency for an unpaired overflowing norm', () => {
    const m = pzMetrics(result([{ real: -1.3e308, imaginary: 1.3e308 }]));
    expect(m.poles[0].frequencyHz).toBe(Math.hypot(-1.3e308 / (2 * Math.PI), 1.3e308 / (2 * Math.PI)));
    expect(Number.isFinite(m.poles[0].frequencyHz)).toBe(true);
  });
  it.each([
    ['pole', result(pair(-1.3e308, 1.3e308)), 'naturalFrequencyRadPerSec'],
    ['zero', result([], pair(-1.3e308, 1.3e308)), 'naturalFrequencyRadPerSec'],
    ['pole', result([{ real: NaN, imaginary: 1 }]), 'real'],
    ['zero', result([], [{ real: 0, imaginary: Infinity }]), 'imaginary'],
    ['pole', result(pair(-1e-308, 1e308)), 'q'],
    ['pole', result(pair(0, Number.MIN_VALUE)), 'naturalFrequencyHz'],
  ])('rejects invalid %s metric %s', (kind, roots, metric) => {
    expect(() => pzMetrics(roots)).toThrowError(expect.objectContaining({ code: 'INVALID_DATA', phase: 'analysis', retryable: false, details: expect.objectContaining({ kind, index: 0, metric }) }));
  });
  it('propagates the structured error through the public tool', async () => {
    class Worker extends EventEmitter {
      postMessage(): void { queueMicrotask(() => this.emit('message', { type: 'result', result: result(pair(-1.3e308, 1.3e308)) })); }
      terminate(): number { return 0; }
    }
    const response = await executeTool('spice_pz_metrics', { request }, { workerFactory: () => new Worker() as unknown as ExecutionWorker });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_DATA', phase: 'analysis', retryable: false, details: { kind: 'pole', index: 0, metric: 'naturalFrequencyRadPerSec' } } } });
    expect(outputValid(response.structuredContent).valid).toBe(true);
    expect(JSON.parse(response.content[0].type === 'text' ? response.content[0].text : '')).toEqual(response.structuredContent);
  });
});
