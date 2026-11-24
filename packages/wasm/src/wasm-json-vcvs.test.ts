import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: (type === 'E' ? ['outP', 'outN', 'ctrlP', 'ctrlN'] : ['p', 'n'])[i]!, net })), params,
});
function document(gain = 2): SpiceTsCircuitDocumentV1 {
  return { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'ref', 'out'], components: [
    component('V', 'V1', ['in', '0'], { dc: 3 }),
    component('V', 'V2', ['ref', '0'], { dc: 1 }),
    component('E', 'E1', ['out', '0', 'in', 'ref'], { gain }),
    component('R', 'R1', ['out', '0'], { resistance: 1000 }),
  ] }, analyses: [{ type: 'op' }] };
}
function request(doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 { return { apiVersion: '1', input: { format: 'spice-ts', document: doc } }; }

describe('native WASM JSON VCVS', () => {
  it.each([[2, 'ref'], [-2, 'ref'], [0, 'ref'], [2, '0'], [-2, '0'], [0, '0']] as const)('solves gain %s with control reference %s', async (gain, ref) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const doc = document(gain);
      doc.circuit.components[2]!.ports[3]!.net = ref;
      const native = request(doc);
      const result = await wasm.simulate(native, { requestId: 'vcvs' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const actual = result.data.analyses[0];
      const core = (await simulateProtocolV1(native)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 3\nV2 ref 0 1\nE1 out 0 in ${ref} ${gain}\nR1 out 0 1k\n.op` } }, { requestId: 'text' });
      if (!text.ok || actual?.type !== 'op' || core?.type !== 'op' || text.data.analyses[0]?.type !== 'op') throw new Error('Expected OP');
      expect(actual.voltagesV.out).toBeCloseTo(gain * (ref === 'ref' ? 2 : 3), 9);
      for (const reference of [core, text.data.analyses[0]]) for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
        for (const [name, value] of Object.entries(reference[field])) expect(Math.abs(actual[field][name]! - value)).toBeLessThanOrEqual(1e-9 + 1e-9 * Math.abs(value));
      }
    } finally { await wasm.close(); }
  });

  it('matches all complex AC samples for an inverting differential RC stage', async () => {
    const doc = document(-2);
    doc.circuit.components = [
      component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 }),
      component('R', 'R1', ['in', 'ref'], { resistance: 1000 }),
      component('C', 'C1', ['ref', '0'], { capacitance: 1e-6 }),
      component('E', 'E1', ['out', '0', 'in', 'ref'], { gain: -2 }),
      component('R', 'R2', ['out', '0'], { resistance: 1000 }),
    ];
    doc.analyses = [{ type: 'ac', variation: 'dec', points: 5, startFreq: 10, stopFreq: 10000 }];
    const native = request(doc);
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(native, { requestId: 'ac' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const core = (await simulateProtocolV1(native)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 AC 1\nR1 in ref 1k\nC1 ref 0 1u\nE1 out 0 in ref -2\nR2 out 0 1k\n.ac dec 5 10 10000' } }, { requestId: 'text-ac' });
      const actual = result.data.analyses[0];
      if (!text.ok || actual?.type !== 'ac' || core?.type !== 'ac' || text.data.analyses[0]?.type !== 'ac') throw new Error('Expected AC');
      expect(actual.voltagePhasors.out![0]!.magnitude).toBeGreaterThan(0);
      for (const reference of [core, text.data.analyses[0]]) {
        expect(actual.frequencyHz).toEqual(reference.frequencyHz);
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
          for (const [name, samples] of Object.entries(reference[field])) {
            expect(actual[field][name]).toHaveLength(samples.length);
            for (const [i, sample] of samples.entries()) for (const trig of [Math.cos, Math.sin]) {
              const a = actual[field][name]![i]!;
              const observed = a.magnitude * trig(a.phaseDegrees * Math.PI / 180);
              const expected = sample.magnitude * trig(sample.phaseDegrees * Math.PI / 180);
              expect(Math.abs(observed - expected)).toBeLessThanOrEqual(1e-8 + 1e-8 * Math.abs(expected));
            }
          }
        }
      }
    } finally { await wasm.close(); }
  });

  it('honours core positional port ordering when names are not semantic', async () => {
    const doc = document();
    doc.circuit.components[2]!.ports = ['in', 'ref', 'out', '0'].map((net, i) => ({ name: `port${i}`, net }));
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(doc), { requestId: 'positional' });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const op = result.data.analyses[0];
      if (op?.type !== 'op') throw new Error('Expected OP');
      expect(op.voltagesV.out).toBeCloseTo(4, 9);
    } finally { await wasm.close(); }
  });

  it('returns structured errors for invalid ports, gain and resource limits', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const missingPort = document(); missingPort.circuit.components[2]!.ports.pop();
      const missingNet = document(); missingNet.circuit.components[2]!.ports[2]!.net = 'missing';
      const duplicatePort = document(); duplicatePort.circuit.components[2]!.ports[2]!.name = 'outP';
      const partialPort = document(); partialPort.circuit.components[2]!.ports[2]!.name = 'other';
      for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
        for (const doc of [missingPort, missingNet, duplicatePort, partialPort]) {
          const result = await execute(request(doc), { requestId: 'invalid' });
          expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
        }
        for (const gain of [Infinity, -Infinity, NaN]) {
          const result = await execute(request(document(gain)), { requestId: 'invalid-gain' });
          expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        }
        const limited = await execute({ ...request(document()), options: { limits: { maxComponents: 3 } } }, { requestId: 'limited' });
        expect(limited).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxComponents' } } });
      }
    } finally { await wasm.close(); }
  });
});
