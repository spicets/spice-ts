import { describe, expect, it } from 'vitest';
import { source_simple_voltage_source, type CircuitJson } from 'circuit-json';
import { Circuit, simulate } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const triangle = { type: 'source_component', ftype: 'simple_voltage_source', source_component_id: 'V1', name: 'V1', voltage: 1, wave_shape: 'triangle', peak_to_peak_voltage: 4, frequency: 1000, phase: 90 };
const source = (fields: Record<string, unknown> = {}): CircuitJson => [{ ...triangle, ...fields }] as CircuitJson;

describe('triangle voltage sources', () => {
  it('imports a triangle as a symmetric pulse and round-trips it', () => {
    expect(source_simple_voltage_source.safeParse(triangle).success).toBe(true);
    const imported = fromCircuitJSON(source());
    expect(imported.diagnostics).toEqual([]);
    expect(imported.value?.components[0].params).toEqual({ waveform: 'pulse', v1: -1, v2: 3, delay: 0.00025, rise: 0.0005, fall: 0.0005, width: 0, period: 0.001 });
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    expect(exported.value).toContainEqual(expect.objectContaining(triangle));
    expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
  });

  it.each([
    ['frequency', 0], ['frequency', Infinity], ['frequency', Number.MIN_VALUE],
    ['peak_to_peak_voltage', NaN], ['peak_to_peak_voltage', Number.MIN_VALUE],
    ['voltage', Infinity], ['phase', -1], ['phase', Infinity], ['phase', Number.MIN_VALUE],
    ['duty_cycle', 0.5], ['pulse_width', 1], ['rise_time', 1],
  ])('rejects invalid or conflicting %s', (key, value) => {
    const result = fromCircuitJSON(source({ [key]: value }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}` }));
  });

  it('rejects nonzero amplitude lost at a large offset', () => {
    const result = fromCircuitJSON(source({ voltage: Number.MAX_VALUE, peak_to_peak_voltage: 4 }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: '/0/peak_to_peak_voltage' }));
  });

  it.each([0, -4])('round-trips amplitude %s', amplitude => {
    const imported = fromCircuitJSON(source({ peak_to_peak_voltage: amplitude }));
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
  });

  it.each([['rise', 0.0004], ['fall', 0.0004], ['width', 0.0001], ['delay', -1], ['pulses', 2]])('diagnoses incompatible export %s', (key, value) => {
    const ir = fromCircuitJSON(source()).value!;
    ir.components[0].params[key] = value;
    const result = toCircuitJSON(ir);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT' }));
  });

  it('matches a hand-authored PULSE with a resistor for three periods', async () => {
    const params = fromCircuitJSON(source()).value!.components[0].params as Record<string, number>;
    const circuit = new Circuit();
    circuit.addVoltageSource('V1', 'in', '0', { type: 'pulse', v1: params.v1, v2: params.v2, delay: params.delay, rise: params.rise, fall: params.fall, width: params.width, period: params.period });
    circuit.addResistor('R1', 'in', '0', 1000);
    const suffix = '.options method=gear reltol=1e-10 abstol=1e-15 vntol=1e-12\n.tran 10u 3.5m\n.end';
    const actual = (await simulate(circuit.toNetlist().replace(/\.end\s*$/i, suffix))).transient!;
    const direct = (await simulate(`triangle\nV1 in 0 PULSE(-1 3 250u 500u 500u 0 1m)\nR1 in 0 1k\n${suffix}`)).transient!;
    expect(actual.time).toEqual(direct.time);
    const errors = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a, (v, i) => Math.abs(v - b[i]));
    const v = errors(actual.voltages.get('in')!, direct.voltages.get('in')!);
    const i = errors(actual.current('V1'), direct.current('V1'));
    const rms = (values: number[]) => Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
    expect(Math.max(...v)).toBeLessThanOrEqual(1e-9);
    expect(Math.max(...i)).toBeLessThanOrEqual(1e-9);
    for (const [time, expected] of [[0, -1], [0.00025, -1], [0.00075, 3], [0.00125, -1], [0.00325, -1]]) {
      const index = actual.time.findIndex(t => Math.abs(t - time) < 1e-12);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(actual.voltages.get('in')![index]).toBeCloseTo(expected, 8);
    }
    process.stdout.write(`triangle common-time samples=${v.length} voltage max=${Math.max(...v)} rms=${rms(v)} current max=${Math.max(...i)} rms=${rms(i)}\n`);
  });
});
