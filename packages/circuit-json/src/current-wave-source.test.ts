import { describe, expect, it } from 'vitest';
import { Circuit, parse, simulate } from '@spice-ts/core';
import type { CircuitIR, IRComponent } from '@spice-ts/core';
import type { CircuitJson } from 'circuit-json';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const sine = { current: 0.003, wave_shape: 'sinewave', peak_to_peak_current: 0.002, frequency: 1000, phase: 30 };
const square = { current: 1, wave_shape: 'square', peak_to_peak_current: 4, frequency: 1000 };
function source(fields: Record<string, unknown>, voltage = false): CircuitJson {
  return [{ type: 'source_component', ftype: voltage ? 'simple_voltage_source' : 'simple_current_source', source_component_id: 'I1', name: 'I1', ...fields }] as CircuitJson;
}
function netlist(ir: CircuitIR): string {
  const circuit = new Circuit();
  for (const device of ir.components) {
    const p = device.ports.find(port => port.name === 'p')!.net;
    const n = device.ports.find(port => port.name === 'n')!.net;
    if (device.type === 'I') {
      const params = device.params as Record<string, number>;
      if (device.params.waveform === 'sin') {
        const { offset, amplitude, frequency, phase } = params;
        circuit.addCurrentSource(device.name, p, n, { type: 'sin', offset, amplitude, frequency, phase, delay: 0, damping: 0 });
      } else {
        const { v1, v2, delay, rise, fall, width, period } = params;
        circuit.addCurrentSource(device.name, p, n, { type: 'pulse', v1, v2, delay, rise, fall, width, period });
      }
    } else circuit.addResistor(device.name, p, n, device.params.resistance as number);
  }
  return circuit.toNetlist().replace(/\.end\s*$/i, '.tran 10u 2m\n.end');
}
function loaded(fields: Record<string, unknown>): CircuitJson {
  const elements: Record<string, unknown>[] = [
    ...source(fields),
    { type: 'source_component', ftype: 'simple_resistor', source_component_id: 'R1', name: 'R1', resistance: 1000 },
    { type: 'source_net', source_net_id: 'n1', name: 'n1', member_source_group_ids: [] },
    { type: 'source_net', source_net_id: '0', name: 'GND', is_ground: true, member_source_group_ids: [] },
  ];
  [['I1', 'p', '0'], ['I1', 'n', 'n1'], ['R1', 'p', 'n1'], ['R1', 'n', '0']].forEach(([owner, name, net], i) => {
    elements.push({ type: 'source_port', source_port_id: `p${i}`, source_component_id: owner, name });
    elements.push({ type: 'source_trace', source_trace_id: `t${i}`, connected_source_port_ids: [`p${i}`], connected_source_net_ids: [net] });
  });
  return elements as CircuitJson;
}
const canonicalPulse = { waveform: 'pulse', v1: -1, v2: 3, delay: 0, rise: 1e-9, fall: 1e-9, width: 0.0005, period: 0.001 };

