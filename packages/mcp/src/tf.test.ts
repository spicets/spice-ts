import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTitleless, simulate } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';

// Original analytic divider (MIT), passed verbatim to ngspice-47 for the PR cross-check.
const divider = '* Transfer function divider\nV1 in 0 1\nR1 in out 1k\nR2 out 0 3k\n.tf v(out) V1\n.end\n';
const args = { netlist: divider, output: 'v(out)', input_source: 'V1' };
async function run(extra = {}) {
  const response = await executeTool('spice_tf', { ...args, ...extra });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  const tool = MCP_TOOLS.find(t => t.name === 'spice_tf')!;
  expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent!;
}

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
const selectors = { output: 'v(out)', input_source: 'V1' };

describe('spice_tf protocol-v1', () => {
  it.each(protocolInputs)('matches legacy and analytic divider quantities for $format', async input => {
    const legacy = await run();
    const response = await executeTool('spice_tf', { request: request(input), ...selectors });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(legacy);
    for (const [key, expected] of [['transfer_function', 0.75], ['input_resistance', 4000], ['output_resistance', 750]] as const) {
      expect(Math.abs((response.structuredContent![key] as number) / expected - 1)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('advertises exactly one netlist or request with required selectors', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_tf')!.inputSchema);
    for (const input of protocolInputs) expect(validate({ request: request(input), ...selectors }).valid).toBe(true);
    expect(validate(args).valid).toBe(true);
    for (const input of [{ ...args, request: request(protocolInputs[0]) }, selectors, { request: request(protocolInputs[0]) }]) {
      expect(validate(input).valid).toBe(false);
    }
  });

  it.each([
    {}, { netlist: divider, request: request(protocolInputs[0]) },
    { request: request({ format: 'spice-ts', document: JSON.stringify(document) }) },
    { request: request({ format: 'spice-ts', document: {} }) },
    ...protocolInputs.slice(1).flatMap(input => [{ request: request(input), params: {} }, { request: request(input), params: { r: 1 } }]),
    { request: request(protocolInputs[0]), surprise: true },
    { request: { ...request(protocolInputs[0]), unexpected: true } },
  ])('rejects malformed, ambiguous or non-SPICE parameter input %#', async extra => {
    expect(await executeTool('spice_tf', { ...selectors, ...extra })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } },
    });
  });

  it.each(protocolInputs)('honors request bounds and cancellation for $format', async input => {
    for (const limits of [{ maxSourceBytes: 10 }, { maxComponents: 1 }, { maxAnalyses: 0 }, { maxResultPoints: 2 }, { maxSerializedResultBytes: 1 }]) {
      expect(await executeTool('spice_tf', { ...selectors, request: { ...request(input), options: { limits } } })).toMatchObject({
        isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } },
      });
    }
    expect(await executeTool('spice_tf', { ...selectors, request: request(input) }, { signal: AbortSignal.abort() })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'CANCELLED' } },
    });
  });

  it('retains nonfatal layout conversion diagnostics outside the report', async () => {
    const response = await executeTool('spice_tf', { ...selectors, request: request({ format: 'circuit-json', analyses: [],
      circuit: [...circuit, { type: 'pcb_component', pcb_component_id: 'layout', source_component_id: 'R1' }] }) });
    expect(response.structuredContent).toEqual(await run());
    expect(response._meta).toMatchObject({ conversionDiagnostics: expect.arrayContaining([
      expect.objectContaining({ severity: 'info', code: 'LAYOUT_ONLY', simulationRelevant: false }),
    ]) });
  });

  it('preserves unsupported circuit-json diagnostic details', async () => {
    expect(await executeTool('spice_tf', { ...selectors, request: request({ format: 'circuit-json', analyses: [],
      circuit: [{ type: 'source_component', source_component_id: 'U1', name: 'U1', ftype: 'simple_chip' }] }) })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'UNSUPPORTED_ELEMENT', details: { diagnostics: expect.any(Array) } } },
    });
  });

  it('preserves native VCVS semantics without SPICE serialization', async () => {
    const source = 'V1 in 0 1\nE1 out 0 in 0 3\nR1 in 0 1k\nR2 out 0 2k';
    const ir = parseTitleless(source).toIR();
    const native = { ...document, circuit: { ...ir,
      components: ir.components.map(({ displayValue: _displayValue, ...component }) => component) } };
    const expected = await run({ netlist: source });
    for (const input of [{ format: 'spice', source }, { format: 'spice-ts', document: native }]) {
      const response = await executeTool('spice_tf', { ...selectors, request: request(input) });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(response.structuredContent).toEqual(expected);
    }
  });

  it('bounds original layout bytes before conversion', async () => {
    const input = { format: 'circuit-json', analyses: [], circuit: [...circuit,
      { type: 'pcb_component', pcb_component_id: 'layout', source_component_id: 'R1', notes: 'x'.repeat(8000) }] };
    expect(await executeTool('spice_tf', { ...selectors, request: { ...request(input), options: { limits: { maxSourceBytes: 4000 } } } }))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('rejects conflicting native analyses', async () => {
    expect(await executeTool('spice_tf', { ...selectors, request: request({ format: 'spice-ts', document: { ...document, analyses: [{ type: 'op' }] } }) }))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_CIRCUIT' } } });
  });

  it('applies protocol SPICE params before conversion', async () => {
    const source = divider.replace('R1 in out 1k', '.param rval=1k\nR1 in out {rval}');
    expect((await executeTool('spice_tf', { ...selectors, request: request({ format: 'spice', source }), params: { RVAL: 3000 } })).structuredContent)
      .toMatchObject({ transfer_function: 0.5, input_resistance: 6000, output_resistance: 1500 });
  });
});

