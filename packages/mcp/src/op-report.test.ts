import { describe, expect, it } from 'vitest';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

// Original MIT-licensed analytic probes; no external circuit fixtures.
const divider = 'V1 in 0 10\nR1 in out 1k\nR2 out 0 1k';
type Report = {
  nodeVoltages: Record<string, number>;
  devices: { name: string; terminalCurrents: Record<string, number>; powerW: number }[];
  sourceDeliveredPowerW: number; dissipatedPowerW: number;
  topDissipators: { name: string; powerW: number }[];
};
async function report(netlist: string, topN?: number): Promise<Report> {
  const response = await executeTool('spice_op_report', { netlist, ...(topN === undefined ? {} : { topN }) });
  expect(response.isError).not.toBe(true);
  expect(new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(tool => tool.name === 'spice_op_report')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as Report;
}

const components = [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'dc', dc: 10 } },
  { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
  { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
  { type: 'D', id: 'D1', name: 'D1', ports: [{ name: 'anode', net: 'out' }, { name: 'cathode', net: '0' }], params: { modelName: '' } },
];
const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in', 'out'] }, analyses: [], models: [], subcircuits: [] };
const circuit = [
  ...['in', 'out', '0'].map(name => ({ type: 'source_net', source_net_id: name, name })),
  ...components.flatMap((component, i) => [
    { type: 'source_component', source_component_id: component.id, name: component.name,
      ...[{ ftype: 'simple_voltage_source', voltage: 10 }, { ftype: 'simple_resistor', resistance: 1000 },
        { ftype: 'simple_resistor', resistance: 1000 }, { ftype: 'simple_diode' }][i] },
    ...component.ports.flatMap((port, j) => [
      { type: 'source_port', source_port_id: `${component.id}-${j}`, source_component_id: component.id, name: port.name },
      { type: 'source_trace', source_trace_id: `${component.id}-${j}`, connected_source_port_ids: [`${component.id}-${j}`], connected_source_net_ids: [port.net] },
    ]),
  ]),
];
const jsonInputs = [{ format: 'spice-ts', document }, { format: 'circuit-json', circuit, analyses: [] }];
const request = (input: unknown) => ({ apiVersion: '1', input });

describe('spice_op_report', () => {
  it.each([...jsonInputs, { format: 'spice', source: `${divider}\nD1 out 0 DEFAULT\n.model DEFAULT D` }])('matches every SPICE report field exactly for $format', async input => {
    const expected = await report(`${divider}\nD1 out 0 DEFAULT\n.model DEFAULT D`, 2);
    const response = await executeTool('spice_op_report', { request: request(input), topN: 2 });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(expected);
  });

  it('retains native JSON models and ignores unrelated analyses', async () => {
    const input = { format: 'spice-ts', document: { ...document,
      circuit: { ...document.circuit, components: components.map(c => c.type === 'D' ? { ...c, params: { modelName: 'custom' } } : c) },
      models: [{ name: 'custom', type: 'D', params: { IS: 1e-12 } }],
      analyses: [{ type: 'tran', timestep: 1e-6, stopTime: 1 }],
    } };
    const response = await executeTool('spice_op_report', { request: request(input) });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(await report(`${divider}\nD1 out 0 custom\n.model custom D(IS=1e-12)`));
  });
  it.each(jsonInputs)('honors request limits and cancellation for $format', async input => {
    expect(await executeTool('spice_op_report', { request: { ...request(input), options: { limits: { maxResultPoints: 1 } } } })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } },
    });
    expect(await executeTool('spice_op_report', { request: request(input) }, { signal: AbortSignal.abort() })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'CANCELLED' } },
    });
  });
  const invalidInputs = [
    {}, { netlist: divider, request: request(jsonInputs[0]) }, { request: request({ format: 'spice-ts', document: {} }) },
    { request: request({ format: 'spice-ts', document: '{invalid json' }) },
    { request: request({ format: 'circuit-json', circuit: {}, analyses: [] }) },
  ];
  it.each(invalidInputs)('rejects invalid or ambiguous input %#', async args => {
    expect(await executeTool('spice_op_report', args)).toMatchObject({ isError: true,
      structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } } });
  });
  it('returns structured conversion diagnostics', async () => {
    expect(await executeTool('spice_op_report', { request: request({ format: 'circuit-json', analyses: [],
      circuit: [{ type: 'source_component', source_component_id: 'U1', name: 'U1', ftype: 'simple_chip' }] }) })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'UNSUPPORTED_ELEMENT', phase: 'validation', retryable: false, details: { diagnostics: expect.any(Array) } } },
    });
  });
  it('advertises mutually exclusive legacy and protocol inputs', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(tool => tool.name === 'spice_op_report')!.inputSchema);
    for (const args of [{ netlist: divider }, ...jsonInputs.map(input => ({ request: request(input), topN: 0 }))]) expect(validate(args).valid, JSON.stringify(validate(args))).toBe(true);
    for (const args of invalidInputs) expect(validate(args).valid).toBe(false);
  });
  it('reports divider V²/R to 1e-12 relative with passive current signs', async () => {
    const result = await report(divider, 1);
    expect(result.nodeVoltages.out).toBe(5);
    for (const name of ['R1', 'R2']) {
      const device = result.devices.find(d => d.name.toUpperCase() === name)!;
      expect(Math.abs(device.powerW / (5 ** 2 / 1000) - 1)).toBeLessThan(1e-12);
    }
    expect(result.sourceDeliveredPowerW).toBeCloseTo(0.05, 14);
    expect(result.dissipatedPowerW).toBeCloseTo(0.05, 14);
    expect(result.topDissipators).toHaveLength(1);
  });

  it.each(['NPN', 'PNP'])('balances a %s BJT amplifier to 1e-9 relative', async polarity => {
    const sign = polarity === 'NPN' ? 1 : -1;
    const result = await report(`VCC vcc 0 ${sign * 12}\nVB b 0 ${sign * 0.7}\nRC vcc c 2k\nRE e 0 100\nQ1 c b e model\n.model model ${polarity}(IS=1e-15 BF=100)`);
    expect(Math.abs(result.sourceDeliveredPowerW / result.dissipatedPowerW - 1)).toBeLessThan(1e-9);
    const q = result.devices.find(d => d.name.toUpperCase() === 'Q1')!;
    expect(q.powerW).toBeGreaterThan(0);
    expect(Object.values(q.terminalCurrents).reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
  });

  it('is discoverable in capabilities', async () => {
    const response = await executeTool('spice_capabilities', {});
    expect(response.structuredContent?.tools).toContain('spice_op_report');
  });

  it('reads independent current sources, diode, capacitor and inductor DC loads', async () => {
    const result = await report('I1 0 in 1m\nR1 in out 1k\nD1 out 0 dm\n.model dm D(IS=1e-14)\nC1 out 0 1u\nL1 in next 1m\nR2 next 0 10k');
    // Exact nonlinear readouts can retain the default solver's KCL tolerance.
    expect(Math.abs(result.sourceDeliveredPowerW / result.dissipatedPowerW - 1)).toBeLessThan(1e-6);
    expect(result.devices.find(d => d.name === 'C1')!.powerW).toBe(0);
    expect(result.devices.find(d => d.name === 'L1')!.powerW).toBeCloseTo(0, 12);
    expect(result.devices.find(d => d.name === 'D1')!.powerW).toBeGreaterThan(0);
    expect(result.devices.find(d => d.name === 'I1')!.terminalCurrents['0']).toBe(0.001);
  });

  it('combines shorted terminals, uses only OP, and supports topN=0', async () => {
    const result = await report(`${divider}\nR3 out out 10\n.tran 1u 1\n.ac dec 10 1 1e6`, 0);
    expect(result.topDissipators).toEqual([]);
    expect(result.devices.find(d => d.name === 'R3')!.terminalCurrents).toEqual({ out: 0 });
  });

  it('rejects steps and bounds input/output, wall time and cancellation', async () => {
    expect((await executeTool('spice_op_report', { netlist: `${divider}\n.step param x 1 2 1` })).isError).toBe(true);
    for (const limits of [{ maxDocumentBytes: 5 }, { maxSerializedResultBytes: 5 }, { maxResultPoints: 1 }, { maxWallTimeMs: 1 }]) {
      expect(await executeTool('spice_op_report', { netlist: divider }, { limits: { ...DEFAULT_MCP_LIMITS, ...limits } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    }
    expect(await executeTool('spice_op_report', { netlist: divider }, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
  });

  it.each([{ topN: -1 }, { topN: 1.5 }, { topN: Infinity }, { unknown: true }])('rejects invalid arguments %j', async extra => {
    expect(await executeTool('spice_op_report', { netlist: divider, ...extra })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });

  it('preserves the structured non-convergence error and emits no partial report', async () => {
    const response = await executeTool('spice_op_report', { netlist: 'R1 a 0 1\nB1 a 0 I=V(a)^2+1' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } } });
    expect(response.structuredContent).not.toHaveProperty('devices');
  });

  it('returns a structured solve failure instead of an incomplete power balance', async () => {
    expect(await executeTool('spice_op_report', { netlist: 'V1 a 0 1\nV2 a 0 2\nR1 a 0 1k' })).toMatchObject({
      isError: true, structuredContent: { error: { code: expect.any(String), phase: expect.any(String) } },
    });
  });
});
