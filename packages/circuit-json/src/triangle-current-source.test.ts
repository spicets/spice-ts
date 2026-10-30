import { describe, expect, it } from 'vitest';
import { source_simple_current_source, type CircuitJson } from 'circuit-json';
import { Circuit, parse, simulate } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const triangle = { type: 'source_component', ftype: 'simple_current_source', source_component_id: 'I1', name: 'I1', current: 0.001, wave_shape: 'triangle', peak_to_peak_current: 0.004, frequency: 1000, phase: 0 };
const source = (fields: Record<string, unknown> = {}): CircuitJson => [{ ...triangle, ...fields }] as CircuitJson;

describe('triangle current sources', () => {
  it('imports and round-trips a symmetric PULSE', () => {
    expect(source_simple_current_source.safeParse(triangle).success).toBe(true);
    const imported = fromCircuitJSON(source());
    expect(imported.diagnostics).toEqual([]);
    expect(imported.value?.components[0]).toMatchObject({ type: 'I', params: { waveform: 'pulse', v1: -0.001, v2: 0.003, delay: 0, rise: 0.0005, fall: 0.0005, width: 0, period: 0.001 } });
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    expect(exported.value).toContainEqual(expect.objectContaining(triangle));
    expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
  });

  it.each([-0.002, 0, 0.002].flatMap(current => [-0.004, 0, 0.004].map(peak => [current, peak])))('round-trips offset %s and peak-to-peak %s', (current, peak) => {
    const imported = fromCircuitJSON(source({ current, peak_to_peak_current: peak }));
    expect(imported.diagnostics).toEqual([]);
    expect(imported.value!.components[0].params).toMatchObject({ v1: current - peak / 2, v2: current + peak / 2 });
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
  });

  it('preserves a nonzero phase as an initial delay', () => {
    const imported = fromCircuitJSON(source({ phase: 90 }));
    expect(imported.diagnostics).toEqual([]);
    expect(imported.value!.components[0].params.delay).toBe(0.00025);
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
  });

  it('rejects a partially rounded peak-to-peak current at a large offset', () => {
    const result = fromCircuitJSON(source({ current: 1e16, peak_to_peak_current: 3 }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: '/0/peak_to_peak_current' }));
  });

  it('rejects a nonzero amplitude lost to rounding at a large offset', () => {
    const result = fromCircuitJSON(source({ current: Number.MAX_VALUE, peak_to_peak_current: 4 }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: '/0/peak_to_peak_current' }));
  });

  it.each([
    ['current', NaN], ['current', Infinity], ['peak_to_peak_current', NaN], ['peak_to_peak_current', Infinity],
    ['peak_to_peak_current', Number.MIN_VALUE], ['frequency', NaN], ['frequency', Infinity], ['frequency', 0],
    ['frequency', -1], ['frequency', Number.MIN_VALUE], ['phase', Infinity], ['phase', -1],
    ['phase', Number.MIN_VALUE], ['duty_cycle', 0.5], ['pulse_width', 1], ['rise_time', 1],
  ])('rejects invalid or conflicting field %s=%s', (key, value) => {
    const result = fromCircuitJSON(source({ [key]: value }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}`, elementId: 'I1' }));
  });

  it.each([['rise', 0.0004, 'rise'], ['fall', 0.0004, 'fall'], ['width', 0.0001, 'rise'], ['delay', -1, 'delay'], ['period', 0, 'period'], ['pulses', 2, 'pulses']])('diagnoses nonrepresentable PULSE %s', (key, value, path) => {
    const ir = fromCircuitJSON(source()).value!;
    ir.components[0].params[key] = value;
    const result = toCircuitJSON(ir);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT', path: `/components/0/params/${path}`, elementId: 'I1' }));
  });

  it('preserves a parallel RC deck and its source waveform', async () => {
    // Original MIT-licensed fixture. Both paths use the same core simulator.
    const deck = 'triangle current RC\nI1 0 out PULSE(-1m 3m 0 0.5m 0.5m 0 1m)\nR1 out 0 1k\nC1 out 0 100n\n.tran 5u 3m\n.end';
    const original = parse(deck).toIR();
    const exported = toCircuitJSON(original);
    expect(exported.diagnostics).toEqual([]);
    const imported = fromCircuitJSON(exported.value!);
    expect(imported.diagnostics).toEqual([]);
    expect(imported.value!.components).toEqual(original.components);
    const circuit = new Circuit();
    for (const device of imported.value!.components) {
      const p = device.ports.find(port => port.name === 'p')!.net;
      const n = device.ports.find(port => port.name === 'n')!.net;
      if (device.type === 'I') {
        const { v1, v2, delay, rise, fall, width, period } = device.params as Record<string, number>;
        circuit.addCurrentSource(device.name, p, n, { type: 'pulse', v1, v2, delay, rise, fall, width, period });
      } else if (device.type === 'R') circuit.addResistor(device.name, p, n, device.params.resistance as number);
      else if (device.type === 'C') circuit.addCapacitor(device.name, p, n, device.params.capacitance as number);
    }
    const convertedDeck = circuit.toNetlist().replace(/\.end\s*$/i, '.tran 5u 3m\n.end');
    const actual = (await simulate(convertedDeck)).transient!;
    const direct = (await simulate(deck)).transient!;
    // Independent current sources have no branch-current result vector. Sample the
    // core device evaluator for each parsed waveform at the actual solver times.
    const currentSamples = (input: Circuit) => {
      const device = input.compile().devices.find(d => d.name.toLowerCase() === 'i1') as unknown as {
        setTransientTimestep: (step: number, stop: number) => void;
        getCurrentAtTime: (time: number) => number;
      };
      expect(device).toBeDefined();
      device.setTransientTimestep(5e-6, 3e-3);
      return Array.from(actual.time, time => device.getCurrentAtTime(time));
    };
    const actualCurrent = currentSamples(circuit);
    const directCurrent = currentSamples(parse(deck));
    expect(actual.time).toEqual(direct.time);
    const errors = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a, (v, i) => Math.abs(v - b[i]));
    const v = errors(actual.voltage('out'), direct.voltage('out'));
    const i = errors(actualCurrent, directCurrent);
    const rms = (values: number[]) => Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
    expect(Math.max(...v)).toBeLessThanOrEqual(1e-12);
    expect(Math.max(...i)).toBeLessThanOrEqual(1e-12);
    for (const [time, expected] of [[0, -0.001], [0.0005, 0.003]]) {
      const index = actual.time.findIndex(t => Math.abs(t - time) < 1e-12);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(actualCurrent[index]).toBeCloseTo(expected, 12);
    }
    process.stdout.write(`triangle RC samples=${v.length} voltage max=${Math.max(...v)} rms=${rms(v)} current max=${Math.max(...i)} rms=${rms(i)}\n`);
  });
});
