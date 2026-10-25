import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createToolExecutor, DEFAULT_MCP_LIMITS, executeTool, MCP_TOOLS } from './server.js';

const source = '* Original MIT RC corner fixture\n.param rval=1k\nV1 in 0 DC 0 AC 1\nR1 in out {rval}\nC1 out 0 1u\n.ac dec 200 1 100k\n.end';
const request = { apiVersion: '1', input: { format: 'spice', source } };
const measurement = { kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -10 * Math.log10(2), edge: 'falling' };
const corners = [{ name: 'slow', params: { rval: 1200 } }, { name: 'fast', params: { rval: 800 } }, { name: 'hot', temp: 125 }];

// Original MIT divider, represented identically in all three protocol formats.
const components = [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'dc', dc: 1 } },
  { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
  { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 3000 } },
];
const analyses = [{ type: 'op' }];
const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in', 'out'] }, analyses, models: [], subcircuits: [] };
const circuit = [
  ...['in', 'out', '0'].map(name => ({ type: 'source_net', source_net_id: name, name })),
  ...components.flatMap((component, i) => [
    { type: 'source_component', source_component_id: component.id, name: component.name,
      ...[{ ftype: 'simple_voltage_source', voltage: 1 }, { ftype: 'simple_resistor', resistance: 1000 }, { ftype: 'simple_resistor', resistance: 3000 }][i] },
    ...component.ports.flatMap((port, j) => [
      { type: 'source_port', source_port_id: `${component.id}-${j}`, source_component_id: component.id, name: port.name },
      { type: 'source_trace', source_trace_id: `${component.id}-${j}`, connected_source_port_ids: [`${component.id}-${j}`], connected_source_net_ids: [port.net] },
    ]),
  ]),
];
const protocolInputs = [
  { format: 'spice', source: '* Original MIT divider\nV1 in 0 1\nR1 in out 1k\nR2 out 0 3k\n.op\n.end' },
  { format: 'spice-ts', document },
  { format: 'circuit-json', circuit, analyses },
];
const dividerArgs = { corners: [{ name: 'nominal' }, { name: 'repeat' }], measurement: { kind: 'max', signal: 'v(out)', analysis: 0 } };

