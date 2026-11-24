import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: (type === 'G' ? ['outP', 'outN', 'ctrlP', 'ctrlN'] : ['p', 'n'])[i]!, net })), params,
});
function document(gm = 0.001): SpiceTsCircuitDocumentV1 {
  return { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'ref', 'out', 'other'], components: [
    component('V', 'V1', ['in', '0'], { dc: 3 }),
    component('V', 'V2', ['ref', '0'], { dc: 1 }),
    component('G', 'G1', ['out', 'other', 'in', 'ref'], { gm }),
    component('R', 'R1', ['out', '0'], { resistance: 1000 }),
    component('R', 'R2', ['other', '0'], { resistance: 2000 }),
  ] }, analyses: [{ type: 'op' }] };
}
const request = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });
const error = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe('native WASM JSON VCCS', () => {
  it.each([0.001, -0.001, 0])('matches OP for gm %s', async gm => {
    const doc = document(gm);
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(doc), { requestId: 'op' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const actual = result.data.analyses[0];
      const core = (await simulateProtocolV1(request(doc))).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 3\nV2 ref 0 1\nG1 out other in ref ${gm}\nR1 out 0 1k\nR2 other 0 2k\n.op` } }, { requestId: 'text' });
      if (!text.ok || actual?.type !== 'op' || core?.type !== 'op' || text.data.analyses[0]?.type !== 'op') throw new Error('Expected OP');
      expect(error(actual.voltagesV.out!, -2 * gm * 1000)).toBeLessThanOrEqual(1e-9);
      expect(error(actual.voltagesV.other!, 2 * gm * 2000)).toBeLessThanOrEqual(1e-9);
      for (const reference of [core, text.data.analyses[0]]) for (const [name, value] of Object.entries(reference.voltagesV)) expect(error(actual.voltagesV[name]!, value)).toBeLessThanOrEqual(1e-9);
    } finally { await wasm.close(); }
  });

  it.each([0.001, -0.001, 0])('matches complex AC transfer with gm %s', async gm => {
    const doc = document(gm);
    doc.circuit.components = [
      component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 }),
      component('R', 'R1', ['in', 'ref'], { resistance: 1000 }),
      component('C', 'C1', ['ref', '0'], { capacitance: 1e-6 }),
      component('G', 'G1', ['0', 'out', 'ref', 'in'], { gm }),
      component('R', 'R2', ['out', '0'], { resistance: 1000 }),
    ];
    doc.analyses = [{ type: 'ac', variation: 'dec', points: 5, startFreq: 10, stopFreq: 10000 }];
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(doc), { requestId: 'ac' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const actual = result.data.analyses[0];
      const core = (await simulateProtocolV1(request(doc))).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 AC 1\nR1 in ref 1k\nC1 ref 0 1u\nG1 0 out ref in ${gm}\nR2 out 0 1k\n.ac dec 5 10 10000` } }, { requestId: 'text' });
      if (!text.ok || actual?.type !== 'ac' || core?.type !== 'ac' || text.data.analyses[0]?.type !== 'ac') throw new Error('Expected AC');
      if (gm !== 0) expect(actual.voltagePhasors.out![0]!.magnitude).toBeGreaterThan(0);
      for (const [i, frequency] of actual.frequencyHz.entries()) {
        const x = 2 * Math.PI * frequency * 0.001;
        const out = actual.voltagePhasors.out![i]!;
        expect(error(out.magnitude * Math.cos(out.phaseDegrees * Math.PI / 180), -gm * 1000 * x * x / (1 + x * x))).toBeLessThanOrEqual(1e-9);
        expect(error(out.magnitude * Math.sin(out.phaseDegrees * Math.PI / 180), -gm * 1000 * x / (1 + x * x))).toBeLessThanOrEqual(1e-9);
      }
      for (const reference of [core, text.data.analyses[0]]) {
        expect(actual.frequencyHz).toEqual(reference.frequencyHz);
        for (const [name, samples] of Object.entries(reference.voltagePhasors)) for (const [i, sample] of samples.entries()) for (const trig of [Math.cos, Math.sin]) {
          const a = actual.voltagePhasors[name]![i]!;
          expect(error(a.magnitude * trig(a.phaseDegrees * Math.PI / 180), sample.magnitude * trig(sample.phaseDegrees * Math.PI / 180))).toBeLessThanOrEqual(1e-9);
        }
      }
    } finally { await wasm.close(); }
  });

  it('preserves structured validation and resource errors', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const missing = document(); missing.circuit.components[2]!.ports.pop();
      const extra = document(); extra.circuit.components[2]!.ports.push({ name: 'extra', net: '0' });
      const duplicate = document(); duplicate.circuit.components[2]!.ports[2]!.name = 'outP';
      const mixed = document(); mixed.circuit.components[2]!.ports[2]!.name = 'other';
      const unknown = document(); unknown.circuit.components[2]!.ports[2]!.net = 'missing';
      const extraParam = document(); extraParam.circuit.components[2]!.params.extra = 1;
      for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
        for (const doc of [missing, extra, duplicate, mixed, unknown]) {
          expect(await execute(request(doc), { requestId: 'invalid' })).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
        }
        for (const gm of [NaN, Infinity, -Infinity]) {
          expect(await execute(request(document(gm)), { requestId: 'nonfinite' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        }
        expect(await execute(request(extraParam), { requestId: 'extra' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'device-parameters' } } });
        expect(await execute({ ...request(document()), options: { limits: { maxComponents: 4 } } }, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxComponents' } } });
      }
    } finally { await wasm.close(); }
  });
});
