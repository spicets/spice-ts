import { describe, expect, it } from 'vitest';
import type { JsonValue, SimulationReadDataV1, SimulationRequestV1, SimulationResultV1 } from '@spice-ts/core/protocol';
import { createToolExecutor, DEFAULT_MCP_LIMITS, executeTool } from './server.js';

// The converter supports passive R/C elements, not independent voltage sources.
// This unpowered divider has a zero operating point in both representations.
const circuit: JsonValue[] = [
  { type: 'source_component', source_component_id: 'R1', name: 'R1', ftype: 'simple_resistor', resistance: 1000 },
  { type: 'source_component', source_component_id: 'R2', name: 'R2', ftype: 'simple_resistor', resistance: 2000 },
  { type: 'source_component', source_component_id: 'C1', name: 'C1', ftype: 'simple_capacitor', capacitance: 1e-6 },
  ...['in', 'out', '0'].map(name => ({ type: 'source_net', source_net_id: name, name })),
  ...[['R1', 'p', 'in'], ['R1', 'n', 'out'], ['R2', 'p', 'out'], ['R2', 'n', '0'], ['C1', 'p', 'out'], ['C1', 'n', '0']].flatMap(([owner, name, net], index): JsonValue[] => [
    { type: 'source_port', source_port_id: `p${index}`, source_component_id: owner, name },
    { type: 'source_trace', source_trace_id: `t${index}`, connected_source_port_ids: [`p${index}`], connected_source_net_ids: [net] },
  ]),
];
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'circuit-json', circuit, analyses: [{ type: 'op' }] } };

async function stream(input: SimulationRequestV1): Promise<SimulationResultV1> {
  const execute = createToolExecutor();
  const started = await execute('spice_simulation_start', { request: input });
  expect(started.isError).not.toBe(true);
  const { jobId, cursor: first } = started.structuredContent as { jobId: string; cursor: string };
  let cursor = first;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const read = await execute('spice_simulation_read', { jobId, cursor });
    const data = read.structuredContent as unknown as SimulationReadDataV1;
    if (data.status === 'complete') return data.terminal.data;
    if (data.status !== 'running') throw new Error(`Stream ended with ${JSON.stringify(data.terminal)}`);
    cursor = data.nextCursor;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Stream did not complete');
}

describe('MCP circuit-json input (#1155)', () => {
  it('advertises circuit-json and validates the converted RC divider', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ inputFormats: ['spice', 'spice-ts', 'circuit-json'] });
    expect(await executeTool('spice_validate', { request })).toMatchObject({ structuredContent: { status: 'valid', nodeCount: 2, analysisCount: 1 } });
  });

  it('matches SPICE op node voltages in one-shot and isolated stream workers', async () => {
    const spice: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: 'R1 in out 1k\nR2 out 0 2k\nC1 out 0 1u\n.op' } };
    const expected = await executeTool('spice_simulate', { request: spice });
    expect(expected.isError).not.toBe(true);
    const actual = await executeTool('spice_simulate', { request });
    expect(actual.isError).not.toBe(true);
    expect(actual.structuredContent).toEqual(expected.structuredContent);
    expect(await stream(request)).toEqual(expected.structuredContent);
    const result = actual.structuredContent as unknown as SimulationResultV1;
    expect(result.analyses[0]).toMatchObject({ type: 'op', voltagesV: { in: 0, out: 0 } });
    expect(await executeTool('spice_measure', { request, measurements: [{ kind: 'max', signal: 'v(out)', analysis: 0 }] })).toMatchObject({ structuredContent: { measurements: [{ value: 0, unit: 'V' }] } });
  });

  it.each(['spice_validate', 'spice_simulate', 'spice_simulation_start'])('%s preserves unsupported-element diagnostics', async tool => {
    const unsupported = { ...request, input: { ...request.input, circuit: [{ type: 'source_component', ftype: 'simple_voltage_source', source_component_id: 'V1' }] } };
    const result = await executeTool(tool, { request: unsupported });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNSUPPORTED_ELEMENT', details: { diagnostics: [{ code: 'UNSUPPORTED_ELEMENT', path: '/0', elementId: 'V1' }] } } } });
  });

  it.each(['spice_validate', 'spice_simulate', 'spice_simulation_start'])('%s exposes nonfatal layout diagnostics', async tool => {
    const result = await executeTool(tool, { request: { ...request, input: { ...request.input, circuit: [...circuit, { type: 'pcb_component', pcb_component_id: 'pcb1' }] } } });
    expect(result.isError).not.toBe(true);
    expect(result._meta).toMatchObject({ conversionDiagnostics: [{ code: 'LAYOUT_ONLY', severity: 'info' }] });
    if (tool === 'spice_simulation_start') {
      await executeTool('spice_simulation_cancel', { jobId: (result.structuredContent as { jobId: string }).jobId });
    }
  });

  it.each(['spice_validate', 'spice_simulate', 'spice_simulation_start'])('%s rejects malformed circuit-json', async tool => {
    expect(await executeTool(tool, { request: { apiVersion: '1', input: { format: 'circuit-json', circuit: {}, analyses: [] } } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('preserves unsupported-parameter diagnostics without solving', async () => {
    const invalid = structuredClone(request);
    if (invalid.input.format !== 'circuit-json') throw new Error('Expected circuit-json');
    invalid.input.circuit[0] = { type: 'source_component', source_component_id: 'R1', ftype: 'simple_resistor', resistance: -1 };
    expect(await executeTool('spice_simulate', { request: invalid })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_CIRCUIT', details: { diagnostics: [{ code: 'UNSUPPORTED_PARAMETER' }] } } },
    });
  });

  it('bounds original layout bytes and analysis counts before worker execution', async () => {
    const padded = { ...request, input: { ...request.input, circuit: [...circuit, { type: 'pcb_component', extra: 'x'.repeat(4096) }] } };
    expect(await executeTool('spice_validate', { request: padded }, { limits: { ...DEFAULT_MCP_LIMITS, maxDocumentBytes: 3000 } })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxDocumentBytes' } } },
    });
    expect(await executeTool('spice_simulation_start', { request }, { limits: { ...DEFAULT_MCP_LIMITS, maxAnalyses: 0 } })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxAnalyses' } } },
    });
  });
});
