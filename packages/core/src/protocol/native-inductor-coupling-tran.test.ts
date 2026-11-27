import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import type { SimulationRequestV1 } from './types.js';

function requests(k: number): [SimulationRequestV1, SimulationRequestV1] {
  const component = (type: string, name: string, a: string, b: string, params: Record<string, number | string>) => ({
    type, id: name, name, ports: [{ name: 'p', net: a }, { name: 'n', net: b }], params,
  });
  const native: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in', 'primary', 'out'], components: [
      { type: 'K', id: 'K1', name: 'K1', ports: [], params: { inductorA: 'l1', inductorB: 'l2', coupling: k } },
      component('V', 'V1', 'in', '0', { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 0.0000152587890625, fall: 0.0000152587890625, width: 0.000244140625, period: 0.0009765625 }),
      component('R', 'Rs', 'in', 'primary', { resistance: 10 }),
      component('L', 'L1', 'primary', '0', { inductance: 0.015625 }),
      component('L', 'L2', 'out', '0', { inductance: 0.0625 }),
      component('R', 'R1', 'out', '0', { resistance: 100 }),
    ] }, analyses: [{ type: 'tran', timestep: 0.0000152587890625, stopTime: 0.001953125 }],
  } } };
  const text: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: `V1 in 0 PULSE(0 1 0 0.0000152587890625 0.0000152587890625 0.000244140625 0.0009765625)\nRs in primary 10\nL1 primary 0 0.015625\nL2 out 0 0.0625\nR1 out 0 100\nK1 L1 L2 ${k}\n.tran 0.0000152587890625 0.001953125\n.end` } };
  return [native, text];
}

describe('native transient inductor coupling', () => {
  it.each([0, 0.8, -0.8])('matches text for k=%s', async k => {
    const [native, text] = requests(k);
    const actual = (await simulateProtocolV1(native)).analyses[0];
    const expected = (await simulateProtocolV1(text)).analyses[0];
    if (actual?.type !== 'tran' || expected?.type !== 'tran') throw new Error('transient required');
    expect(actual.timeS.length).toBeGreaterThan(1);
    expect(actual.timeS).toEqual(expected.timeS);
    const peakSecondary = Math.max(...actual.voltagesV.out!.map(Math.abs));
    if (k === 0) expect(peakSecondary).toBe(0);
    else expect(peakSecondary).toBeGreaterThan(0.1);
    for (const field of ['voltagesV', 'currentsA'] as const) {
      expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(expected[field]).sort());
      for (const [name, values] of Object.entries(actual[field])) {
        const reference = expected[field][name]!;
        expect(values.length).toBe(actual.timeS.length);
        expect(reference.length).toBe(values.length);
        expect([...values, ...reference].every(Number.isFinite)).toBe(true);
        const scale = Math.max(...reference.map(Math.abs), 1e-30);
        const errors = values.map((v, i) => Math.abs(v - reference[i]!) / scale);
        const max = Math.max(...errors);
        const rms = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
        console.info(`k=${k} ${field}.${name}: n=${errors.length} normalizedMax=${max} normalizedRms=${rms}`);
        expect(max, name).toBeLessThanOrEqual(0.01);
        expect(rms, name).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it.each([
    ['inductorA', 'missing', 'inductorA'],
    ['inductorB', 'l1', 'inductorB'],
    ['inductorA', 'Rs', 'inductorA'],
    ...[NaN, Infinity, -Infinity, 1.01, -1.01].map(value => ['coupling', value, 'coupling'] as const),
  ] as const)('rejects invalid %s=%s in transient requests', async (field, value, suffix) => {
    const [request] = requests(0.8);
    if (request.input.format !== 'spice-ts') throw new Error('native required');
    request.input.document.circuit.components[0]!.params[field] = value;
    expect(await executeProtocolV1(request)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/circuit/components/0/params/${suffix}` } } });
  });
});
