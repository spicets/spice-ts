import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { AcResultV1, SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: i === 0 ? 'p' : 'n', net })), params });
const v = component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 });
const r = component('R', 'R1', ['in', 'out'], { resistance: 1000 });
const c = component('C', 'C1', ['out', '0'], { capacitance: 1e-6 });
const l = component('L', 'L1', ['out', 'end'], { inductance: 0.1 });
const fixtures = [
  { name: 'divider lin', components: [v, r, component('R', 'R2', ['out', '0'], { resistance: 1000 })], source: 'V1 in 0 AC 1\nR1 in out 1k\nR2 out 0 1k', variation: 'lin' as const, analytic: 'divider' },
  { name: 'RC dec', components: [v, r, c], source: 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u', variation: 'dec' as const, analytic: 'rc' },
  { name: 'series RLC lin', components: [v, r, l, component('C', 'C1', ['end', '0'], { capacitance: 1e-6 })], source: 'V1 in 0 AC 1\nR1 in out 1k\nL1 out end 0.1\nC1 end 0 1u', variation: 'lin' as const },
  { name: 'current dec', components: [component('I', 'I1', ['0', 'in'], { waveform: 'ac', magnitude: 0.001, phase: 30 }), r, c, component('R', 'R2', ['out', '0'], { resistance: 1000 })], source: 'I1 0 in AC 0.001 30\nR1 in out 1k\nC1 out 0 1u\nR2 out 0 1k', variation: 'dec' as const },
];
function doc(fixture = fixtures[0]!): SpiceTsCircuitDocumentV1 {
  return { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out', 'end'], components: fixture.components }, analyses: [{ type: 'ac', variation: fixture.variation, points: 5, startFreq: 10, stopFreq: 10000 }] };
}
function request(document: SpiceTsCircuitDocumentV1): SimulationRequestV1 { return { apiVersion: '1', input: { format: 'spice-ts', document } }; }
function close(a: number, b: number): number { const error = Math.abs(a - b); expect(error).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(b))); return error; }
function compare(actual: AcResultV1, expected: AcResultV1): number {
  let max = 0;
  expect(actual.frequencyHz.length).toBe(expected.frequencyHz.length);
  for (const [i, frequency] of expected.frequencyHz.entries()) max = Math.max(max, close(actual.frequencyHz[i]!, frequency));
  for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
    expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(expected[field]).sort());
    for (const [name, samples] of Object.entries(expected[field])) {
      expect(actual[field][name]).toHaveLength(samples.length);
      for (const [i, sample] of samples.entries()) {
        const a = actual[field][name]![i]!;
        for (const trig of [Math.cos, Math.sin]) max = Math.max(max, close(a.magnitude * trig(a.phaseDegrees * Math.PI / 180), sample.magnitude * trig(sample.phaseDegrees * Math.PI / 180)));
      }
    }
  }
  return max;
}

describe('native WASM AC', () => {
  it.each(fixtures)('matches text WASM and core for $name', async fixture => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const native = request(doc(fixture));
      const validation = await wasm.validate(native, { requestId: 'ac' });
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
      const result = await wasm.simulate(native, { requestId: 'ac' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const actual = result.data.analyses[0];
      const core = (await simulateProtocolV1(native)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `${fixture.source}\n.ac ${fixture.variation} 5 10 10000` } }, { requestId: 'text' });
      if (!text.ok) throw new Error(JSON.stringify(text.error));
      const textAc = text.data.analyses[0];
      if (actual?.type !== 'ac' || core?.type !== 'ac' || textAc?.type !== 'ac') throw new Error('expected AC');
      const coreMax = compare(actual, core), textMax = compare(actual, textAc);
      process.stdout.write(`AC parity ${JSON.stringify({ fixture: fixture.name, coreMax, textMax })}\n`);
      for (const [i, frequency] of actual.frequencyHz.entries()) {
        const sample = actual.voltagePhasors.out![i]!;
        if (fixture.analytic === 'divider') { close(sample.magnitude, 0.5); close(sample.phaseDegrees, 0); }
        if (fixture.analytic === 'rc') {
          const x = 2 * Math.PI * frequency * 1000 * 1e-6;
          close(sample.magnitude * Math.cos(sample.phaseDegrees * Math.PI / 180), 1 / (1 + x * x));
          close(sample.magnitude * Math.sin(sample.phaseDegrees * Math.PI / 180), -x / (1 + x * x));
        }
      }
    } finally { await wasm.close(); }
  });

  it('preserves structured errors and limits', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const base = doc();
      const malformed = { ...base, circuit: { ...base.circuit, components: [component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 'bad' }), ...base.circuit.components.slice(1)] } };
      const device = { ...base, circuit: { ...base.circuit, components: [...base.circuit.components, component('D', 'D1', ['out', '0'], {})] } };
      const multi = { ...base, analyses: [...base.analyses, { type: 'op' as const }] };
      const stepped = { ...base, componentSweep: { component: 'R1', values: [1000, 2000] } };
      for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
        const cases: [SimulationRequestV1, string][] = [[request(malformed), 'INVALID_CIRCUIT'], [request(device), 'UNSUPPORTED_FEATURE'], [request(multi), 'RESOURCE_LIMIT'], [request(stepped), 'UNSUPPORTED_FEATURE'], [{ ...request(base), options: { limits: { maxResultPoints: 2 } } }, 'RESOURCE_LIMIT'], [{ ...request(base), options: { limits: { maxComponents: 2 } } }, 'RESOURCE_LIMIT'], [{ ...request(base), options: { limits: { maxSourceBytes: 1 } } }, 'RESOURCE_LIMIT']];
        for (const [input, code] of cases) {
          const result = await execute(input, { requestId: 'error' });
          expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code } });
        }
      }
      const serialized = await wasm.simulate({ ...request(base), options: { limits: { maxSerializedResultBytes: 1 } } }, { requestId: 'serialized' });
      expect(serialized).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } });
    } finally { await wasm.close(); }
  });
});
