import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { DEFAULT_MCP_LIMITS, executeTool, MCP_TOOLS } from './server.js';
import { runCorners } from './corners.js';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';

const component = (type: string, name: string, p: string, n: string, params: Record<string, unknown>) =>
  ({ type, name, id: name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params });
const divider = [component('V', 'VSupply', 'in', '0', { dc: 10 }), component('R', 'R1', 'in', 'out', { resistance: 1000 }), component('R', 'R2', 'out', '0', { resistance: 1000 })];
const current = [component('I', 'Idrive', '0', 'out', { waveform: 'dc', dc: 0.001 }), component('R', 'R2', 'out', '0', { resistance: 1000 })];
const request = (components: typeof divider) => ({ apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', circuit: { nets: ['in', 'out'], components }, analyses: [{ type: 'op' }], models: [], subcircuits: [] } } });
const measurement = { kind: 'max', signal: 'v(out)', analysis: 0 };
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-10 * Math.max(1, Math.abs(expected)));

describe('native DC source corners', () => {
  it.each([
    { components: divider, source: 'vSuPpLy', values: [0, -4, 8, 8], expected: [0, -2, 4, 4] },
    { components: current, source: 'iDrIvE', values: [0, -0.002, 0.003, 0.003], expected: [0, -2, 3, 3] },
  ])('matches independently executed $source requests', async ({ components, source, values, expected }) => {
    const original = request(components);
    const args = { request: original, measurement, corners: values.map((value, i) => ({ name: `c${i}`, sources: { [source]: value } })) };
    const before = structuredClone(args);
    const validator = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_corners')!.inputSchema);
    expect(validator(args).valid).toBe(true);
    const result = await executeTool('spice_corners', args);
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const data = result.structuredContent as { corners: { status: string; value: number }[]; summary: { min: { value: number }; max: { value: number }; spread: number } };
    for (const [i, value] of values.entries()) {
      expect(data.corners[i].status).toBe('complete');
      const explicit = request(components.map((c, index) => index === 0 ? { ...c, params: { ...c.params, dc: value } } : c));
      const standalone = await executeTool('spice_measure', { request: explicit, measurements: [measurement] });
      const measured = (standalone.structuredContent!.measurements as { value: number }[])[0].value;
      close(data.corners[i].value, measured);
      close(data.corners[i].value, expected[i]);
    }
    close(data.summary.min.value, Math.min(...expected));
    close(data.summary.max.value, Math.max(...expected));
    close(data.summary.spread, Math.max(...expected) - Math.min(...expected));
    expect(args).toEqual(before);
    expect(await executeTool('spice_corners', args)).toEqual(result);
  });

  it('composes source, passive and temperature overrides without leaking to the next corner', async () => {
    const args = { request: request(divider), measurement, corners: [
      { name: 'mixed', sources: { vsupply: 12 }, components: { r2: 2000 }, temp: 80 },
      { name: 'nominal' },
    ] };
    const before = structuredClone(args);
    const result = await executeTool('spice_corners', args);
    const entries = (result.structuredContent!.corners as { status: string; value: number }[]);
    expect(entries.map(e => e.status)).toEqual(['complete', 'complete']);
    const explicit = request(divider.map((c, i) => i === 0 ? { ...c, params: { dc: 12 } } : i === 2 ? { ...c, params: { resistance: 2000 } } : c));
    const standalone = await executeTool('spice_measure', { request: { ...explicit, options: { temperature: 80 } }, measurements: [measurement] });
    close(entries[0].value, (standalone.structuredContent!.measurements as { value: number }[])[0].value);
    close(entries[0].value, 8);
    close(entries[1].value, 5);
    expect(args).toEqual(before);
    expect(await executeTool('spice_corners', args, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('isolates invalid maps and targets from valid corners', async () => {
    const bad = [{ missing: 1 }, { R1: 1 }, { vsupply: 1, VSUPPLY: 2 }, { vsupply: NaN }, { vsupply: Infinity }, { 'bad name': 1 }, null, []];
    const result = await executeTool('spice_corners', { request: request(divider), measurement, corners: [
      ...bad.map((sources, i) => ({ name: `bad${i}`, sources })), { name: 'good', sources: { vsupply: 6 } },
    ] });
    const entries = result.structuredContent!.corners as unknown[];
    for (let i = 0; i < bad.length; i++) expect(entries[i]).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } });
    expect(entries[bad.length]).toMatchObject({ status: 'complete', value: 3 });
  });

  it.each([
    { waveform: 'pulse', v1: 0, v2: 2, delay: 0, rise: 1e-6, fall: 1e-6, width: 1e-3, period: 2e-3 },
    { waveform: 'sin', offset: 0, amplitude: 2, frequency: 1000 },
    { waveform: 'ac', dc: 2, magnitude: 1 },
    { waveform: 'pwl', points: [{ time: 0, value: 0 }, { time: 1, value: 2 }] },
  ])('rejects a $waveform source without blocking an independent corner', async params => {
    const components = [...divider, component('V', 'Vwave', 'unused', '0', params)];
    const result = await executeTool('spice_corners', { request: request(components), measurement, corners: [
      { name: 'bad', sources: { Vwave: 1 } }, { name: 'good', sources: { vsupply: 4 } },
    ] });
    const entries = result.structuredContent!.corners as { status: string; error?: { code: string } }[];
    expect(entries[0]).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } });
    expect(entries[1]).toMatchObject({ status: 'complete', value: 2 });
  });

  it('rejects ambiguous names and non-native formats per corner', async () => {
    const duplicate = [...divider, component('V', 'vsupply', 'x', '0', { dc: 2 })];
    const ambiguous = await executeTool('spice_corners', { request: request(duplicate), measurement, corners: [{ name: 'bad', sources: { VSUPPLY: 1 } }] });
    expect(ambiguous).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: 'INVALID_REQUEST' } }] } });
    const text = { apiVersion: '1', input: { format: 'spice', source: '* divider\nVSupply in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op\n.end' } };
    const result = await executeTool('spice_corners', { request: text, measurement, corners: [{ name: 'bad', sources: { VSupply: 1 } }, { name: 'good' }] });
    expect(result).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: 'INVALID_REQUEST' } }, { status: 'complete', value: 5 }] } });
    const circuit = [
      ...['out', '0'].map(name => ({ type: 'source_net', source_net_id: name, name })),
      { type: 'source_component', source_component_id: 'r', name: 'R1', ftype: 'simple_resistor', resistance: 1000 },
      ...['out', '0'].flatMap((net, i) => [
        { type: 'source_port', source_port_id: `p${i}`, source_component_id: 'r', name: i ? 'n' : 'p' },
        { type: 'source_trace', source_trace_id: `t${i}`, connected_source_port_ids: [`p${i}`], connected_source_net_ids: [net] },
      ]),
    ];
    const converted = await executeTool('spice_corners', { request: { apiVersion: '1', input: { format: 'circuit-json', circuit, analyses: [{ type: 'op' }] } }, measurement, corners: [{ name: 'bad', sources: {} }, { name: 'good' }] });
    expect(converted).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: 'INVALID_REQUEST' } }, { status: 'complete', value: 0 }] } });
  });

  it('propagates the shared deadline during source override batches', async () => {
    const deadline = { code: 'RESOURCE_LIMIT', details: { limit: 'maxWallTimeMs' } };
    let checks = 0;
    let solved = false;
    await expect(runCorners({ measurement, corners: [{ name: 'limited', sources: { vsupply: 1 } }] }, request(divider) as SimulationRequestV1, 'spice-ts', async () => { solved = true; return { content: [] }; }, () => { if (++checks === 2) throw deadline; })).rejects.toBe(deadline);
    expect(solved).toBe(false);
  });
});
