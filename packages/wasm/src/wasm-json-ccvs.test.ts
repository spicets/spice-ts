import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: (type === 'H' ? ['outP', 'outN'] : ['p', 'n'])[i]!, net })), params,
});
function document(gain = 2): SpiceTsCircuitDocumentV1 {
  return { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'sense', 'out'], components: [
    component('H', 'H1', ['out', '0'], { gain, controlSource: 'Vsense' }),
    component('V', 'Vdrive', ['in', '0'], { dc: 3 }),
    component('R', 'Rin', ['in', 'sense'], { resistance: 1000 }),
    component('V', 'Vsense', ['sense', '0'], { dc: 0 }),
    component('R', 'Rload', ['out', '0'], { resistance: 2000 }),
  ] }, analyses: [{ type: 'op' }] };
}
const request = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });

describe('native WASM JSON CCVS', () => {
  it('matches core OP with a forward-referenced current sensor', async () => {
    const doc = document();
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(doc), { requestId: 'op' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const actual = result.data.analyses[0];
      const core = (await simulateProtocolV1(request(doc))).analyses[0];
      if (actual?.type !== 'op' || core?.type !== 'op') throw new Error('Expected OP');
      expect(actual.voltagesV.out).toBeCloseTo(0.006, 9);
      expect(actual.currentsA.Vsense).toBeCloseTo(0.003, 12);
      expect(actual.voltagesV.out).toBeCloseTo(core.voltagesV.out!, 9);
    } finally { await wasm.close(); }
  });

  it.each([2, -2, 0].flatMap(gain => [false, true].map(differential => [gain, differential] as const)))('matches OP and complex AC for gain %s, differential %s', async (gain, differential) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    const compare = (actual: number, expected: number) => {
      const difference = Math.abs(actual - expected);
      expect(difference).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
    };
    try {
      for (const ac of [false, true]) {
        const doc = document(gain);
        if (differential) {
          doc.circuit.nets.push('return');
          doc.circuit.components[0]!.ports[1]!.net = 'return';
          doc.circuit.components.push(component('R', 'Rreturn', ['return', '0'], { resistance: 1000 }));
        }
        // Reversed named ports must not change their electrical interpretation.
        doc.circuit.components[0]!.ports.reverse();
        doc.circuit.components[0]!.params.controlSource = 'vSENSE';
        if (ac) {
          doc.circuit.components[1]!.params = { waveform: 'ac', magnitude: 2, phase: 30 };
          doc.analyses = [{ type: 'ac', variation: 'dec', points: 5, startFreq: 10, stopFreq: 10000 }];
        }
        const result = await wasm.simulate(request(doc), { requestId: 'native' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
        if (!result.ok) throw new Error(result.error.message);
        const core = (await simulateProtocolV1(request(doc))).analyses[0];
        const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `Vdrive in 0 ${ac ? 'AC 2 30' : '3'}\nRin in sense 1k\nVsense sense 0 0\nH1 out ${differential ? 'return' : '0'} vSENSE ${gain}\nRload out 0 2k\n${differential ? 'Rreturn return 0 1k\n' : ''}\n${ac ? '.ac dec 5 10 10000' : '.op'}` } }, { requestId: 'text' });
        if (!text.ok) throw new Error(JSON.stringify(text.error));
        const actual = result.data.analyses[0];
        const referenceText = text.data.analyses[0];
        if (actual?.type === 'op' && core?.type === 'op' && referenceText?.type === 'op') {
          // Isense = 3/1000 A. The differential return and load form a 1k/2k divider.
          compare(actual.voltagesV.out!, 0.003 * gain * (differential ? 2 / 3 : 1));
          if (differential) compare(actual.voltagesV.return!, -0.003 * gain / 3);
          compare(actual.currentsA.H1!, -0.003 * gain / (differential ? 3000 : 2000));
          compare(actual.currentsA.Vsense!, 0.003);
          for (const reference of [core, referenceText]) for (const field of ['voltagesV', 'currentsA'] as const) {
            expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
            for (const [name, value] of Object.entries(reference[field])) compare(actual[field][name]!, value);
          }
        } else if (actual?.type === 'ac' && core?.type === 'ac' && referenceText?.type === 'ac') {
          for (const reference of [core, referenceText]) {
            expect(actual.frequencyHz).toEqual(reference.frequencyHz);
            for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
              expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
              for (const [name, samples] of Object.entries(reference[field])) {
                expect(actual[field][name]).toHaveLength(samples.length);
                samples.forEach((sample, i) => {
                  const observed = actual[field][name]![i]!;
                  for (const trig of [Math.cos, Math.sin]) compare(observed.magnitude * trig(observed.phaseDegrees * Math.PI / 180), sample.magnitude * trig(sample.phaseDegrees * Math.PI / 180));
                });
              }
            }
          }
          for (const [i] of actual.frequencyHz.entries()) for (const [field, name, value] of [['voltagePhasors', 'out', 0.002 * gain * (differential ? 2 / 3 : 1)], ['currentPhasors', 'H1', -0.002 * gain / (differential ? 3000 : 2000)], ['currentPhasors', 'Vsense', 0.002]] as const) {
            const sample = actual[field][name]![i]!;
            compare(sample.magnitude * Math.cos(sample.phaseDegrees * Math.PI / 180), value * Math.cos(Math.PI / 6));
            compare(sample.magnitude * Math.sin(sample.phaseDegrees * Math.PI / 180), value * Math.sin(Math.PI / 6));
          }
        } else throw new Error('Expected matching analyses');
      }
    } finally { await wasm.close(); }
  }, 120000);

  it('supports positional output ports', async () => {
    const doc = document();
    doc.circuit.components[0]!.ports = [{ name: 'first', net: 'out' }, { name: 'second', net: '0' }];
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(doc), { requestId: 'positional' });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const op = result.data.analyses[0];
      if (op?.type !== 'op') throw new Error('Expected OP');
      expect(op.voltagesV.out).toBeCloseTo(0.006, 9);
    } finally { await wasm.close(); }
  });

  it('rejects invalid devices and preserves structured resource limits', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const invalid: SpiceTsCircuitDocumentV1[] = [];
      for (const source of ['', 'missing', 'Rin']) { const doc = document(); doc.circuit.components[0]!.params.controlSource = source; invalid.push(doc); }
      { const doc = document(); delete doc.circuit.components[0]!.params.controlSource; invalid.push(doc); }
      { const doc = document(); delete doc.circuit.components[0]!.params.gain; invalid.push(doc); }
      { const doc = document(); doc.circuit.components[0]!.params.gain = 'bad'; invalid.push(doc); }
      { const doc = document(); doc.circuit.components[0]!.ports.pop(); invalid.push(doc); }
      { const doc = document(); doc.circuit.components[0]!.ports[0]!.net = 'unknown'; invalid.push(doc); }
      { const doc = document(); doc.circuit.components[0]!.ports[1]!.name = 'outP'; invalid.push(doc); }
      { const doc = document(); doc.circuit.components[0]!.ports[1]!.name = 'other'; invalid.push(doc); }
      for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
        for (const doc of invalid) {
          const result = await execute(request(doc), { requestId: 'invalid' });
          expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
        }
        for (const gain of [NaN, Infinity, -Infinity]) expect(await execute(request(document(gain)), { requestId: 'invalid' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        const extra = document(); extra.circuit.components[0]!.params.extra = 1;
        expect(await execute(request(extra), { requestId: 'extra' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
        const model = document(); model.circuit.components[0]!.model = 'bad';
        expect(await execute(request(model), { requestId: 'model' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
        expect(await execute({ ...request(document()), options: { limits: { maxComponents: 4 } } }, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxComponents' } } });
        expect(await execute({ ...request(document()), options: { limits: { maxSourceBytes: 10 } } }, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSourceBytes' } } });
      }
      expect(await wasm.simulate({ ...request(document()), options: { limits: { maxSerializedResultBytes: 10 } } }, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } });
      const oversized = document();
      for (let i = 0; i < 65; i++) {
        const net = `extra${i}`;
        oversized.circuit.nets.push(net);
        oversized.circuit.components.push(component('R', `Rextra${i}`, [net, '0'], { resistance: 1000 }));
      }
      expect(await wasm.simulate(request(oversized), { requestId: 'order' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder' } } });
      const unsupportedAnalysis = document();
      unsupportedAnalysis.analyses = [{ type: 'tran', timestep: 1e-6, stopTime: 1e-3 }];
      const rejected = await wasm.simulate(request(unsupportedAnalysis), { requestId: 'tran' });
      expect(rejected, JSON.stringify(rejected)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
      const multiple = document(); multiple.analyses.push({ type: 'op' });
      expect(await wasm.simulate(request(multiple), { requestId: 'multiple' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
    } finally { await wasm.close(); }
  }, 180000);
});
