import { describe, expect, it } from 'vitest';
import { Circuit, parse, simulate } from '@spice-ts/core';
import type { CircuitIR } from '@spice-ts/core';
import type { CircuitJson } from 'circuit-json';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const sine = { voltage: 1.25, wave_shape: 'sinewave', peak_to_peak_voltage: 4, frequency: 1000, phase: 30 };
function source(fields: Record<string, unknown>): CircuitJson {
  return [{ type: 'source_component', ftype: 'simple_voltage_source', source_component_id: 'V1', name: 'V1', ...fields }] as CircuitJson;
}

function netlist(ir: CircuitIR): string {
  const circuit = new Circuit();
  for (const device of ir.components) {
    const p = device.ports.find(port => port.name === 'p')!.net;
    const n = device.ports.find(port => port.name === 'n')!.net;
    if (device.type === 'V') {
      const { offset, amplitude, frequency, phase } = device.params;
      circuit.addVoltageSource(device.name, p, n, { type: 'sin', offset: offset as number, amplitude: amplitude as number, frequency: frequency as number, delay: 0, damping: 0, phase: phase as number });
    } else if (device.type === 'R') circuit.addResistor(device.name, p, n, device.params.resistance as number);
    else if (device.type === 'C') circuit.addCapacitor(device.name, p, n, device.params.capacitance as number);
    else throw new Error(`Unexpected device ${device.type}`);
  }
  return circuit.toNetlist().replace(/\.end\s*$/i, '.tran 10u 2m\n.end');
}

describe('sinewave voltage sources (#1721)', () => {
  it('imports volts, peak-to-peak volts, Hz and degrees into SIN parameters', () => {
    const result = fromCircuitJSON(source(sine));
    expect(result.diagnostics).toEqual([]);
    expect(result.lossy).toBe(false);
    expect(result.value?.components[0].params).toEqual({ waveform: 'sin', offset: 1.25, amplitude: 2, frequency: 1000, phase: 30 });
  });

  it('exports parsed six-argument SIN without loss', () => {
    const result = toCircuitJSON(parse('sine\nV1 in 0 SIN(1.25 2 1k 0 0 30)\nR1 in 0 1k\n.end').toIR());
    expect(result.diagnostics).toEqual([]);
    expect(result.lossy).toBe(false);
    expect(result.value).toContainEqual(expect.objectContaining(sine));
  });

  it('round-trips an RC transient on identical time grids within 1e-12 absolute', async () => {
    const deck = 'RC sine\nV1 in 0 SIN(1.25 2 1k 0 0 30)\nR1 in out 1k\nC1 out 0 100n\n.tran 10u 2m\n.end';
    const exported = toCircuitJSON(parse(deck).toIR());
    expect(exported.diagnostics).toEqual([]);
    const imported = fromCircuitJSON(exported.value!);
    expect(imported.diagnostics).toEqual([]);
    const direct = (await simulate(deck)).transient!;
    const actual = (await simulate(netlist(imported.value!))).transient!;
    expect(actual.time).toEqual(direct.time);
    expect(actual.time.length).toBeGreaterThan(100);
    const errors = direct.voltages.get('out')!.map((v, i) => Math.abs(v - actual.voltages.get('out')![i]));
    expect(Math.max(...errors)).toBeLessThanOrEqual(1e-12);
    process.stdout.write(`RC sine round-trip: samples=${errors.length}, maxAbs=${Math.max(...errors)}, rmsAbs=${Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length)}\n`);
  });

  it('exports three-argument SIN with default phase and preserves signed amplitude', () => {
    const result = toCircuitJSON(parse('sine\nV1 in 0 SIN(-1 -2 1k)\nR1 in 0 1k\n.end').toIR());
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toContainEqual(expect.objectContaining({ voltage: -1, peak_to_peak_voltage: -4, frequency: 1000, phase: 0, wave_shape: 'sinewave' }));
  });

  it.each(['offset', 'amplitude', 'frequency', 'phase'])('refuses nonfinite SIN export %s', key => {
    const ir = parse('sine\nV1 in 0 SIN(1 2 1k)\nR1 in 0 1k\n.end').toIR();
    ir.components[0].params[key] = Infinity;
    const result = toCircuitJSON(ir);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT', path: `/components/0/params/${key}` }));
  });

  it('refuses peak-to-peak overflow on export', () => {
    const ir = parse('sine\nV1 in 0 SIN(1 2 1k)\nR1 in 0 1k\n.end').toIR();
    ir.components[0].params.amplitude = Number.MAX_VALUE;
    expect(toCircuitJSON(ir).value).toBeUndefined();
    expect(toCircuitJSON(ir).diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT', path: '/components/0/params/amplitude' }));
  });

  it.each(['delay', 'damping', 'dc', 'ac', 'extra'])('diagnoses nonrepresentable SIN %s without dropping it silently', key => {
    const ir = parse('sine\nV1 in 0 SIN(1 2 1k)\nR1 in 0 1k\n.end').toIR();
    ir.components.find(c => c.type === 'V')!.params[key] = 0.5;
    for (const allowLossy of [false, true]) {
      const result = toCircuitJSON(ir, { allowLossy });
      expect(result.lossy).toBe(true);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT', path: `/components/0/params/${key}` }));
      if (!allowLossy) expect(result.value).toBeUndefined();
    }
  });

  it.each(['frequency', 'peak_to_peak_voltage', 'phase', 'voltage'])('rejects invalid sine %s', key => {
    for (const value of [null, '1k', NaN, Infinity]) {
      const result = fromCircuitJSON(source({ ...sine, [key]: value }));
      expect(result.value).toBeUndefined();
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}` }));
    }
  });

  it.each(['frequency', 'peak_to_peak_voltage'])('requires explicit sine %s', key => {
    const fields: Record<string, unknown> = { ...sine };
    delete fields[key];
    expect(fromCircuitJSON(source(fields)).value).toBeUndefined();
  });

  it('defaults omitted phase to zero and preserves zero/negative offsets and amplitude', () => {
    const result = fromCircuitJSON(source({ voltage: -1, wave_shape: 'sinewave', peak_to_peak_voltage: 0, frequency: 0 }));
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.components[0].params).toEqual({ waveform: 'sin', offset: -1, amplitude: 0, frequency: 0, phase: 0 });
  });
});
