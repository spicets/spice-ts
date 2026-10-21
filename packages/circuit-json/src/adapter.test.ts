import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CircuitJson } from 'circuit-json';
import type { CircuitIR } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const component = (
  id: string,
  ftype: string,
  fields: Record<string, unknown>,
): Record<string, unknown> => ({
  type: 'source_component',
  ftype,
  source_component_id: id,
  name: id,
  ...fields,
});

function losslessFixture(): CircuitJson {
  const elements: Record<string, unknown>[] = [
    component('R1', 'simple_resistor', { resistance: 1000, display_value: '1k' }),
    component('C1', 'simple_capacitor', { capacitance: 1e-6, display_value: '1uF' }),
    component('M1', 'simple_mosfet', { channel_type: 'n', mosfet_mode: 'enhancement' }),
    component('Q1', 'simple_transistor', { transistor_type: 'npn' }),
  ];
  const ports = [
    ['R1', 'p', 'in'], ['R1', 'n', 'out'],
    ['C1', 'p', 'out'], ['C1', 'n', '0'],
    ['M1', 'drain', 'out'], ['M1', 'gate', 'in'], ['M1', 'source', '0'],
    ['Q1', 'collector', 'out'], ['Q1', 'base', 'in'], ['Q1', 'emitter', '0'],
  ];
  elements.push(
    { type: 'source_net', source_net_id: 'net_in', name: 'in', member_source_group_ids: [] },
    { type: 'source_net', source_net_id: 'net_out', name: 'out', member_source_group_ids: [] },
    { type: 'source_net', source_net_id: 'net_ground', name: 'GND', is_ground: true, member_source_group_ids: [] },
  );
  ports.forEach(([owner, name, net], index) => {
    const portId = `port_${index}`;
    elements.push({
      type: 'source_port',
      source_port_id: portId,
      source_component_id: owner,
      name,
    });
    elements.push({
      type: 'source_trace',
      source_trace_id: `trace_${index}`,
      connected_source_port_ids: [portId],
      connected_source_net_ids: [`net_${net === '0' ? 'ground' : net}`],
    });
  });
  return elements as CircuitJson;
}

const expectedIR: CircuitIR = {
  components: [
    {
      type: 'R', id: 'R1', name: 'R1', displayValue: '1k',
      ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }],
      params: { resistance: 1000 },
    },
    {
      type: 'C', id: 'C1', name: 'C1', displayValue: '1uF',
      ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }],
      params: { capacitance: 1e-6 },
    },
    {
      type: 'M', id: 'M1', name: 'M1',
      ports: [{ name: 'drain', net: 'out' }, { name: 'gate', net: 'in' }, { name: 'source', net: '0' }],
      params: { channelType: 'n' },
    },
    {
      type: 'Q', id: 'Q1', name: 'Q1',
      ports: [{ name: 'collector', net: 'out' }, { name: 'base', net: 'in' }, { name: 'emitter', net: '0' }],
      params: { type: 'npn' },
    },
  ],
  nets: ['in', 'out'],
};

