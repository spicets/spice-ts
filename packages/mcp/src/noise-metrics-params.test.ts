import { expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

// Original authored resistor-noise fixture.
const source = 'V1 in 0 AC 1\n.param R=1k\nR1 in out {R}\nC1 out 0 1n\n.temp 27\n.noise V(out) V1 dec 20 1 1e6\n.end';
const selectors = { bandHz: [10, 100000], spotFrequenciesHz: [10, 1000] };
const request = (text: string) => ({ apiVersion: '1', input: { format: 'spice', source: text } });
type Metrics = { integratedOutputNoiseVrms: number; integratedInputNoiseRms: number; spots: { outputNoiseVPerSqrtHz: number; inputNoisePerSqrtHz: number }[] };
async function metrics(args: object): Promise<Metrics> {
  const response = await executeTool('spice_noise_metrics', { ...args, ...selectors });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  return response.structuredContent as unknown as Metrics;
}

it('advertises params and applies overrides to the public text-netlist path', async () => {
  expect(MCP_TOOLS.find(tool => tool.name === 'spice_noise_metrics')?.inputSchema.properties).toHaveProperty('params');
  const original = await metrics({ netlist: source });
  const changed = await metrics({ netlist: source, params: { r: 4000 } });
  const rewritten = await metrics({ netlist: source.replace('R=1k', 'R=4k') });
  for (const key of ['integratedOutputNoiseVrms', 'integratedInputNoiseRms'] as const) {
    expect(rewritten[key]).toBeGreaterThan(0);
    expect(Math.abs(changed[key] / rewritten[key] - 1)).toBeLessThan(1e-12);
    expect(changed[key]).not.toBe(original[key]);
  }
  for (let i = 0; i < rewritten.spots.length; i++) {
    for (const key of ['outputNoiseVPerSqrtHz', 'inputNoisePerSqrtHz'] as const) {
      expect(rewritten.spots[i][key]).toBeGreaterThan(0);
      expect(Math.abs(changed.spots[i][key] / rewritten.spots[i][key] - 1)).toBeLessThan(1e-12);
      expect(changed.spots[i][key]).not.toBe(original.spots[i][key]);
    }
  }
});

it('accepts the protocol-v1 request without mutating it or changing absent params behavior', async () => {
  const input = { ...request(source), options: { limits: { maxResultPoints: 1000 } } };
  const snapshot = structuredClone(input);
  const args = { request: input, params: { R: 4000 }, ...selectors };
  const schema = MCP_TOOLS.find(tool => tool.name === 'spice_noise_metrics')!.inputSchema;
  expect(new AjvJsonSchemaValidator().getValidator(schema)(args).valid).toBe(true);
  expect(await metrics(args)).toEqual(await metrics({ netlist: source.replace('R=1k', 'R=4k') }));
  expect(input).toEqual(snapshot);
  expect(await metrics({ request: input })).toEqual(await metrics({ netlist: source }));
  expect(await metrics({ request: input, params: {} })).toEqual(await metrics({ request: input }));
});

it('preserves structured parameter errors', async () => {
  const unknown = await executeTool('spice_noise_metrics', { request: request(source), params: { missing: 1 } });
  expect(unknown).toMatchObject({ isError: true, structuredContent: { error: {
    code: 'UNKNOWN_PARAMETER', phase: 'validation', details: { unknown: ['missing'], available: ['r'] },
  } } });
  for (const params of [null, [], 3, { R: NaN }, { R: Infinity }, { R: '4k' }, { R: 4, r: 5 }]) {
    expect(await executeTool('spice_noise_metrics', { netlist: source, params })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } },
    });
  }
  expect(await executeTool('spice_noise_metrics', { request: { apiVersion: '1', input: { format: 'spice-ts', document: {} } }, params: { R: 4 } }))
    .toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
});

it('enforces request limits with overrides', async () => {
  const input = { ...request(source), options: { limits: { maxResultPoints: 1 } } };
  const snapshot = structuredClone(input);
  expect(await executeTool('spice_noise_metrics', { request: input, params: { R: 4000 } }))
    .toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  expect(input).toEqual(snapshot);
  const tiny = { ...request(source), options: { limits: { maxSourceBytes: 20 } } };
  expect(await executeTool('spice_noise_metrics', { request: tiny, params: { R: 4000 } }))
    .toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
});