describe('current wave sources (#1783)', () => {
  it.each([
    [sine, { waveform: 'sin', offset: 0.003, amplitude: 0.001, frequency: 1000, phase: 30 }],
    [square, canonicalPulse],
  ])('imports amperes with identical voltage waveform math %j', (fields, expected) => {
    const imported = fromCircuitJSON(source(fields));
    expect(imported.diagnostics).toEqual([]);
    expect(imported.lossy).toBe(false);
    expect(imported.value?.components[0]).toMatchObject({ type: 'I', params: expected });
    const { current, peak_to_peak_current, ...shared } = fields;
    expect(imported.value?.components[0].params).toEqual(fromCircuitJSON(source({ ...shared, voltage: current, peak_to_peak_voltage: peak_to_peak_current }, true)).value?.components[0].params);
  });

  it.each([
    { current: -1, wave_shape: 'sinewave', peak_to_peak_current: -4, frequency: -2 },
    { current: 0, wave_shape: 'sinewave', peak_to_peak_current: 0, frequency: 0 },
    square,
    { ...square, current: -2, peak_to_peak_current: -4, phase: 90, duty_cycle: 0.25 },
  ])('round-trips defaults and signed values %j', fields => {
    const imported = fromCircuitJSON(source(fields));
    expect(imported.diagnostics).toEqual([]);
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    expect(exported.lossy).toBe(false);
    expect(exported.value).toContainEqual(expect.objectContaining({ ...fields, phase: 'phase' in fields ? fields.phase : 0, ...(fields.wave_shape === 'square' ? { duty_cycle: 'duty_cycle' in fields ? fields.duty_cycle : 0.5 } : {}) }));
    expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
  });

  it.each([
    ['SIN(-1 -2 1k)', { current: -1, wave_shape: 'sinewave', peak_to_peak_current: -4, frequency: 1000, phase: 0 }],
    ['PULSE(-1 3 250u 1n 1n 250u 1m)', { ...square, phase: 90, duty_cycle: 0.25 }],
  ])('exports parsed I %s', (wave, fields) => {
    const exported = toCircuitJSON(parse(`wave\nI1 0 n1 ${wave}\nR1 n1 0 1k\n.end`).toIR());
    expect(exported.diagnostics).toEqual([]);
    expect(exported.lossy).toBe(false);
    expect(exported.value).toContainEqual(expect.objectContaining({ ftype: 'simple_current_source', ...fields }));
  });

  it.each([[sine, 'SIN('], [square, 'PULSE(']] as const)('generates an I waveform through Circuit API %j', (fields, token) => {
    const imported = fromCircuitJSON(loaded(fields));
    expect(imported.diagnostics).toEqual([]);
    expect(netlist(imported.value!)).toContain(`I1 0 n1 ${token}`);
  });

  const invalid: Array<[Record<string, unknown>, string]> = [];
  for (const shape of [sine, square]) {
    for (const key of ['current', 'peak_to_peak_current', 'frequency', 'phase', ...(shape.wave_shape === 'square' ? ['duty_cycle'] : [])]) {
      for (const value of [null, '1', NaN, Infinity]) invalid.push([{ ...shape, [key]: value }, key]);
    }
    for (const key of ['current', 'peak_to_peak_current', 'frequency']) invalid.push([{ ...shape, [key]: undefined }, key]);
  }
  for (const [key, value] of [
    ['frequency', 0], ['frequency', -1], ['frequency', Number.MIN_VALUE],
    ['phase', -1], ['phase', Number.MIN_VALUE], ['duty_cycle', 0], ['duty_cycle', 1], ['duty_cycle', Number.MIN_VALUE],
    ['peak_to_peak_current', Number.MIN_VALUE],
  ] as const) invalid.push([{ ...square, [key]: value }, key]);
  invalid.push([{ ...square, frequency: 1e-300, phase: 1e100 }, 'phase']);
  invalid.push([{ ...square, current: Number.MAX_VALUE, peak_to_peak_current: Number.MAX_VALUE }, 'peak_to_peak_current']);
  invalid.push([{ ...square, current: -Number.MAX_VALUE, peak_to_peak_current: Number.MAX_VALUE }, 'peak_to_peak_current']);
  invalid.push([{ ...square, frequency: Number.MAX_VALUE, duty_cycle: Number.MIN_VALUE }, 'duty_cycle']);
  invalid.push([{ ...sine, 'extra/~': 1 }, 'extra~1~0']);
  it.each(invalid)('rejects invalid waveform field with JSON pointer %j (%s)', (fields, key) => {
    const result = fromCircuitJSON(source(fields));
    expect(result.value).toBeUndefined();
    expect(result.lossy).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}`, elementId: 'I1', simulationRelevant: true, severity: 'error' }));
  });

  const lossy: Array<[IRComponent['params'], string, unknown]> = [];
  const sinParams = { waveform: 'sin', offset: 1, amplitude: 2, frequency: 1000, phase: 0 };
  for (const key of ['offset', 'amplitude', 'frequency', 'phase']) lossy.push([sinParams, key, Infinity]);
  lossy.push([sinParams, 'amplitude', Number.MAX_VALUE]);
  for (const key of ['delay', 'damping', 'dc', 'ac', 'extra']) lossy.push([sinParams, key, 0.5]);
  for (const [key, value] of [
    ['rise', 2e-9], ['fall', 2e-9], ['rise', 0], ['fall', 0], ['width', 0], ['width', 0.001],
    ['period', 0], ['period', -1], ['period', Infinity], ['period', Number.MIN_VALUE],
    ['delay', -1], ['delay', Infinity], ['delay', undefined], ['v1', NaN], ['v2', Infinity], ['v2', undefined],
    ['pulses', 2], ['dc', 0], ['ac', 1], ['extra', 1],
  ] as const) lossy.push([canonicalPulse, key, value]);
  it.each(lossy)('retains exact voltage export guards for I %j %s=%s', (params, key, value) => {
    for (const allowLossy of [false, true]) {
      const components = (['I', 'V'] as const).map(type => ({ type, id: `${type}1`, name: `${type}1`, ports: [], params: { ...params, [key]: value } as IRComponent['params'] }));
      const [current, voltage] = components.map(component => toCircuitJSON({ components: [component], nets: [] }, { allowLossy }));
      expect(current.lossy).toBe(true);
      expect(current.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT', path: `/components/0/params/${key}`, elementId: 'I1' }));
      expect(current.diagnostics.map(d => d.path)).toEqual(voltage.diagnostics.map(d => d.path));
      if (!allowLossy) expect(current.value).toBeUndefined();
      expect(Boolean(current.value)).toBe(Boolean(voltage.value));
    }
  });

  it('simulates connected I1 0 n1 and 1k resistor against analytic sine', async () => {
    const imported = fromCircuitJSON(loaded(sine));
    expect(imported.diagnostics).toEqual([]);
    const transient = (await simulate(netlist(imported.value!))).transient!;
    expect(transient.time.length).toBeGreaterThanOrEqual(5);
    const voltages = transient.voltages.get('n1')!;
    const absolute = transient.time.map((t, i) => Math.abs(voltages[i] - 1000 * (sine.current + sine.peak_to_peak_current / 2 * Math.sin(2 * Math.PI * sine.frequency * t + sine.phase * Math.PI / 180))));
    const relative = transient.time.map((t, i) => absolute[i] / Math.abs(1000 * (sine.current + sine.peak_to_peak_current / 2 * Math.sin(2 * Math.PI * sine.frequency * t + sine.phase * Math.PI / 180))));
    process.stdout.write(`Current sine E2E: sampleCount=${transient.time.length}, maxAbsoluteError=${Math.max(...absolute)}, maxRelativeError=${Math.max(...relative)}\n`);
    expect(Math.max(...relative)).toBeLessThanOrEqual(1e-9);
  });
});
