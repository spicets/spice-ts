import { describe, expect, it } from 'vitest';
import { executeTool, DEFAULT_MCP_LIMITS, MCP_TOOLS } from './server.js';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

const netlist = 'R1 in out 1k\nR2 out 0 2k\nC1 out 0 1u';

describe('spice_convert', () => {
  it('advertises the conversion tool', async () => {
    expect(MCP_TOOLS.map(tool => tool.name)).toContain('spice_convert');
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_convert']) });
  });

  it('round-trips a passive RC low-pass with OP voltage error below 1e-12', async () => {
    // Convert the passive network, then attach identical external excitation.
    const exported = await executeTool('spice_convert', { netlist });
    expect(exported.isError).not.toBe(true);
    const { circuitJson, diagnostics } = exported.structuredContent as { circuitJson: unknown[]; diagnostics: unknown[] };
    expect(diagnostics).toEqual([]);
    expect(circuitJson).toEqual(expect.arrayContaining([expect.objectContaining({ ftype: 'simple_resistor', resistance: 1000 }), expect.objectContaining({ ftype: 'simple_capacitor', capacitance: 1e-6 })]));
    const imported = await executeTool('spice_convert', { circuitJson });
    expect(imported.isError).not.toBe(true);
    const restored = (imported.structuredContent as { netlist: string }).netlist;
    const solve = async (source: string) => {
      const result = await executeTool('spice_simulate', { request: { apiVersion: '1', input: { format: 'spice', source: `V1 in 0 1\n${source.replace(/^\.end\s*$/gim, '')}\n.op` } } });
      expect(result.isError).not.toBe(true);
      const analysis = (result.structuredContent as unknown as SimulationResultV1).analyses[0];
      if (analysis.type !== 'op') throw new Error('Expected OP');
      return analysis.voltagesV;
    };
    const before = await solve(netlist);
    const after = await solve(restored);
    expect(before.in).toBeCloseTo(1, 12);
    expect(before.out).toBeCloseTo(2 / 3, 12);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const node of Object.keys(before)) expect(Math.abs(before[node] - after[node])).toBeLessThan(1e-12);
  });

  it.each([
    { netlist: 'V1 in 0 5\nR1 in 0 1k' },
    { circuitJson: [{ type: 'source_component', source_component_id: 'V1', ftype: 'simple_voltage_source' }] },
  ])('returns unsupported-element diagnostics for %j', async args => {
    expect(await executeTool('spice_convert', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNSUPPORTED_ELEMENT', details: { diagnostics: [expect.objectContaining({ code: 'UNSUPPORTED_ELEMENT', severity: 'error' })] } } } });
  });

  it.each([{ netlist: '* ' + 'é'.repeat(128) }, { circuitJson: [{ type: 'pcb_component', extra: 'x'.repeat(256) }] }])('bounds input bytes for %j', async args => {
    expect(await executeTool('spice_convert', args, { limits: { ...DEFAULT_MCP_LIMITS, maxDocumentBytes: 128 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxDocumentBytes', maximum: 128 } } } });
  });

  it.each([{}, { netlist, circuitJson: [] }, { netlist: 1 }, { circuitJson: {} }, { netlist, extra: true }])('rejects malformed arguments %j', async args => {
    expect(await executeTool('spice_convert', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('bounds serialized conversion output', async () => {
    expect(await executeTool('spice_convert', { netlist }, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 1 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } } });
  });

  it('returns nonfatal layout diagnostics and rejects unsafe SPICE names', async () => {
    const exported = await executeTool('spice_convert', { netlist });
    const circuitJson = (exported.structuredContent as { circuitJson: Record<string, unknown>[] }).circuitJson;
    expect(await executeTool('spice_convert', { circuitJson: [...circuitJson, { type: 'pcb_component' }] })).toMatchObject({ structuredContent: { diagnostics: [expect.objectContaining({ code: 'LAYOUT_ONLY' })], lossy: false } });
    circuitJson[0].name = 'R1\n.include private';
    expect(await executeTool('spice_convert', { circuitJson })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_CIRCUIT' } } });
  });

  it.each([
    'R1 in out 1k m=2\nR2 out 0 1k',
    'R1 in 0 1k ac=2k',
    'R1 in 0 1k tc1=0.01',
    'C1 in 0 1u ic=2',
  ])('rejects SPICE parameters before IR conversion can discard them: %s', async source => {
    expect(await executeTool('spice_convert', { netlist: source })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_CIRCUIT', details: { diagnostics: [expect.objectContaining({
        code: 'UNSUPPORTED_PARAMETER', severity: 'error', simulationRelevant: true,
      })] } } },
    });
  });

  it('does not silently discard simulation-relevant parameters', async () => {
    const exported = await executeTool('spice_convert', { netlist });
    const circuitJson = (exported.structuredContent as { circuitJson: Record<string, unknown>[] }).circuitJson;
    circuitJson[0].unrecognizedParameter = 1;
    expect(await executeTool('spice_convert', { circuitJson })).toMatchObject({ isError: true, structuredContent: { error: { details: { diagnostics: [expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' })] } } } });
  });
});