describe('spice_tf', () => {
  it('returns divider gain and port resistances within 1e-9 relative', async () => {
    const result = await run();
    expect(result).toMatchObject({ output: 'v(out)', input_source: 'V1', units: {
      transfer_function: 'V/V', input_resistance: 'ohm', output_resistance: 'ohm',
    } });
    for (const [key, expected] of [['transfer_function', 0.75], ['input_resistance', 4000], ['output_resistance', 750]] as const) {
      expect(Math.abs((result[key] as number) / expected - 1)).toBeLessThan(1e-9);
    }
  });

  it.each([
    ['V1 in 0 1\nE1 out 0 in 0 3\nR1 in 0 1k\nR2 out 0 2k', 'v(out)', 'V1', 'V/V'],
    ['I1 0 in 1m\nR1 in 0 2k\nG1 0 out in 0 0.001\nR2 out 0 1k', 'v(out)', 'I1', 'V/A'],
    [readFileSync(new URL('../../../benchmarks/transfer-function/current-output.cir', import.meta.url), 'utf8'), 'i(Vsense)', 'V1', 'A/V'],
    ['I1 0 in 1m\nR1 in 0 2k\nG1 0 out in 0 0.001\nVx out 0 0', 'i(Vx)', 'I1', 'A/A'],
    [divider.replace('.tf v(out) V1', ''), 'V(out)', 'v1', 'V/V'],
  ])('matches core exactly for %s', async (netlist, output, input_source, unit) => {
    const deck = netlist.includes('.tf') ? netlist : netlist.replace(/\.end\b/i, '') + `\n.tf ${output} ${input_source}\n`;
    const core = (await simulate(parseTitleless(deck))).transferFunction!;
    const result = await run({ netlist, output, input_source });
    expect(result).toMatchObject({ output, input_source, transfer_function: core.transfer,
      input_resistance: core.inputResistance, output_resistance: core.outputResistance,
      units: { transfer_function: unit } });
  });

  it.each([
    [{ output: undefined }, 'INVALID_REQUEST'],
    [{ input_source: undefined }, 'INVALID_REQUEST'],
    [{ output: 'garbage' }, 'INVALID_REQUEST'],
    [{ netlist: 'V1 in 0 1\nR1 in out 1k invalid=1\nR2 out 0 3k\n.end' }, 'UNSUPPORTED_RESISTOR_PARAMETER'],
    [{ input_source: 'Vmissing' }, 'INVALID_CIRCUIT'],
    [{ output: 'v(missing)' }, 'INVALID_CIRCUIT'],
    [{ output: 'i(Vmissing)' }, 'INVALID_CIRCUIT'],
    [{ output: 'v(out)\n.tran 1 2' }, 'INVALID_REQUEST'],
    [{ input_source: 'V1\n.op' }, 'INVALID_REQUEST'],
    [{ output: 'i(R1)' }, 'INVALID_REQUEST'],
    [{ output: 'v(in,out)' }, 'INVALID_REQUEST'],
    [{ surprise: true }, 'INVALID_REQUEST'],
    [{ params: { missing: 1 } }, 'UNKNOWN_PARAMETER'],
    [{ netlist: 'V1 in 0 1\nR1 in 0 1k\nR2 a 0 1\nB1 a 0 I=V(a)^2+1', output: 'v(in)' }, 'CONVERGENCE_FAILED'],
    ...['.op', '.tran 1p 1000', '.tf v(in) V1', '.step R1 list 1k 2k', '.control\nop\n.endc', '.pz out 0 in 0 vol pol'].map(directive => [
      { netlist: divider.replace('.tf v(out) V1', directive) }, 'INVALID_CIRCUIT',
    ] as const),
  ] as [Record<string, unknown>, string][])('returns typed errors for %j', async (extra, code) => {
    const response = await executeTool('spice_tf', { ...args, ...extra });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code, message: expect.any(String), phase: expect.any(String) } } });
    expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual(response.structuredContent);
  });

  it('applies case-insensitive top-level parameter overrides before elaboration', async () => {
    const netlist = divider.replace('R1 in out 1k', '.param rval=1k\nR1 in out {rval}');
    expect(await run({ netlist, params: { RVAL: 3000 } })).toMatchObject({ transfer_function: 0.5, input_resistance: 6000, output_resistance: 1500 });
  });

  it('advertises TF and bounds work and cancellation', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tf: { tool: 'spice_tf', analyses: ['tf'] } });
    for (const limits of [{ maxDocumentBytes: 1 }, { maxResultPoints: 1 }, { maxSerializedResultBytes: 1 }, { maxAnalyses: 0 }]) {
      expect((await executeTool('spice_tf', args, { limits: { ...DEFAULT_MCP_LIMITS, ...limits } })).structuredContent)
        .toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    }
    const controller = new AbortController(); controller.abort();
    expect((await executeTool('spice_tf', args, { signal: controller.signal })).structuredContent).toMatchObject({ error: { code: 'CANCELLED' } });
  });
});