describe('spice_corners protocol-v1', () => {
  it('advertises accepted formats and SPICE-only overrides', async () => {
    expect(await executeTool('spice_capabilities', {})).toMatchObject({ structuredContent: { corners: {
      tool: 'spice_corners', inputFormats: ['spice', 'spice-ts', 'circuit-json'], overridesInputFormats: ['spice'],
    } } });
  });

  it.each(protocolInputs)('returns identical divider results for $format without mutation', async input => {
    const args = { ...dividerArgs, request: { apiVersion: '1', input, options: { reltol: 1e-8 } } };
    const before = JSON.stringify(args);
    const tool = MCP_TOOLS.find(tool => tool.name === 'spice_corners')!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid).toBe(true);
    const baseline = await executeTool('spice_corners', { ...args, request: { ...args.request, input: protocolInputs[0] } });
    expect(baseline.isError).not.toBe(true);
    const response = await executeTool('spice_corners', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(baseline.structuredContent);
    expect(response).toMatchObject({ structuredContent: { corners: [{ value: 0.75 }, { value: 0.75 }], summary: { spread: 0 } } });
    expect(JSON.stringify(args)).toBe(before);
  });

  it.each(protocolInputs.slice(1))('isolates unsupported overrides for $format', async input => {
    const response = await executeTool('spice_corners', {
      ...dividerArgs, request: { apiVersion: '1', input },
      corners: [{ name: 'params', params: {} }, { name: 'temp', temp: 125 }, { name: 'nominal' }],
    });
    expect(response).toMatchObject({ structuredContent: { corners: [
      { name: 'params', status: 'failed', error: { code: 'INVALID_REQUEST' } },
      { name: 'temp', status: 'failed', error: { code: 'INVALID_REQUEST' } },
      { name: 'nominal', status: 'complete', value: 0.75 },
    ] } });
  });

  it.each([
    { format: 'spice-ts', document: '{broken' },
    { format: 'spice-ts', document: {} },
    { format: 'circuit-json', circuit: {}, analyses },
  ])('returns a stable structured error for malformed $format input', async input => {
    await expect(executeTool('spice_corners', { ...dividerArgs, request: { apiVersion: '1', input } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
});

describe('spice_corners', () => {
  it('returns RC cutoffs within 1e-3 relative error and named extrema without mutation', async () => {
    const before = JSON.stringify({ request, corners });
    const response = await executeTool('spice_corners', { request, corners, measurement });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const data = response.structuredContent as { corners: { name: string; status: string; value: number; unit: string }[]; summary: { min: { name: string; value: number }; max: { name: string; value: number }; spread: number; unit: string } };
    expect(data.corners.map(c => c.name)).toEqual(['slow', 'fast', 'hot']);
    for (const [i, resistance] of [1200, 800, 1000].entries()) {
      expect(data.corners[i]).toMatchObject({ status: 'complete', unit: 'Hz' });
      expect(Math.abs(data.corners[i].value * (2 * Math.PI * resistance * 1e-6) - 1)).toBeLessThan(1e-3);
    }
    expect(data.summary).toMatchObject({ min: { name: 'slow' }, max: { name: 'fast' }, unit: 'Hz' });
    expect(data.summary.spread).toBe(data.summary.max.value - data.summary.min.value);
    expect(JSON.stringify({ request, corners })).toBe(before);
  });

  it('isolates parameter, parse and measurement failures and handles all-failed results', async () => {
    const response = await executeTool('spice_corners', { request, measurement, corners: [corners[0], { name: 'bad', params: { missing: 1 } }, corners[1]] });
    expect(response).toMatchObject({ structuredContent: { corners: [{ status: 'complete' }, { name: 'bad', status: 'failed', error: { code: 'UNKNOWN_PARAMETER', phase: 'validation' } }, { status: 'complete' }], summary: { min: { name: 'slow' }, max: { name: 'fast' } } } });
    const conditional = source.replace('R1 in out {rval}', '.if rval < 0\n.invalid_corner\n.else\nR1 in out {rval}\n.endif');
    expect(await executeTool('spice_corners', { request: { ...request, input: { format: 'spice', source: conditional } }, measurement, corners: [{ name: 'bad', params: { rval: -1 } }, corners[0]] })).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: expect.any(String) } }, { status: 'complete' }] } });
    expect(await executeTool('spice_corners', { request, corners: [corners[0]], measurement: { ...measurement, signal: 'v(missing)' } })).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: 'UNKNOWN_SIGNAL' } }], summary: null } });
  });

  it('rejects excessive and malformed corners before solving', async () => {
    expect(await executeTool('spice_corners', { request, measurement, corners: Array.from({ length: 65 }, (_, i) => ({ name: String(i) })) })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxCorners', maximum: 64, actual: 65 } } } });
    for (const invalid of [[], [{ name: '' }], [{ name: 'a' }, { name: 'a' }], [{ name: 'a', temp: NaN }], [{ name: 'a', temp: -274 }], [{ name: 'a', unexpected: 1 }]]) {
      expect(await executeTool('spice_corners', { request, measurement, corners: invalid })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
  });

  it('applies temperature overrides to the actual circuit', async () => {
    const thermal = '* Thermal resistor\nV1 out 0 1\nR1 out 0 rm 1k\n.model rm R(TC1=0.01 TNOM=27)\n.temp 0\n.op\n.end';
    const result = await executeTool('spice_corners', { request: { ...request, input: { format: 'spice', source: thermal } }, corners: [{ name: 'nominal', temp: 27 }, { name: 'hot', temp: 127 }], measurement: { kind: 'at', signal: 'i(V1)', analysis: 0, at: 0 } });
    expect(result).toMatchObject({ structuredContent: { corners: [{ value: expect.closeTo(-0.001, 8) }, { value: expect.closeTo(-0.0005, 8) }] } });
  });

  it('reuses DC and transient measurements and resolves ties to the first named corner', async () => {
    for (const analysis of ['.dc V1 0 1 0.5', '.tran 1u 2u']) {
      const deck = '* Divider\n.param rval=1k\nV1 in 0 1\nR1 in out {rval}\nR2 out 0 1k\n' + analysis + '\n.end';
      expect(await executeTool('spice_corners', { request: { ...request, input: { format: 'spice', source: deck } }, corners: [{ name: 'first', params: { rval: 1000 }, temp: 125 }, { name: 'second' }], measurement: { kind: 'max', signal: 'v(out)', analysis: 0 } })).toMatchObject({ structuredContent: { corners: [{ value: expect.closeTo(0.5, 8) }, { value: expect.closeTo(0.5, 8) }], summary: { min: { name: 'first' }, max: { name: 'first' }, spread: 0, unit: 'V' } } });
    }
  });

  it('isolates malformed parameter values and accepts the exact 64-corner boundary', async () => {
    expect(await executeTool('spice_corners', { request, measurement, corners: [{ name: 'bad', params: { rval: Infinity } }, corners[0]] })).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: 'INVALID_REQUEST' } }, { status: 'complete' }] } });
    const execute = createToolExecutor({ streamLimits: { maxConcurrentJobs: 0 } });
    const response = await execute('spice_corners', { request, measurement, corners: Array.from({ length: 64 }, (_, i) => ({ name: String(i) })) });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent?.corners).toHaveLength(64);
  });

  it('shares wall time, response bytes, cancellation and concurrency quotas', async () => {
    const args = { request, corners, measurement };
    expect(await executeTool('spice_corners', args, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
    expect(await executeTool('spice_corners', args, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    const execute = createToolExecutor({ streamLimits: { maxConcurrentJobs: 0 } });
    expect(await execute('spice_corners', args)).toMatchObject({ structuredContent: { corners: corners.map(() => ({ status: 'failed', error: { code: 'RESOURCE_LIMIT' } })), summary: null } });
    expect(await executeTool('spice_corners', args, { limits: { ...DEFAULT_MCP_LIMITS, maxWallTimeMs: 20 }, simulate: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { status: 'complete', analyses: [] }; } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxWallTimeMs' } } } });
  });
});
