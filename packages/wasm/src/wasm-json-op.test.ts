import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: i === 0 ? 'p' : 'n', net })), params,
});
const document: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', ['in', '0'], { dc: 12 }),
    component('R', 'R1', ['in', 'out'], { resistance: 2000 }),
    component('R', 'R2', ['out', '0'], { resistance: 1000 }),
  ] }, analyses: [{ type: 'op' }],
};
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document } };

describe('numeric WASM JSON operating point', () => {
  it('explicitly rejects native output selections instead of ignoring them', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const outputs of [['V(out)'], ['V(nope)']]) {
        const selected = { ...request, outputs };
        for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
          expect(await execute(selected, { requestId: 'selection' })).toMatchObject({
            ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'output-selection' } },
          });
        }
      }
    } finally { await wasm.close(); }
  });

  it('counts the complete native input wrapper against maxSourceBytes', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const documentBytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
      const inputBytes = new TextEncoder().encode(JSON.stringify(request.input)).byteLength;
      expect(inputBytes).toBeGreaterThan(documentBytes);
      const limited = { ...request, options: { limits: { maxSourceBytes: documentBytes } } };
      for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
        expect(await execute(limited, { requestId: 'size' })).toMatchObject({
          ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSourceBytes', configured: documentBytes, observed: inputBytes } },
        });
        expect(await execute({ ...limited, options: { limits: { maxSourceBytes: inputBytes } } }, { requestId: 'boundary' })).toMatchObject({ ok: true });
      }
    } finally { await wasm.close(); }
  });
  it('runs a native voltage divider with core and SPICE-text parity', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request, { requestId: 'native-divider' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata.backend).toBe('spice-ts-wasm');
      const result = actual.data.analyses[0];
      const core = (await simulateProtocolV1(request)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 12\nR1 in out 2k\nR2 out 0 1k\n.op' } }, { requestId: 'text-divider' });
      expect(text.ok).toBe(true);
      if (!text.ok || result?.type !== 'op' || core?.type !== 'op' || text.data.analyses[0]?.type !== 'op') throw new Error('Expected OP');
      expect(result.voltagesV.in).toBeCloseTo(12, 9);
      expect(result.voltagesV.out).toBeCloseTo(4, 9);
      expect(result.currentsA.V1).toBeCloseTo(-0.004, 9);
      for (const reference of [core, text.data.analyses[0]]) for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(result[field]).sort()).toEqual(Object.keys(reference[field]).sort());
        for (const [name, value] of Object.entries(reference[field])) {
          expect(Math.abs(result[field][name]! - value)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(value)));
        }
      }
    } finally { await wasm.close(); }
  });

  it.each([1, -1])('preserves independent current-source polarity %s', async sign => {
    const native: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: {
      ...document, circuit: { nets: ['out'], components: [
        component('I', 'I1', ['0', 'out'], { dc: sign * 0.002 }),
        component('R', 'R1', ['out', '0'], { resistance: 2000 }),
      ] },
    } } };
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(native, { requestId: 'current' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const op = actual.data.analyses[0];
      const core = (await simulateProtocolV1(native)).analyses[0];
      if (op?.type !== 'op' || core?.type !== 'op') throw new Error('Expected OP');
      expect(op.voltagesV.out).toBeCloseTo(sign * 4, 9);
      expect(op.voltagesV.out).toBeCloseTo(core.voltagesV.out!, 9);
    } finally { await wasm.close(); }
  });

  it('rejects unsupported devices and analyses and enforces native resource limits', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const run = (doc: SpiceTsCircuitDocumentV1, options?: SimulationRequestV1['options']) => wasm.simulate(
        { apiVersion: '1', input: { format: 'spice-ts', document: doc }, options }, { requestId: 'rejected' });
      const device = await run({ ...document, circuit: { ...document.circuit, components: [component('Z', 'Z1', ['in', '0'], {})] } });
      expect(device).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'device' } } });
      const analysis = await run({ ...document, analyses: [{ type: 'dc', source: 'V1', start: 0, stop: 1, step: 1 }] });
      expect(analysis).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'analysis' } } });
      for (const [limit, value] of [['maxComponents', 2], ['maxSourceBytes', 10], ['maxSerializedResultBytes', 10]] as const) {
        const limited = await run(document, { limits: { [limit]: value } });
        expect(limited).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit } } });
      }
      const manyNodes = Array.from({ length: 65 }, (_, i) => component('R', `R${i}`, [`n${i}`, '0'], { resistance: 1000 }));
      const order = await run({ ...document, circuit: { nets: manyNodes.map((_, i) => `n${i}`), components: manyNodes } });
      expect(order).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder', configured: 64, observed: 65 } } });
      const malformed = await wasm.simulate({ apiVersion: '1', input: { format: 'spice-ts', document: { ...document, circuit: null } } } as unknown as SimulationRequestV1, { requestId: 'malformed' });
      expect(malformed).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    } finally { await wasm.close(); }
  });
});
