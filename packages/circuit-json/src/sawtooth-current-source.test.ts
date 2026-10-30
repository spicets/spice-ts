import { describe, expect, it } from 'vitest';
import type { CircuitJson } from 'circuit-json';
import { Circuit, parse, simulate } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from './index.js';

const source = (fields: Record<string, unknown> = {}): CircuitJson => [{
  type: 'source_component', ftype: 'simple_current_source', source_component_id: 'I1', name: 'I1',
  current: -0.001, wave_shape: 'sawtooth', peak_to_peak_current: 0.004, frequency: 1000, phase: 90, ...fields,
}] as CircuitJson;

describe('sawtooth current sources', () => {
  it('imports a phased sawtooth as a current PULSE', () => {
    const imported = fromCircuitJSON(source());
    expect(imported.diagnostics).toEqual([]);
    expect(imported.value?.components[0]).toMatchObject({ type: 'I', params: {
      waveform: 'pulse', v1: -0.003, v2: 0.001, delay: 0.00025,
      rise: 0.001 - 0.001 * 1e-6, fall: 1e-9, width: 0, period: 0.001,
    } });
  });

  it.each([0.004, -0.004, 0])('round-trips signed amplitude %s through exact generic PULSE parameters', amplitude => {
    const imported = fromCircuitJSON(source({ peak_to_peak_current: amplitude }));
    expect(imported.diagnostics).toEqual([]);
    const params = imported.value!.components[0].params;
    expect(params.v1).toBe(-0.001 - amplitude / 2);
    expect(params.v2).toBe(-0.001 + amplitude / 2);
    const exported = toCircuitJSON(imported.value!);
    expect(exported.diagnostics).toEqual([]);
    const reimported = fromCircuitJSON(exported.value!);
    expect(reimported.diagnostics).toEqual([]);
    expect(reimported.value!.components[0].params).toEqual(params);
  });

  it('defaults phase to zero', () => {
    expect(fromCircuitJSON(source({ phase: undefined })).value!.components[0].params.delay).toBe(0);
  });

  it.each([
    ['current', NaN], ['current', Infinity], ['peak_to_peak_current', undefined], ['peak_to_peak_current', NaN],
    ['peak_to_peak_current', Number.MIN_VALUE], ['frequency', undefined], ['frequency', 0], ['frequency', -1],
    ['frequency', Infinity], ['frequency', Number.MIN_VALUE], ['phase', NaN], ['phase', -1], ['phase', Infinity],
    ['phase', Number.MIN_VALUE], ['duty_cycle', 0.5], ['rise_time', 1],
  ])('diagnoses invalid %s=%s', (key, value) => {
    const result = fromCircuitJSON(source({ [key]: value }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: `/0/${key}`, elementId: 'I1' }));
  });

  it('rejects noncanonical PULSE export even with allowLossy', () => {
    const ir = fromCircuitJSON(source()).value!;
    ir.components[0].params.fall = 2e-9;
    for (const allowLossy of [false, true]) {
      const result = toCircuitJSON(ir, { allowLossy });
      expect(result.lossy).toBe(true);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOSSY_EXPORT', path: '/components/0/params/fall' }));
    }
  });

  it('matches an explicit PULSE on a resistor load at matched sample times', async () => {
    const elements: Record<string, unknown>[] = [
      ...source(),
      { type: 'source_component', ftype: 'simple_resistor', source_component_id: 'R1', name: 'R1', resistance: 1000 },
      { type: 'source_net', source_net_id: 'out', name: 'out', member_source_group_ids: [] },
      { type: 'source_net', source_net_id: '0', name: 'GND', is_ground: true, member_source_group_ids: [] },
    ];
    [['I1', 'p', '0'], ['I1', 'n', 'out'], ['R1', 'p', 'out'], ['R1', 'n', '0']].forEach(([owner, name, net], i) => {
      elements.push({ type: 'source_port', source_port_id: `p${i}`, source_component_id: owner, name });
      elements.push({ type: 'source_trace', source_trace_id: `t${i}`, connected_source_port_ids: [`p${i}`], connected_source_net_ids: [net] });
    });
    const imported = fromCircuitJSON(elements as CircuitJson);
    expect(imported.diagnostics).toEqual([]);
    const part = imported.value!.components.find(c => c.id === 'I1')!;
    expect(part.ports).toEqual([{ name: 'p', net: '0' }, { name: 'n', net: 'out' }]);
    const p = part.params as Record<string, number>;
    const circuit = new Circuit();
    circuit.addCurrentSource('I1', part.ports[0].net, part.ports[1].net, { type: 'pulse', v1: p.v1, v2: p.v2, delay: p.delay, rise: p.rise, fall: p.fall, width: p.width, period: p.period });
    circuit.addResistor('R1', 'out', '0', 1000);
    const suffix = '.tran 10u 2.5m\n.end';
    const deck = `saw current\nI1 0 out PULSE(-3m 1m 250u 999.999u 1n 0 1m)\nR1 out 0 1k\n${suffix}`;
    const actual = (await simulate(circuit.toNetlist().replace(/\.end\s*$/i, suffix))).transient!;
    const direct = (await simulate(deck)).transient!;
    expect(actual.time).toEqual(direct.time);
    const errors = Array.from(actual.voltage('out'), (v, i) => Math.abs(v - direct.voltage('out')[i]));
    expect(Math.max(...errors)).toBeLessThanOrEqual(1e-9);
    expect(actual.voltage('out')[0]).toBeCloseTo(-3, 9);
    const currentSamples = (input: Circuit) => {
      const device = input.compile().devices.find(d => d.name.toLowerCase() === 'i1') as unknown as {
        setTransientTimestep: (step: number, stop: number) => void; getCurrentAtTime: (time: number) => number;
      };
      device.setTransientTimestep(1e-5, 2.5e-3);
      return Array.from(actual.time, time => device.getCurrentAtTime(time));
    };
    const a = currentSamples(circuit);
    const b = currentSamples(parse(deck));
    const currentErrors = a.map((v, i) => Math.abs(v - b[i]));
    expect(Math.max(...currentErrors)).toBeLessThanOrEqual(1e-9);
    process.stdout.write(`saw current samples=${errors.length} voltage max=${Math.max(...errors)} current max=${Math.max(...currentErrors)}\n`);
  });
});
