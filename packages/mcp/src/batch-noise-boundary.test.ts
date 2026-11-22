import { describe, expect, it } from 'vitest';
import { createToolExecutor, DEFAULT_MCP_LIMITS } from './server.js';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.op' } };
const noise: SimulationResultV1 = { status: 'complete', analyses: [{
  type: 'noise', analysisIndex: 0, frequencyHz: [1, 10], outputNoiseDensity: [1, 1], inputNoiseDensity: [1, 1],
  outputNoiseDensityUnit: 'V/sqrt(Hz)', inputNoiseDensityUnit: 'V/sqrt(Hz)', integratedOutputNoiseUnit: 'V', integratedInputNoiseUnit: 'V',
}] };

describe('batch noise at MCP boundary', () => {
  it('counts noise frequency points in result limits', async () => {
    const execute = createToolExecutor({ limits: { ...DEFAULT_MCP_LIMITS, maxResultPoints: 1 }, simulate: async () => noise });
    expect(await execute('spice_simulate', { request })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } } } });
  });
  it('rejects a noise result from a streaming simulator without emitting events', async () => {
    const execute = createToolExecutor({ simulate: async () => noise });
    const start = await execute('spice_simulation_start', { request });
    const { jobId, cursor } = start.structuredContent as { jobId: string; cursor: string };
    await new Promise(resolve => setTimeout(resolve, 20));
    const read = await execute('spice_simulation_read', { jobId, cursor });
    expect(read.structuredContent).toMatchObject({ status: 'failed', events: [], terminal: { ok: false, error: { code: 'UNSUPPORTED_FEATURE' } } });
  });
});
