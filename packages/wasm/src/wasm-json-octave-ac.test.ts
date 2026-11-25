import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import Ajv2020 from 'ajv/dist/2020.js';
import { protocolSchemasV1 } from '@spice-ts/core/protocol';
import { checkConformanceV1, type AcResultV1, type SimulationRequestV1, type SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: i === 0 ? 'p' : 'n', net })), params });
const v = component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 });
const r = component('R', 'R1', ['in', 'out'], { resistance: 1000 });
const c = component('C', 'C1', ['out', '0'], { capacitance: 1e-6 });
const l = component('L', 'L1', ['out', 'end'], { inductance: 0.1 });
const fixtures = [
  { name: 'RC voltage', components: [v, r, c], source: 'V1 in 0 AC 1\nR1 in out 1000\nC1 out 0 1e-6' },
  { name: 'RL voltage', components: [v, r, component('L', 'L1', ['out', '0'], { inductance: 0.1 })], source: 'V1 in 0 AC 1\nR1 in out 1000\nL1 out 0 0.1' },
  { name: 'RLC voltage', components: [v, r, l, component('C', 'C1', ['end', '0'], { capacitance: 1e-6 })], source: 'V1 in 0 AC 1\nR1 in out 1000\nL1 out end 0.1\nC1 end 0 1e-6' },
  { name: 'RLC current', components: [component('I', 'I1', ['0', 'in'], { waveform: 'ac', magnitude: 0.001, phase: 30 }), r, l, component('C', 'C1', ['end', '0'], { capacitance: 1e-6 }), component('R', 'R2', ['end', '0'], { resistance: 1000 })], source: 'I1 0 in AC 0.001 30\nR1 in out 1000\nL1 out end 0.1\nC1 end 0 1e-6\nR2 end 0 1000' },
];
function doc(fixture = fixtures[0]!, startFreq = 1, stopFreq = 8, points = 1): SpiceTsCircuitDocumentV1 {
  return { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out', 'end'], components: fixture.components }, analyses: [{ type: 'ac', variation: 'oct', points, startFreq, stopFreq }] };
}
function request(document: SpiceTsCircuitDocumentV1): SimulationRequestV1 { return { apiVersion: '1', input: { format: 'spice-ts', document } }; }
function close(actual: number, expected: number): number {
  const error = Math.abs(actual - expected);
  expect(error, `${actual} vs ${expected}`).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
  return error;
}
function compare(actual: AcResultV1, expected: AcResultV1): number {
  let max = 0;
  expect(actual.frequencyHz).toHaveLength(expected.frequencyHz.length);
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

describe('native WASM octave AC', () => {
  it.each(fixtures)('matches core and byte-identical text WASM for $name via the worker', async fixture => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const native = request(doc(fixture));
      const ajv = new Ajv2020({ strict: true });
      for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
      expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', native), JSON.stringify(ajv.errors)).toBe(true);
      expect(checkConformanceV1('spice-ts-document', doc(fixture))).toEqual([]);
      expect(wasm.capabilities.analyses).toContain('ac');
      const validation = await wasm.validate(native, { requestId: 'oct-validation' });
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
      const result = await wasm.simulate(native, { requestId: 'oct-simulation' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `${fixture.source}\n.ac oct 1 1 8` } }, { requestId: 'text' });
      if (!text.ok) throw new Error(JSON.stringify(text.error));
      expect(result.metadata.resolvedOptions).toEqual(text.metadata.resolvedOptions);
      const actual = result.data.analyses[0], core = (await simulateProtocolV1(native)).analyses[0], textAc = text.data.analyses[0];
      if (actual?.type !== 'ac' || core?.type !== 'ac' || textAc?.type !== 'ac') throw new Error('expected AC');
      expect(actual.frequencyHz).toEqual([1, 2, 4, 8]);
      if (fixture.name.includes('voltage')) expect(actual.currentPhasors.V1).toBeDefined();
      if (fixture.name !== 'RC voltage') expect(actual.currentPhasors.L1).toBeDefined();
      expect(JSON.stringify(actual)).toBe(JSON.stringify(textAc));
      const coreMax = compare(actual, core), textMax = compare(actual, textAc);
      process.stdout.write(`octave parity ${JSON.stringify({ fixture: fixture.name, coreMax, textMax })}\n`);
      if (fixture.name === 'RC voltage') for (const [i, frequency] of actual.frequencyHz.entries()) {
        const x = 2 * Math.PI * frequency * 1000 * 1e-6;
        const sample = actual.voltagePhasors.out![i]!;
        close(sample.magnitude, 1 / Math.sqrt(1 + x * x));
        close(sample.phaseDegrees, -Math.atan(x) * 180 / Math.PI);
        close(sample.magnitude * Math.cos(sample.phaseDegrees * Math.PI / 180), 1 / (1 + x * x));
        close(sample.magnitude * Math.sin(sample.phaseDegrees * Math.PI / 180), -x / (1 + x * x));
        process.stdout.write(`RC ${frequency}Hz magnitude=${sample.magnitude} phase=${sample.phaseDegrees}\n`);
      }
    } finally { await wasm.close(); }
  });

  it('honors single-point, non-power-of-two stop, and exact result-point limits', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const [input, frequencies] of [[request(doc(fixtures[0], 2, 2)), [2]], [request(doc(fixtures[0], 1, 7)), [1, 2, 4]]] as const) {
        const result = await wasm.simulate(input, { requestId: 'edge' });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        const ac = result.data.analyses[0];
        if (ac?.type !== 'ac') throw new Error('expected AC');
        expect(ac.frequencyHz).toEqual(frequencies);
      }
      for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
        const base = request(doc());
        expect(await execute({ ...base, options: { limits: { maxResultPoints: 4 } } }, { requestId: 'limit-ok' })).toMatchObject({ ok: true });
        expect(await execute({ ...base, options: { limits: { maxResultPoints: 3 } } }, { requestId: 'limit-fail' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } } });
      }
    } finally { await wasm.close(); }
  });

  it('preserves invalid sweep and unsupported feature errors', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const measured = doc();
      measured.analyses[0] = { ...measured.analyses[0]!, measurements: [{ name: 'sample', kind: 'find', vector: 'vm(out)', at: 2 }] } as typeof measured.analyses[0];
      const result = await wasm.simulate(request(measured), { requestId: 'measured-value' });
      expect(result).toMatchObject({ ok: true, data: { analyses: [{ measurements: [{ name: 'sample', value: expect.any(Number) }] }] } });
      for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
        for (const [field, value] of [['startFreq', 0], ['stopFreq', -1], ['points', 0], ['points', 1.5]] as const) {
          const input = doc();
          input.analyses[0] = { ...input.analyses[0]!, [field]: value } as typeof input.analyses[0];
          const result = await execute(request(input), { requestId: 'invalid' });
          expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
        }
        const measured = doc();
        measured.analyses[0] = { ...measured.analyses[0]!, measurements: [{ name: 'sample', kind: 'find', vector: 'vm(out)', at: 2 }] } as typeof measured.analyses[0];
        expect(await execute(request(measured), { requestId: 'measured' })).toMatchObject({ ok: true });
        const unsupportedMeasure = doc();
        unsupportedMeasure.analyses[0] = { ...unsupportedMeasure.analyses[0]!, measurements: [{ name: 'sample', kind: 'avg', vector: 'vm(out)' }] } as typeof unsupportedMeasure.analyses[0];
        expect(await execute(request(unsupportedMeasure), { requestId: 'unsupported-measured' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
        expect(await execute({ ...request(doc()), outputs: ['V(out)'] }, { requestId: 'outputs' })).toMatchObject({ ok: true });
      }
    } finally { await wasm.close(); }
  });
});