describe('circuit-json adapter', () => {
  it('round-trips R/C/M/Q IDs, connectivity, and typed parameters losslessly', () => {
    const imported = fromCircuitJSON(losslessFixture());
    expect(imported).toEqual({ value: expectedIR, diagnostics: [], lossy: false });

    const exported = toCircuitJSON(expectedIR);
    expect(exported.lossy).toBe(false);
    expect(exported.diagnostics).toEqual([]);
    expect(exported.value).toBeDefined();
    expect(fromCircuitJSON(exported.value!)).toEqual({
      value: expectedIR,
      diagnostics: [],
      lossy: false,
    });
  });

  it('keeps layout-only elements nonfatal and emits stable ordered info diagnostics', () => {
    const fixture = [
      { type: 'schematic_text', schematic_text_id: 'text-z', text: 'note', x: 0, y: 0 },
      ...losslessFixture(),
      { type: 'pcb_component', pcb_component_id: 'pcb-a', source_component_id: 'R1', center: { x: 0, y: 0 }, width: 1, height: 1, rotation: 0, layer: 'top' },
    ] as CircuitJson;

    const result = fromCircuitJSON(fixture);
    expect(result.value).toEqual(expectedIR);
    expect(result.lossy).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        severity: 'info', code: 'LAYOUT_ONLY', message: 'Ignored layout-only circuit-json element schematic_text',
        path: '/0', elementId: 'text-z', simulationRelevant: false,
      },
      {
        severity: 'info', code: 'LAYOUT_ONLY', message: 'Ignored layout-only circuit-json element pcb_component',
        path: `/${fixture.length - 1}`, elementId: 'pcb-a', simulationRelevant: false,
      },
    ]);
  });

  it('rejects unsupported simulation elements and parameters with exact paths', () => {
    const unsupportedElement = fromCircuitJSON([
      component('X1', 'simple_chip', {}),
    ] as CircuitJson);
    expect(unsupportedElement).toEqual({
      diagnostics: [{
        severity: 'error', code: 'UNSUPPORTED_ELEMENT',
        message: 'Unsupported simulation-relevant circuit-json element source_component/simple_chip',
        path: '/0', elementId: 'X1', simulationRelevant: true,
      }],
      lossy: true,
    });

    const unsupportedParameter = fromCircuitJSON([
      component('R1', 'simple_resistor', { resistance: 1000, temperature_coefficient: 0.001 }),
    ] as CircuitJson);
    expect(unsupportedParameter).toEqual({
      diagnostics: [{
        severity: 'error', code: 'UNSUPPORTED_PARAMETER',
        message: 'Unsupported simulation-relevant parameter temperature_coefficient on R1',
        path: '/0/temperature_coefficient', elementId: 'R1', simulationRelevant: true,
      }],
      lossy: true,
    });

    const unsupportedMosfetMode = fromCircuitJSON([
      component('M1', 'simple_mosfet', { channel_type: 'n', mosfet_mode: 'depletion' }),
    ] as CircuitJson);
    expect(unsupportedMosfetMode).toEqual({
      diagnostics: [{
        severity: 'error', code: 'UNSUPPORTED_PARAMETER',
        message: 'Unsupported simulation-relevant parameter mosfet_mode on M1',
        path: '/0/mosfet_mode', elementId: 'M1', simulationRelevant: true,
      }],
      lossy: true,
    });
  });

  it('sorts diagnostics by path, code, then elementId and diagnoses every ignored element', () => {
    const result = fromCircuitJSON([
      { type: 'pcb_text', pcb_text_id: 'layout-b', text: 'B', anchor_position: { x: 0, y: 0 }, anchor_alignment: 'center', font_size: 1, layer: 'top', rotation: 0 },
      component('X1', 'simple_chip', {}),
      { type: 'cad_component', cad_component_id: 'layout-a', source_component_id: 'X1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ] as CircuitJson);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map(({ path, code, elementId }) => ({ path, code, elementId }))).toEqual([
      { path: '/0', code: 'LAYOUT_ONLY', elementId: 'layout-b' },
      { path: '/1', code: 'UNSUPPORTED_ELEMENT', elementId: 'X1' },
      { path: '/2', code: 'LAYOUT_ONLY', elementId: 'layout-a' },
    ]);
  });

  it('rejects malformed values, unrepresentable port semantics, and malformed traces', () => {
    const malformedValue = fromCircuitJSON([
      component('R1', 'simple_resistor', { resistance: '1k' }),
    ] as CircuitJson);
    expect(malformedValue.value).toBeUndefined();
    expect(malformedValue.diagnostics.map(d => d.path)).toEqual(['/0/resistance']);

    const portFixture = losslessFixture() as unknown as Record<string, unknown>[];
    const portIndex = portFixture.findIndex(element => element.type === 'source_port');
    portFixture[portIndex].provides_voltage = 5;
    const portResult = fromCircuitJSON(portFixture as unknown as CircuitJson);
    expect(portResult.value).toBeUndefined();
    expect(portResult.diagnostics.map(d => d.path)).toEqual([`/${portIndex}/provides_voltage`]);

    const traceFixture = losslessFixture() as unknown as Record<string, unknown>[];
    const traceIndex = traceFixture.findIndex(element => element.type === 'source_trace');
    traceFixture[traceIndex].connected_source_port_ids = [
      ...(traceFixture[traceIndex].connected_source_port_ids as string[]),
      42,
    ];
    const traceResult = fromCircuitJSON(traceFixture as unknown as CircuitJson);
    expect(traceResult.value).toBeUndefined();
    expect(traceResult.diagnostics.some(d => d.path === `/${traceIndex}`)).toBe(true);
  });

  it('refuses lossy export by default and allowLossy retains identical diagnostics', () => {
    const circuit: CircuitIR = {
      components: [
        { type: 'I', id: 'I1', name: 'I1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'dc', dc: 1 } },
        { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { resistance: 1000, temperatureCoefficient: 0.001 } },
      ],
      nets: ['in'],
    };
    const refused = toCircuitJSON(circuit);
    const allowed = toCircuitJSON(circuit, { allowLossy: true });

    expect(refused.value).toBeUndefined();
    expect(refused.lossy).toBe(true);
    expect(refused.diagnostics.map(d => d.path)).toEqual(['/components/0', '/components/1/params/temperatureCoefficient']);
    expect(refused.diagnostics.every(d => d.code === 'LOSSY_EXPORT')).toBe(true);
    expect(allowed.lossy).toBe(true);
    expect(allowed.value).toBeDefined();
    expect(allowed.diagnostics).toEqual(refused.diagnostics);
    expect(allowed.value!.filter(element => element.type === 'source_component')).toHaveLength(1);
  });

  it('diagnoses duplicate component IDs during export', () => {
    const circuit: CircuitIR = {
      components: [expectedIR.components[0], { ...expectedIR.components[1], id: 'R1' }],
      nets: expectedIR.nets,
    };
    const refused = toCircuitJSON(circuit);
    expect(refused.value).toBeUndefined();
    expect(refused.diagnostics.map(d => d.path)).toEqual(['/components/1']);
    const allowed = toCircuitJSON(circuit, { allowLossy: true });
    expect(allowed.value!.filter(element => element.type === 'source_component')).toHaveLength(1);
    expect(allowed.diagnostics).toEqual(refused.diagnostics);
  });

  it('isolates circuit-json dependencies to the adapter package', () => {
    const adapter = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    const core = readFileSync(new URL('../../core/package.json', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../../ui/package.json', import.meta.url), 'utf8');
    expect(adapter.dependencies['circuit-json']).toBe('^0.0.525');
    expect(core).not.toContain('circuit-json');
    expect(core).not.toContain('"zod"');
    expect(ui).not.toContain('circuit-json');
    expect(ui).not.toContain('"zod"');
  });
});
