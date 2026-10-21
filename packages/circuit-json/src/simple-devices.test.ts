import { describe, expect, it } from 'vitest';
import { Circuit, simulate } from '@spice-ts/core';
import type { CircuitJson } from 'circuit-json';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const cases = [
  ['simple_inductor', { inductance: 0.001 }, 'L', { inductance: 0.001 }],
  ['simple_diode', {}, 'D', { modelName: '' }],
  ['simple_led', {}, 'D', { modelName: '' }],
  ['simple_voltage_source', { voltage: 5 }, 'V', { waveform: 'dc', dc: 5 }],
] as const;

function fixture(ftype: string, fields: Record<string, unknown>): CircuitJson {
  return [{ type: 'source_component', source_component_id: 'device', name: 'device', ftype, ...fields }] as CircuitJson;
}

describe('simple circuit-json simulation devices (#1664)', () => {
  it.each(cases)('imports %s into typed IR', (ftype, fields, type, params) => {
    const result = fromCircuitJSON(fixture(ftype, fields));
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.components[0]).toMatchObject({ type, params });
    expect(result.lossy).toBe(false);
  });

  it.each(cases)('rejects unknown parameters on %s', (ftype, fields) => {
    const result = fromCircuitJSON(fixture(ftype, { ...fields, unknown_parameter: 1 }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([{ code: 'UNSUPPORTED_PARAMETER', path: '/0/unknown_parameter', elementId: 'device', simulationRelevant: true }]);
  });

  it.each(['frequency', 'peak_to_peak_voltage', 'wave_shape', 'phase', 'duty_cycle', 'pulse_delay', 'rise_time', 'fall_time', 'pulse_width', 'period'])('rejects voltage-source waveform field %s', key => {
    expect(fromCircuitJSON(fixture('simple_voltage_source', { voltage: 5, [key]: 1 })).diagnostics)
      .toMatchObject([{ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}` }]);
  });

  it.each([
    ['simple_inductor', 'inductance'], ['simple_voltage_source', 'voltage'],
  ])('validates the finite required numeric field on %s', (ftype, field) => {
    for (const value of [undefined, '1k', NaN, Infinity]) {
      const result = fromCircuitJSON(fixture(ftype, value === undefined ? {} : { [field]: value }));
      expect(result.value).toBeUndefined();
      expect(result.diagnostics).toMatchObject([{ code: 'UNSUPPORTED_PARAMETER', path: `/0/${field}` }]);
    }
  });

  it('keeps capacity-only batteries unsupported rather than inventing voltage', () => {
    expect(fromCircuitJSON(fixture('simple_battery', { capacity: 1 })).diagnostics)
      .toMatchObject([{ code: 'UNSUPPORTED_ELEMENT', path: '/0' }]);
  });

  it.each(['color', 'wavelength', 'forward_voltage'])('diagnoses LED model field %s', key => {
    const result = fromCircuitJSON(fixture('simple_led', { [key]: 'red' }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([{ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}` }]);
  });

  it.each([
    ['L', { inductance: Infinity }, 'inductance'],
    ['V', { waveform: 'dc', dc: NaN }, 'dc'],
  ] as const)('refuses nonfinite %s export values', (type, params, field) => {
    const result = toCircuitJSON({ components: [{ type, id: 'device', name: 'device', ports: [], params }], nets: [] });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([{ code: 'LOSSY_EXPORT', path: `/components/0/params/${field}` }]);
  });

  it('round-trips new representable IR and diagnoses AC/custom model exports', () => {
    for (const [ftype, fields] of cases) {
      const imported = fromCircuitJSON(fixture(ftype, fields));
      expect(imported.value).toBeDefined();
      const exported = toCircuitJSON(imported.value!);
      expect(exported.diagnostics).toEqual([]);
      expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
    }
    for (const [type, params] of [
      ['L', { inductance: 1e-3, ic: 1 }],
      ['V', { waveform: 'sine', dc: 5, frequency: 50 }],
      ['D', { modelName: 'custom' }],
    ] as const) {
      const result = toCircuitJSON({ components: [{ type, id: 'device', name: 'device', ports: [], params }], nets: [] });
      expect(result.value).toBeUndefined();
      expect(result.diagnostics.every(d => d.code === 'LOSSY_EXPORT')).toBe(true);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('matches hand-written RL + diode + DC source .op node voltages within relative 1e-12', async () => {
    const elements: Record<string, unknown>[] = [
      { type: 'source_component', source_component_id: 'V1', name: 'V1', ftype: 'simple_voltage_source', voltage: 5 },
      { type: 'source_component', source_component_id: 'R1', name: 'R1', ftype: 'simple_resistor', resistance: 1000 },
      { type: 'source_component', source_component_id: 'L1', name: 'L1', ftype: 'simple_inductor', inductance: 0.001 },
      { type: 'source_component', source_component_id: 'D1', name: 'D1', ftype: 'simple_diode' },
    ];
    for (const net of ['in', 'mid', 'out', '0']) elements.push({ type: 'source_net', source_net_id: net, name: net, member_source_group_ids: [] });
    const ports = [['V1', 'p', 'in'], ['V1', 'n', '0'], ['R1', 'p', 'in'], ['R1', 'n', 'mid'], ['L1', 'p', 'mid'], ['L1', 'n', 'out'], ['D1', 'anode', 'out'], ['D1', 'cathode', '0']];
    ports.forEach(([owner, name, net], i) => {
      elements.push({ type: 'source_port', source_port_id: `p${i}`, source_component_id: owner, name });
      elements.push({ type: 'source_trace', source_trace_id: `t${i}`, connected_source_port_ids: [`p${i}`], connected_source_net_ids: [net] });
    });
    const imported = fromCircuitJSON(elements as CircuitJson);
    expect(imported.diagnostics).toEqual([]);
    const circuit = new Circuit();
    for (const device of imported.value!.components) {
      const [p, n] = device.ports.map(port => port.net);
      if (device.type === 'V') circuit.addVoltageSource(device.name, p, n, { dc: device.params.dc as number });
      if (device.type === 'R') circuit.addResistor(device.name, p, n, device.params.resistance as number);
      if (device.type === 'L') circuit.addInductor(device.name, p, n, device.params.inductance as number);
      if (device.type === 'D') circuit.addDiode(device.name, p, n, (device.params.modelName as string) || undefined);
    }
    const actual = await simulate(circuit.toNetlist().replace(/\.end\s*$/i, '.op\n.end'));
    const reference = await simulate('* equivalent hand-written circuit\nV1 in 0 DC 5\nR1 in mid 1000\nL1 mid out 0.001\nD1 out 0 DEFAULT\n.model DEFAULT D\n.op\n.end');
    for (const net of ['in', 'mid', 'out']) {
      expect(Math.abs(actual.dc!.voltage(net) / reference.dc!.voltage(net) - 1)).toBeLessThanOrEqual(1e-12);
    }
  });
});
