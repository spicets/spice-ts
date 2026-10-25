import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const divider = 'V1 in 0 1\nR1 in out 1k\nR2 out 0 3k\n.end\n';
const components = [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'dc', dc: 1 } },
  { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
  { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 3000 } },
];
const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in', 'out'] }, analyses: [], models: [], subcircuits: [] };
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
  { format: 'spice', source: divider },
  { format: 'spice-ts', document },
  { format: 'circuit-json', circuit, analyses: [] },
];
const request = (input: unknown) => ({ apiVersion: '1', input });
const dc = { output: 'v(out)', analysis: 'dc' };
const ac = { output: 'v(out)', analysis: 'ac', sweep: { type: 'lin', points: 3, fstart: 10, fstop: 100 } };
const tool = MCP_TOOLS.find(t => t.name === 'spice_sensitivity')!;
const validator = new AjvJsonSchemaValidator();
async function run(args: Record<string, unknown>) {
  const response = await executeTool('spice_sensitivity', args);
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent!;
}

describe('spice_sensitivity protocol-v1', () => {
  for (const selectors of [dc, ac]) {
    it.each(protocolInputs)(`matches legacy ranked entries and values for ${selectors.analysis} $format`, async (input: unknown) => {
      for (const extra of [{}, { top: 2 }]) {
        const legacy = await run({ netlist: divider, ...selectors, ...extra });
        const args = { request: request(input), ...selectors, ...extra };
        expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
        expect(await run(args)).toEqual(legacy);
      }
    });
  }

  // The converter only maps DC/sine/pulse sources, not AC magnitude; a sine's
  // transient amplitude is NOT an AC excitation. Exercise nonzero AC separately
  // for the two formats that can represent it, rather than invent converter fields.
  const acDivider = divider.replace('V1 in 0 1', 'V1 in 0 DC 1 AC 1');
  const acDocument = { ...document, circuit: { ...document.circuit,
    components: components.map(c => c.type === 'V'
      ? { ...c, params: { waveform: 'ac', dc: 1, magnitude: 1, phase: 0 } } : c) } };
  it.each([
    { format: 'spice', source: acDivider },
    { format: 'spice-ts', document: acDocument },
  ])('matches legacy nonzero AC excitation for $format', async (input: unknown) => {
    const legacy = await run({ netlist: acDivider, ...ac });
    expect(legacy).toMatchObject({ points: expect.arrayContaining([
      expect.objectContaining({ entries: expect.arrayContaining([
        expect.objectContaining({ device: 'V1', parameter: 'acMagnitude', value: 1,
          normalised: { real: expect.any(Number), imaginary: 0 } }),
      ]) }),
    ]) });
    // Assert a nonzero resistor derivative too: absent excitation yields zero.
    const points = legacy.points as { entries: { device: string; absolute: { real: number } }[] }[];
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) expect(point.entries.find(e => e.device === 'R1')!.absolute.real).not.toBe(0);
    const args = { request: request(input), ...ac };
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    expect(await run(args)).toEqual(legacy);
  });

  const malformed = [
    dc, { ...dc, netlist: divider, request: request(protocolInputs[0]) },
    { ...dc, request: request({ format: 'spice-ts', document: {} }) },
    { ...dc, request: request({ format: 'spice-ts', document: JSON.stringify(document) }) },
    { ...dc, request: JSON.stringify(request(protocolInputs[0])) },
    { ...dc, request: request({ ...protocolInputs[0], surprise: true }) },
    { ...dc, request: { ...request(protocolInputs[0]), surprise: true } },
    { ...dc, request: request(protocolInputs[0]), surprise: true },
    { ...dc, request: request(protocolInputs[0]), top: 0 },
    { ...dc, request: request(protocolInputs[0]), top: 1.5 },
    { ...dc, request: request(protocolInputs[0]), sweep: ac.sweep },
    { output: 'v(out)', analysis: 'ac', request: request(protocolInputs[0]) },
    { ...ac, request: request(protocolInputs[0]), sweep: { ...ac.sweep, points: 0 } },
    { analysis: 'dc', request: request(protocolInputs[0]) },
  ];
  it.each(malformed)('rejects malformed or ambiguous input %#', async (args: Record<string, unknown>) => {
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(false);
    expect(await executeTool('spice_sensitivity', args)).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } },
    });
  });

  it('advertises the legacy branch and requires exactly one netlist or request', () => {
    for (const selectors of [dc, ac]) {
      expect(validator.getValidator(tool.inputSchema)({ ...selectors, netlist: divider }).valid).toBe(true);
    }
  });

  it('replaces native deck analyses without executing them', async () => {
    const input = { format: 'spice-ts', document: { ...document,
      analyses: [{ type: 'tran', timestep: 1e-12, stopTime: 1000 }] } };
    expect(await run({ ...dc, request: request(input) })).toEqual(await run({ ...dc, netlist: divider }));
  });

  it('preserves circuit-json conversion diagnostics and structured validation failures', async () => {
    const response = await executeTool('spice_sensitivity', { ...dc, request: request({ format: 'circuit-json', analyses: [],
      circuit: [...circuit, { type: 'pcb_component', pcb_component_id: 'layout', source_component_id: 'R1' }] }) });
    expect(response.structuredContent).toEqual(await run({ ...dc, netlist: divider }));
    expect(response._meta).toMatchObject({ conversionDiagnostics: expect.arrayContaining([
      expect.objectContaining({ severity: 'info', code: 'LAYOUT_ONLY', simulationRelevant: false }),
    ]) });
    const invalidArgs = { request: request({ format: 'spice-ts', document: {} }), output: 'v(out)' };
    for (const result of [await executeTool('spice_sensitivity', invalidArgs),
      await executeTool('spice_tf', { ...invalidArgs, input_source: 'V1' })]) {
      expect(result).toMatchObject({ isError: true, structuredContent: { error: {
        code: 'INVALID_REQUEST', message: expect.any(String), phase: 'validation', retryable: false, details: expect.any(Object),
      } } });
    }
  });

  it.each(protocolInputs)('honors request bounds and cancellation for $format', async (input: unknown) => {
    for (const limits of [{ maxSourceBytes: 10 }, { maxComponents: 1 }, { maxAnalyses: 0 }, { maxResultPoints: 1 }, { maxSerializedResultBytes: 1 }]) {
      expect(await executeTool('spice_sensitivity', { ...dc, request: { ...request(input), options: { limits } } })).toMatchObject({
        isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } },
      });
    }
    expect(await executeTool('spice_sensitivity', { ...dc, request: request(input) }, { signal: AbortSignal.abort() })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'CANCELLED' } },
    });
  });
});
