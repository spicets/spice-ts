import { describe, expect, it } from 'vitest';
import type { CircuitJson } from 'circuit-json';
import { Circuit, parse, simulate } from '@spice-ts/core';
import type { CircuitIR } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const square = { voltage: 1, wave_shape: 'square', peak_to_peak_voltage: 4, frequency: 1000 };
function source(fields: Record<string, unknown>): CircuitJson {
  return [{ type: 'source_component', ftype: 'simple_voltage_source', source_component_id: 'V1', name: 'V1', ...fields }] as CircuitJson;
}

describe('square voltage source imports (#1727)', () => {
  it('imports a square as PULSE with default duty and phase', () => {
    const result = fromCircuitJSON(source(square));
    expect(result.diagnostics).toEqual([]);
    expect(result.lossy).toBe(false);
    expect(result.value?.components[0].params).toEqual({
      waveform: 'pulse', v1: -1, v2: 3, delay: 0,
      rise: 1e-9, fall: 1e-9, width: 0.0005, period: 0.001,
    });
  });

  it.each([
    [{ frequency: Number.MIN_VALUE }, 'frequency'],
    [{ frequency: Number.MAX_VALUE, duty_cycle: Number.MIN_VALUE }, 'duty_cycle'],
    [{ duty_cycle: Number.MIN_VALUE }, 'duty_cycle'],
    [{ phase: Number.MIN_VALUE }, 'phase'],
    [{ frequency: 1e-300, phase: 1e100 }, 'phase'],
    [{ voltage: Number.MAX_VALUE, peak_to_peak_voltage: Number.MAX_VALUE }, 'peak_to_peak_voltage'],
    [{ voltage: -Number.MAX_VALUE, peak_to_peak_voltage: Number.MAX_VALUE }, 'peak_to_peak_voltage'],
    [{ peak_to_peak_voltage: Number.MIN_VALUE }, 'peak_to_peak_voltage'],
  ])('rejects unrepresentable derived square parameters %j', (fields, key) => {
    const result = fromCircuitJSON(source({ ...square, ...fields }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}`,
    }));
  });

  it('preserves signed levels and maps explicit duty and phase to pulse time', () => {
    const result = fromCircuitJSON(source({ ...square, voltage: -2, peak_to_peak_voltage: -4, duty_cycle: 0.25, phase: 90 }));
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.components[0].params).toEqual({
      waveform: 'pulse', v1: 0, v2: -4, delay: 0.00025,
      rise: 1e-9, fall: 1e-9, width: 0.00025, period: 0.001,
    });
  });

  it.each(['triangle', 'sawtooth'])('continues rejecting %s', wave_shape => {
    const result = fromCircuitJSON(source({ ...square, wave_shape }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: '/0/wave_shape' }));
  });

  it.each(['frequency', 'peak_to_peak_voltage', 'phase', 'duty_cycle'])('continues rejecting DC waveform parameter %s', key => {
    const result = fromCircuitJSON(source({ voltage: 1, wave_shape: 'dc', [key]: 1 }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}` }));
  });

  it.each([
    ['frequency', undefined], ['frequency', 0], ['frequency', -1], ['frequency', Infinity],
    ['peak_to_peak_voltage', undefined], ['peak_to_peak_voltage', NaN],
    ['voltage', Infinity], ['voltage', '1'],
    ['duty_cycle', 0], ['duty_cycle', 1], ['duty_cycle', -0.5], ['duty_cycle', null],
    ['phase', -1], ['phase', Infinity], ['phase', null],
  ])('rejects invalid square %s=%s with a field diagnostic', (key, value) => {
    const result = fromCircuitJSON(source({ ...square, [key as string]: value }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}`, elementId: 'V1',
      severity: 'error', simulationRelevant: true,
    }));
  });
});


describe('square voltage source export (#1727)', () => {
  it.each([{}, { phase: 90, duty_cycle: 0.25 }, { peak_to_peak_voltage: -4 }])('round-trips square import/export/import without changing IR %j', fields => {
    const imported = fromCircuitJSON(source({ ...square, ...fields }));
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    expect(exported.lossy).toBe(false);
    expect(exported.value).toContainEqual(expect.objectContaining({ ...square, phase: 0, duty_cycle: 0.5, ...fields }));
    expect(fromCircuitJSON(exported.value!).value).toEqual(imported.value);
  });

  it('exports a canonical parsed PULSE', () => {
    const ir = parse('square\nV1 in 0 PULSE(-1 3 250u 1n 1n 250u 1m)\nR1 in 0 1k\n.end').toIR();
    const exported = toCircuitJSON(ir);
    expect(exported.diagnostics).toEqual([]);
    expect(exported.value).toContainEqual(expect.objectContaining({ ...square, phase: 90, duty_cycle: 0.25 }));
  });
});


function netlist(ir: CircuitIR): string {
  const circuit = new Circuit();
  for (const device of ir.components) {
    const p = device.ports.find(port => port.name === 'p')!.net;
    const n = device.ports.find(port => port.name === 'n')!.net;
    if (device.type === 'V') {
      const { v1, v2, delay, rise, fall, width, period } = device.params as Record<string, number>;
      circuit.addVoltageSource(device.name, p, n, { type: 'pulse', v1, v2, delay, rise, fall, width, period });
    } else if (device.type === 'R') circuit.addResistor(device.name, p, n, device.params.resistance as number);
    else if (device.type === 'C') circuit.addCapacitor(device.name, p, n, device.params.capacitance as number);
    else throw new Error(`Unexpected device ${device.type}`);
  }
  return circuit.toNetlist().replace(/\.end\s*$/i, '.options method=gear reltol=1e-10 abstol=1e-15 vntol=1e-12\n.tran 10u 3m\n.end');
}

describe('square waveform fidelity and export diagnostics', () => {
  it('preserves RC plateaus and period through core to 1e-9 relative', async () => {
    const deck = 'RC square\nV1 in 0 PULSE(-1 3 0 1n 1n 500u 1m)\nR1 in out 1k\nC1 out 0 100p\n.options method=gear reltol=1e-10 abstol=1e-15 vntol=1e-12\n.tran 10u 3m\n.end';
    const exported = toCircuitJSON(parse(deck).toIR());
    expect(exported.diagnostics).toEqual([]);
    const imported = fromCircuitJSON(exported.value!);
    expect(imported.diagnostics).toEqual([]);
    const actual = (await simulate(netlist(imported.value!))).transient!;
    const direct = (await simulate(deck)).transient!;
    expect(actual.time).toEqual(direct.time);
    const output = actual.voltages.get('out')!;
    const input = actual.voltages.get('in')!;
    const relativeErrors = output.map((v, i) => Math.abs(v - direct.voltages.get('out')![i]) / Math.max(1, Math.abs(v)));
    expect(Math.max(...relativeErrors)).toBeLessThanOrEqual(1e-9);
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const [offset, expected] of [[0.00025, 3], [0.00075, -1]]) {
        const target = cycle * 0.001 + offset;
        const i = actual.time.findIndex(t => t >= target);
        expect(i).toBeGreaterThan(0);
        expect(Math.abs(input[i] / expected - 1)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(output[i] / expected - 1)).toBeLessThanOrEqual(1e-9);
      }
    }
    const crossings: number[] = [];
    for (let i = 1; i < input.length; i++) {
      if (input[i - 1] < 1 && input[i] >= 1) {
        crossings.push(actual.time[i - 1] + (1 - input[i - 1]) / (input[i] - input[i - 1]) * (actual.time[i] - actual.time[i - 1]));
      }
    }
    expect(crossings.length).toBeGreaterThanOrEqual(3);
    const periodErrors = crossings.slice(1).map((t, i) => Math.abs((t - crossings[i]) / 0.001 - 1));
    expect(Math.max(...periodErrors)).toBeLessThanOrEqual(1e-9);
    process.stdout.write(`RC square: samples=${output.length}, maxRelative=${Math.max(...relativeErrors)}, maxPeriodRelative=${Math.max(...periodErrors)}\n`);
  });

  it.each([
    ['rise', 2e-9], ['fall', 2e-9], ['rise', 0], ['fall', 0],
    ['rise', 2e-8], ['width', 0], ['width', 0.001], ['width', -1],
    ['period', 0], ['period', -1], ['period', Infinity], ['period', Number.MIN_VALUE],
    ['delay', -1], ['delay', Infinity], ['delay', undefined],
    ['v1', NaN], ['v2', Infinity], ['v1', Infinity], ['v2', undefined],
    ['pulses', 2], ['dc', 0], ['ac', 1], ['extra', 1],
  ])('diagnoses nonrepresentable PULSE %s=%s even with allowLossy', (key, value) => {
    const ir = fromCircuitJSON(source(square)).value!;
    ir.components[0].params[key] = value as number;
    for (const allowLossy of [false, true]) {
      const result = toCircuitJSON(ir, { allowLossy });
      expect(result.lossy).toBe(true);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT', path: `/components/0/params/${key}`, elementId: 'V1', simulationRelevant: true }));
      if (!allowLossy) expect(result.value).toBeUndefined();
    }
  });

  it('rejects equal but noncanonical rise and fall times', () => {
    const ir = fromCircuitJSON(source(square)).value!;
    ir.components[0].params.rise = ir.components[0].params.fall = 1e-8;
    expect(toCircuitJSON(ir).diagnostics.map(d => d.path)).toEqual(['/components/0/params/fall', '/components/0/params/rise']);
  });
});
