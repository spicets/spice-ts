import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: (type === 'H' ? ['outP', 'outN'] : ['p', 'n'])[i]!, net })), params,
});
function document(gain = 2): SpiceTsCircuitDocumentV1 {
  return { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'sense', 'out'], components: [
    component('H', 'H1', ['out', '0'], { gain, controlSource: 'vSENSE' }),
    component('V', 'Vdrive', ['in', '0'], { waveform: 'pulse', v1: 0, v2: 3, delay: 0, rise: 0.0001, fall: 0.0001, width: 0.0003, period: 0.0008 }),
    component('R', 'Rin', ['in', 'sense'], { resistance: 1000 }),
    component('V', 'Vsense', ['sense', '0'], { dc: 0 }),
    component('R', 'Rload', ['out', '0'], { resistance: 2000 }),
    component('C', 'Cload', ['out', '0'], { capacitance: 1e-6 }),
  ] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001, maxTimestep: 1e-5 }] };
}
const request = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });
const deck = (gain: number) => `Vdrive in 0 PULSE(0 3 0 100u 100u 300u 800u)\nRin in sense 1000\nVsense sense 0 0\nH1 out 0 Vsense ${gain}\nRload out 0 2000\nCload out 0 1u\n.tran 10u 1m 0 10u`;

it.each([2, -2, 0])('matches text WASM and native core transient traces for gain %s', async gain => {
  const input = request(document(gain));
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(engine.capabilities.numericWasm?.fallback).toBe('reject');
    const actualResult = await engine.simulate(input, { requestId: 'native' });
    expect(actualResult, JSON.stringify(actualResult)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    if (!actualResult.ok) throw new Error(actualResult.error.message);
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: deck(gain) } }, { requestId: 'text' });
    if (!text.ok) throw new Error(JSON.stringify(text));
    const core = await simulateProtocolV1(input);
    const actual = actualResult.data.analyses[0];
    if (actual?.type !== 'tran') throw new Error('transient required');
    for (const reference of [text.data.analyses[0], core.analyses[0]]) {
      if (reference?.type !== 'tran') throw new Error('transient required');
      expect(actual.timeS.length).toBeGreaterThan(10);
      expect(actual.timeS.length).toBe(reference.timeS.length);
      for (const [i, time] of actual.timeS.entries()) expect(Math.abs(time - reference.timeS[i]!)).toBeLessThan(1e-14);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
        for (const [name, values] of Object.entries(actual[field])) for (const [i, value] of values.entries()) {
          const expected = reference[field][name]![i]!;
          expect(Number.isFinite(value) && Number.isFinite(expected)).toBe(true);
          expect(Math.abs(value - expected) / Math.max(Math.abs(expected), 1e-9), `${field}.${name} at ${actual.timeS[i]}`).toBeLessThanOrEqual(0.01);
        }
      }
    }
    if (gain !== 0) expect(Math.max(...actual.voltagesV.out!.map(Math.abs))).toBeGreaterThan(0.001);
  } finally { await engine.close(); }
}, 30000);


it('rejects invalid controls, gains and ports with structured errors', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const invalid: SpiceTsCircuitDocumentV1[] = [];
    for (const control of ['', 'missing', 'Rin']) { const doc = document(); doc.circuit.components[0]!.params.controlSource = control; invalid.push(doc); }
    { const doc = document(); delete doc.circuit.components[0]!.params.controlSource; invalid.push(doc); }
    { const doc = document(); delete doc.circuit.components[0]!.params.gain; invalid.push(doc); }
    { const doc = document(); doc.circuit.components[0]!.params.gain = 'bad'; invalid.push(doc); }
    { const doc = document(); doc.circuit.components[0]!.ports.pop(); invalid.push(doc); }
    { const doc = document(); doc.circuit.components[0]!.ports[0]!.net = 'missing'; invalid.push(doc); }
    { const doc = document(); doc.circuit.components[0]!.ports[1]!.name = 'outP'; invalid.push(doc); }
    { const doc = document(); doc.circuit.components[0]!.ports[1]!.name = 'other'; invalid.push(doc); }
    for (const execute of [engine.validate.bind(engine), engine.simulate.bind(engine)]) {
      for (const doc of invalid) {
        const result = await execute(request(doc), { requestId: 'invalid' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT', phase: 'validation' } });
      }
      for (const gain of [NaN, Infinity, -Infinity]) expect(await execute(request(document(gain)), { requestId: 'nonfinite' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    }
  } finally { await engine.close(); }
}, 30000);

it('preserves output selection, resource limits and cancellation', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request(document());
    const selected = await engine.simulate({ ...input, outputs: ['v(out)', 'i(Vsense)', 'i(H1)'] }, { requestId: 'selected' });
    if (!selected.ok || selected.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify(selected));
    expect(Object.keys(selected.data.analyses[0].voltagesV)).toEqual(['out']);
    expect(Object.keys(selected.data.analyses[0].currentsA).sort()).toEqual(['H1', 'Vsense']);
    for (const [limit, value] of [['maxResultPoints', 2], ['maxSerializedResultBytes', 10]] as const) {
      const result = await engine.simulate({ ...input, options: { limits: { [limit]: value } } }, { requestId: 'limit' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit } } });
    }
    const pending = engine.simulate({ ...input, outputs: ['v(out)'] }, { requestId: 'cancel-ccvs' });
    expect(await engine.cancel('cancel-ccvs')).toEqual({ requestId: 'cancel-ccvs', status: 'cancelling' });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  } finally { await engine.close(); }
}, 30000);
