import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, p: string, n: string, params: Record<string, number>) => ({
  type, name, id: name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params,
});
const document: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', 'in', '0', { dc: 12 }),
    component('R', 'R1', 'in', 'out', { resistance: 2000 }),
    component('C', 'C1', 'out', '0', { capacitance: 1e-6 }),
  ] }, analyses: [{ type: 'op' }],
};
const request = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });

const fixtures = [
  { name: 'RC divider', components: [component('R', 'R2', 'out', '0', { resistance: 1000 }), component('C', 'C1', 'out', '0', { capacitance: 1e-6 })], text: 'R2 out 0 1k\nC1 out 0 1u', out: 4, source: -0.004 },
  { name: 'series RL', components: [component('L', 'L1', 'out', '0', { inductance: 0.01 })], text: 'L1 out 0 10m', out: 0, source: -0.006, branch: 0.006 },
  { name: 'series RLC', components: [component('L', 'L1', 'out', 'mid', { inductance: 0.01 }), component('R', 'R2', 'mid', '0', { resistance: 1000 }), component('C', 'C1', 'mid', '0', { capacitance: 1e-6 })], text: 'L1 out mid 10m\nR2 mid 0 1k\nC1 mid 0 1u', out: 4, source: -0.004, branch: 0.004 },
  { name: 'reversed L', components: [component('L', 'L1', '0', 'out', { inductance: 0.01 })], text: 'L1 0 out 10m', out: 0, source: -0.006, branch: -0.006 },
];

describe('numeric WASM native reactive operating points', () => {
  it.each(fixtures)('matches core and text for $name', async fixture => {
    const doc: SpiceTsCircuitDocumentV1 = { ...document, circuit: { nets: ['in', 'out', 'mid'], components: [...document.circuit.components.slice(0, 2), ...fixture.components] } };
    const native = request(doc);
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.validate(native, { requestId: 'native' })).toMatchObject({ ok: true });
      const result = await wasm.simulate(native, { requestId: 'native' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const actual = result.data.analyses[0];
      const core = (await simulateProtocolV1(native)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 12\nR1 in out 2k\n${fixture.text}\n.op` } }, { requestId: 'text' });
      expect(text, JSON.stringify(text)).toMatchObject({ ok: true });
      if (!text.ok || actual?.type !== 'op' || core?.type !== 'op' || text.data.analyses[0]?.type !== 'op') throw new Error('Expected OP');
      expect(actual.voltagesV.out).toBeCloseTo(fixture.out, 9);
      expect(actual.currentsA.V1).toBeCloseTo(fixture.source, 12);
      if (fixture.branch !== undefined) expect(actual.currentsA.L1).toBeCloseTo(fixture.branch, 12);
      let maxError = 0;
      for (const ref of [core, text.data.analyses[0]]) for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(ref[field]).sort());
        for (const [name, value] of Object.entries(ref[field])) {
          const error = Math.abs(actual[field][name]! - value);
          maxError = Math.max(maxError, error);
          expect(error, `${fixture.name} ${field}.${name}`).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(value)));
        }
      }
      process.stdout.write(`reactive parity ${JSON.stringify({ name: fixture.name, out: actual.voltagesV.out, currents: actual.currentsA, maxError })}\n`);
    } finally { await wasm.close(); }
  });
  it.each([['C', 'capacitance'], ['L', 'inductance']] as const)('rejects invalid %s parameters', async (type, key) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const missing = { ...document, circuit: { ...document.circuit, components: [...document.circuit.components.slice(0, 2), component(type, `${type}1`, 'out', '0', {})] } };
      expect(await wasm.validate(request(missing), { requestId: 'missing-value' })).toMatchObject({ ok: false });
      for (const value of [0, -1, Number.NaN, Infinity, -Infinity]) {
        const doc = { ...document, circuit: { ...document.circuit, components: [...document.circuit.components.slice(0, 2), component(type, `${type}1`, 'out', '0', { [key]: value })] } };
        for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
          const result = await execute(request(doc), { requestId: 'bad-value' });
          expect(result.ok, `${type} ${value}: ${JSON.stringify(result)}`).toBe(false);
        }
      }
    } finally { await wasm.close(); }
  });

  it('preserves limits, unknown-net, singular and unsupported boundaries', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const run = (doc: SpiceTsCircuitDocumentV1, options?: SimulationRequestV1['options']) => wasm.simulate({ ...request(doc), options }, { requestId: 'boundary' });
      for (const limit of ['maxSourceBytes', 'maxComponents', 'maxSerializedResultBytes'] as const) {
        expect(await run(document, { limits: { [limit]: 1 } })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit } } });
      }
      const unknown = { ...document, circuit: { ...document.circuit, components: [...document.circuit.components, component('L', 'L1', 'missing', '0', { inductance: 1 })] } };
      expect(await run(unknown)).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
      expect(await wasm.validate(request(unknown), { requestId: 'unknown' })).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
      const many = { ...document, circuit: { nets: ['a'], components: Array.from({ length: 64 }, (_, i) => component('L', `L${i}`, 'a', '0', { inductance: 1 })) } };
      expect(await run(many)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder', observed: 65 } } });
      const singular = { ...document, circuit: { nets: ['a'], components: [component('L', 'L1', 'a', '0', { inductance: 1 }), component('L', 'L2', 'a', '0', { inductance: 1 })] } };
      expect(await run(singular)).toMatchObject({ ok: false, error: { code: 'SINGULAR_MATRIX' } });
      const analysis = { ...document, analyses: [{ type: 'dc', source: 'V1', start: 0, stop: 1, step: 1 }] } as SpiceTsCircuitDocumentV1;
      expect(await run(analysis)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'analysis' } } });
      const model = { ...document, circuit: { ...document.circuit, components: document.circuit.components.map(c => c.type === 'C' ? { ...c, model: 'CMOD' } : c) } };
      expect(await run(model)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'device' } } });
      const extra = { ...document, circuit: { ...document.circuit, components: document.circuit.components.map(c => c.type === 'C' ? { ...c, params: { ...c.params, ic: 1 } } : c) } };
      expect(await run(extra)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'device-parameters' } } });
    } finally { await wasm.close(); }
  });

  it('treats a capacitor as open in an RC operating point', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const native = request(document);
      const validation = await wasm.validate(native, { requestId: 'rc' });
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
      const actual = await wasm.simulate(native, { requestId: 'rc' });
      expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!actual.ok) throw new Error(actual.error.message);
      const op = actual.data.analyses[0];
      const core = (await simulateProtocolV1(native)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 12\nR1 in out 2k\nC1 out 0 1u\n.op' } }, { requestId: 'text' });
      if (!text.ok || op?.type !== 'op' || core?.type !== 'op' || text.data.analyses[0]?.type !== 'op') throw new Error('Expected OP');
      expect(op.voltagesV.out).toBeCloseTo(12, 9);
      expect(op.currentsA.V1).toBeCloseTo(0, 12);
      for (const reference of [core, text.data.analyses[0]]) for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(op[field]).sort()).toEqual(Object.keys(reference[field]).sort());
        for (const [name, value] of Object.entries(reference[field])) expect(Math.abs(op[field][name]! - value)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(value)));
      }
    } finally { await wasm.close(); }
  });
});
