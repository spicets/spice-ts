import { describe, expect, it } from 'vitest';
import { Circuit, parse, simulate } from '@spice-ts/core';
import type { CircuitIR, IRComponent } from '@spice-ts/core';
import type { CircuitJson } from 'circuit-json';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const lossySources: IRComponent['params'][] = [
  { waveform: 'sine', dc: 1 },
  { waveform: 'dc' },
  { waveform: 'dc', dc: Infinity },
  { waveform: 'dc', dc: 1, ac: 1 },
];

function source(fields: Record<string, unknown>): CircuitJson {
  return [{ type: 'source_component', ftype: 'simple_current_source', source_component_id: 'I1', name: 'I1', ...fields }] as CircuitJson;
}

function netlist(ir: CircuitIR): string {
  const circuit = new Circuit();
  for (const device of ir.components) {
    const [p, n] = device.ports.map(port => port.net);
    if (device.type === 'I') circuit.addCurrentSource(device.name, p, n, { dc: device.params.dc as number });
    else if (device.type === 'R') circuit.addResistor(device.name, p, n, device.params.resistance as number);
    else throw new Error(`Unexpected device ${device.type}`);
  }
  return circuit.toNetlist().replace(/\.end\s*$/i, '.op\n.end');
}

function loadedSource(positive: string, negative: string): CircuitJson {
  const elements: Record<string, unknown>[] = [
    ...source({ current: 0.001, wave_shape: 'dc' }),
    { type: 'source_component', ftype: 'simple_resistor', source_component_id: 'R1', name: 'R1', resistance: 1000 },
    { type: 'source_net', source_net_id: 'n1', name: 'n1', member_source_group_ids: [] },
    { type: 'source_net', source_net_id: '0', name: 'GND', is_ground: true, member_source_group_ids: [] },
  ];
  [['I1', 'p', positive], ['I1', 'n', negative], ['R1', 'p', 'n1'], ['R1', 'n', '0']].forEach(([owner, name, net], i) => {
    elements.push({ type: 'source_port', source_port_id: `p${i}`, source_component_id: owner, name });
    elements.push({ type: 'source_trace', source_trace_id: `t${i}`, connected_source_port_ids: [`p${i}`], connected_source_net_ids: [net] });
  });
  return elements as CircuitJson;
}

describe('DC current-source circuit-json mapping (#1676)', () => {
  it.each([0, 0.001, -0.001])('imports finite current %s, with omitted wave_shape defaulting to dc', current => {
    const result = fromCircuitJSON(source({ current }));
    expect(result).toMatchObject({ lossy: false, diagnostics: [], value: { components: [{ type: 'I', params: { waveform: 'dc', dc: current } }] } });
  });

  it.each([['0', 'n1', 1], ['n1', '0', -1]] as const)('flows from %s to %s through the source', async (p, n, voltage) => {
    const imported = fromCircuitJSON(loadedSource(p, n));
    expect(imported.diagnostics).toEqual([]);
    const result = await simulate(netlist(imported.value!));
    expect(result.dc!.voltage('n1')).toBeCloseTo(voltage, 12);
  });

  it('round-trips a parsed SPICE DC I source losslessly with identical voltage', async () => {
    const original = '* DC current source\nI1 0 n1 1m\nR1 n1 0 1k\n.op\n.end';
    const exported = toCircuitJSON(parse(original).toIR());
    expect(exported.lossy).toBe(false);
    expect(exported.diagnostics).toEqual([]);
    expect(exported.value).toContainEqual(expect.objectContaining({ ftype: 'simple_current_source', current: 0.001, wave_shape: 'dc' }));
    const imported = fromCircuitJSON(exported.value!);
    expect(imported.lossy).toBe(false);
    expect(imported.diagnostics).toEqual([]);
    const actual = await simulate(netlist(imported.value!));
    const reference = await simulate(original);
    expect(Math.abs(actual.dc!.voltage('n1') / reference.dc!.voltage('n1') - 1)).toBeLessThanOrEqual(1e-12);
  });

  it.each([{}, { display_value: '1mA' }, { current: undefined }, { current: null }, { current: '1m' }, { current: NaN }, { current: Infinity }, { current: 0.001, wave_shape: 'sine' }, { current: 0.001, wave_shape: null }, ...['frequency', 'phase', 'peak_to_peak_current', 'duty_cycle', 'pulse_width'].map(key => ({ current: 0.001, [key]: 1 }))])('rejects missing, invalid or non-DC values %j', fields => {
    const result = fromCircuitJSON(source(fields));
    expect(result.value).toBeUndefined();
    expect(result.lossy).toBe(true);
    expect(result.diagnostics).toMatchObject([{ severity: 'error', code: 'UNSUPPORTED_ELEMENT', path: '/0', elementId: 'I1', simulationRelevant: true }]);
  });

  it.each(lossySources)('refuses lossy current-source export %j', params => {
    const result = toCircuitJSON({ components: [{ type: 'I', id: 'I1', name: 'I1', ports: [], params }], nets: [] });
    expect(result.value).toBeUndefined();
    expect(result.lossy).toBe(true);
    expect(result.diagnostics).toMatchObject([{ code: 'LOSSY_EXPORT', elementId: 'I1' }]);
  });
});
