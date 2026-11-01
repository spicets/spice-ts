import { describe, expect, it } from 'vitest';
import { source_simple_voltage_source, type CircuitJson } from 'circuit-json';
import { Circuit, simulate } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const saw = { type: 'source_component', ftype: 'simple_voltage_source', source_component_id: 'V1', name: 'V1', voltage: 1, wave_shape: 'sawtooth', peak_to_peak_voltage: 4, frequency: 1000, phase: 90 };
const source = (fields: Record<string, unknown> = {}): CircuitJson => [{ ...saw, ...fields }] as CircuitJson;

describe('sawtooth voltage sources', () => {
  it('imports the schema sawtooth as an explicit finite-reset pulse', () => {
    expect(source_simple_voltage_source.safeParse(saw).success).toBe(true);
    const result = fromCircuitJSON(source());
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.components[0].params).toEqual({ waveform: 'pulse', v1: -1, v2: 3, delay: 0.00025, rise: 0.001 - 0.001 * 1e-6, fall: 0.001 * 1e-6, width: 0, period: 0.001 });
  });

  it('exports and reimports the canonical pulse without changing parameters', () => {
    const triangle = fromCircuitJSON(source({ wave_shape: 'triangle' })).value!;
    triangle.components[0].params = { waveform: 'pulse', v1: -1, v2: 3, delay: 0.00025, rise: 0.001 - 0.001 * 1e-6, fall: 0.001 * 1e-6, width: 0, period: 0.001 };
    const result = toCircuitJSON(triangle);
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toContainEqual(expect.objectContaining(saw));
    expect(fromCircuitJSON(result.value!).value).toEqual(triangle);
  });

  it.each([0, -4])('round-trips signed amplitude %s', amplitude => {
    const ir = fromCircuitJSON(source({ peak_to_peak_voltage: amplitude })).value!;
    const result = toCircuitJSON(ir);
    expect(result.diagnostics).toEqual([]);
    expect(fromCircuitJSON(result.value!).value).toEqual(ir);
  });

  it.each([
    ['frequency', undefined], ['frequency', 0], ['frequency', Infinity], ['frequency', Number.MIN_VALUE],
    ['peak_to_peak_voltage', undefined], ['peak_to_peak_voltage', NaN], ['peak_to_peak_voltage', Number.MIN_VALUE],
    ['voltage', Infinity], ['phase', -1], ['phase', Infinity], ['phase', Number.MIN_VALUE],
    ['duty_cycle', 0.5], ['rise_time', 1], ['pulse_width', 1],
  ])('rejects invalid %s=%s with field-local diagnostics', (key, value) => {
    const result = fromCircuitJSON(source({ [key]: value }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}` }));
  });

  it.each([
    [{ voltage: Number.MAX_VALUE, peak_to_peak_voltage: 4 }, 'peak_to_peak_voltage'],
    [{ voltage: Number.MAX_VALUE, peak_to_peak_voltage: Number.MAX_VALUE }, 'peak_to_peak_voltage'],
    [{ frequency: 1e-300, phase: 1e100 }, 'phase'],
    [{ frequency: Number.MAX_VALUE, phase: Number.MIN_VALUE }, 'phase'],
  ])('rejects derived overflow or underflow %j', (fields, key) => {
    const result = fromCircuitJSON(source(fields));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}` }));
  });

  it('diagnoses voltage-only fields on a malformed sawtooth current source', () => {
    const result = fromCircuitJSON(source({ ftype: 'simple_current_source', current: 1, voltage: undefined, peak_to_peak_current: 4, peak_to_peak_voltage: undefined }));
    expect(result.value).toBeUndefined();
    for (const field of ['voltage', 'peak_to_peak_voltage']) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${field}` }));
    }
  });

  it.each([['rise', 0], ['fall', 0], ['rise', 0.0005], ['fall', 2e-9], ['width', 1e-7], ['dc', 1], ['ac', 1], ['pulses', 2], ['extra', 1]])('diagnoses incompatible export %s in both modes', (key, value) => {
    const ir = fromCircuitJSON(source()).value!;
    ir.components[0].params[key] = value as number;
    for (const allowLossy of [false, true]) {
      const result = toCircuitJSON(ir, { allowLossy });
      expect(result.lossy).toBe(true);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT' }));
      if (!allowLossy) expect(result.value).toBeUndefined();
    }
  });

  it.each([4, -4])('matches the analytic ramp and direct PULSE for amplitude %s', async amplitude => {
    const elements: Record<string, unknown>[] = [
      ...source({ peak_to_peak_voltage: amplitude }),
      { type: 'source_component', ftype: 'simple_resistor', source_component_id: 'R1', name: 'R1', resistance: 1000 },
      { type: 'source_net', source_net_id: 'in', name: 'in', member_source_group_ids: [] },
      { type: 'source_net', source_net_id: '0', name: 'GND', is_ground: true, member_source_group_ids: [] },
    ];
    [['V1', 'p', 'in'], ['V1', 'n', '0'], ['R1', 'p', 'in'], ['R1', 'n', '0']].forEach(([owner, name, net], i) => {
      elements.push({ type: 'source_port', source_port_id: `p${i}`, source_component_id: owner, name });
      elements.push({ type: 'source_trace', source_trace_id: `t${i}`, connected_source_port_ids: [`p${i}`], connected_source_net_ids: [net] });
    });
    const imported = fromCircuitJSON(elements as CircuitJson);
    expect(imported.diagnostics).toEqual([]);
    const v = imported.value!.components.find(c => c.id === 'V1')!;
    expect(v.ports).toEqual([{ name: 'p', net: 'in' }, { name: 'n', net: '0' }]);
    const p = v.params as Record<string, number>;
    const circuit = new Circuit();
    circuit.addVoltageSource('V1', v.ports[0].net, v.ports[1].net, { type: 'pulse', v1: p.v1, v2: p.v2, delay: p.delay, rise: p.rise, fall: p.fall, width: p.width, period: p.period });
    circuit.addResistor('R1', 'in', '0', 1000);
    const suffix = '.options method=gear reltol=1e-10 abstol=1e-15 vntol=1e-12\n.tran 10u 2.5m\n.end';
    const actual = (await simulate(circuit.toNetlist().replace(/\.end\s*$/i, suffix))).transient!;
    const direct = (await simulate(`saw\nV1 in 0 PULSE(${1-amplitude/2} ${1+amplitude/2} 250u 999.999u 1n 0 1m)\nR1 in 0 1k\n${suffix}`)).transient!;
    expect(actual.time).toEqual(direct.time);
    const errors = Array.from(actual.voltages.get('in')!, (value, i) => Math.abs(value - direct.voltages.get('in')![i]));
    expect(Math.max(...errors)).toBeLessThanOrEqual(1e-9);
    const currentErrors = Array.from(actual.current('V1'), (value, i) => Math.abs(value - direct.current('V1')[i]));
    expect(Math.max(...currentErrors)).toBeLessThanOrEqual(1e-9);
    for (const time of [0, 0.00025, 0.00075, 0.00225]) {
      const index = Array.from(actual.time).reduce((best, t, i) => Math.abs(t - time) < Math.abs(actual.time[best] - time) ? i : best, 0);
      const t = actual.time[index];
      const cycle = t < p.delay ? -1 : (t - p.delay) % p.period;
      const expected = cycle < 0 ? p.v1 : cycle < p.rise ? p.v1 + amplitude * cycle / p.rise : p.v2 - amplitude * (cycle - p.rise) / p.fall;
      process.stdout.write(`checkpoint requested=${time} actual=${t} value=${actual.voltages.get('in')![index]} analytic=${expected}\n`);
      expect(Math.abs(t - time)).toBeLessThanOrEqual(1e-5);
      expect(actual.voltages.get('in')![index]).toBeCloseTo(expected, 7);
    }
    const resetStart = actual.time.findIndex(t => Math.abs(t - 0.001249999) < 1e-13);
    const resetEnd = actual.time.findIndex(t => Math.abs(t - 0.00125) < 1e-13);
    expect(resetStart).toBeGreaterThanOrEqual(0);
    expect(resetEnd).toBeGreaterThan(resetStart);
    expect(actual.voltages.get('in')![resetStart]).toBeCloseTo(p.v2, 7);
    expect(actual.voltages.get('in')![resetEnd]).toBeCloseTo(p.v1, 7);
    process.stdout.write(`saw amplitude=${amplitude} samples=${errors.length} max voltage error=${Math.max(...errors)} max current error=${Math.max(...currentErrors)}\n`);
  });

});
