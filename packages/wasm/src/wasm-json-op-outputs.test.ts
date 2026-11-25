import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: i === 0 ? 'p' : 'n', net })), params,
});
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', ['in', '0'], { dc: 12 }),
    component('R', 'R1', ['in', 'out'], { resistance: 2000 }),
    component('R', 'R2', ['out', '0'], { resistance: 1000 }),
  ] }, analyses: [{ type: 'op' }],
} } };

const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));

describe('native WASM OP output selection', () => {
  it('selects voltage and branch current without changing numeric values', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const selected = { ...request, outputs: ['V(out)', 'I(V1)'] };
      expect(await wasm.validate(selected, { requestId: 'selected' })).toMatchObject({ ok: true });
      const full = await wasm.simulate(request, { requestId: 'full' });
      const actual = await wasm.simulate(selected, { requestId: 'selected' });
      const core = (await simulateProtocolV1(selected)).analyses[0];
      if (!actual.ok || !full.ok || actual.data.analyses[0]?.type !== 'op' || full.data.analyses[0]?.type !== 'op' || core?.type !== 'op') throw new Error(JSON.stringify(actual));
      const op = actual.data.analyses[0];
      expect(op.voltagesV).toEqual({ out: full.data.analyses[0].voltagesV.out });
      expect(op.currentsA).toEqual({ V1: full.data.analyses[0].currentsA.V1 });
      close(op.voltagesV.out!, core.voltagesV.out!);
      close(op.currentsA.V1!, core.currentsA.V1!);
    } finally { await wasm.close(); }
  });
  it.each([
    [['v(OUT)'], ['out'], []],
    [['i(v1)'], [], ['V1']],
    [['v(OUT)', 'i(v1)', 'V(out)'], ['out'], ['V1']],
  ])('resolves selected names with core case rules: %j', async (outputs, nodes, branches) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const selected = { ...request, outputs };
      const actual = await wasm.simulate(selected, { requestId: 'case' });
      const full = await wasm.simulate(request, { requestId: 'default' });
      const core = (await simulateProtocolV1(selected)).analyses[0];
      if (!actual.ok || !full.ok || actual.data.analyses[0]?.type !== 'op' || full.data.analyses[0]?.type !== 'op' || core?.type !== 'op') throw new Error(JSON.stringify(actual));
      const op = actual.data.analyses[0];
      expect(Object.keys(op.voltagesV)).toEqual(nodes);
      expect(Object.keys(op.currentsA)).toEqual(branches);
      for (const key of nodes) {
        expect(op.voltagesV[key]).toBe(full.data.analyses[0].voltagesV[key]);
        close(op.voltagesV[key]!, core.voltagesV[key]!);
      }
      for (const key of branches) {
        expect(op.currentsA[key]).toBe(full.data.analyses[0].currentsA[key]);
        close(op.currentsA[key]!, core.currentsA[key]!);
      }
      expect(Object.keys(full.data.analyses[0].voltagesV)).toEqual(['in', 'out']);
      expect(Object.keys(full.data.analyses[0].currentsA)).toEqual(['V1']);
    } finally { await wasm.close(); }
  });

  it.each([[], Array(65).fill('V(out)'), ['v()'], ['v(out)\n'], ['v(a,b)'], ['v(' + 'a'.repeat(254) + ')'], [5], null, ['V(nope)'], ['I(R1)']])('rejects invalid selection %j in validation and simulation', async outputs => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const selected = { ...request, outputs } as unknown as SimulationRequestV1;
      const validation = await wasm.validate(selected, { requestId: 'invalid' });
      const simulation = await wasm.simulate(selected, { requestId: 'invalid' });
      expect(validation).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(simulation).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      if (!validation.ok && !simulation.ok) expect(simulation.error).toEqual(validation.error);
    } finally { await wasm.close(); }
  });

  it('enforces input, computation and serialized result limits with selection', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const [limit, value] of [['maxSourceBytes', 1], ['maxComponents', 2], ['maxSerializedResultBytes', 1]] as const) {
        const selected = { ...request, outputs: ['V(out)'], options: { limits: { [limit]: value } } };
        const actual = await wasm.simulate(selected, { requestId: 'limit' });
        expect(actual).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit } } });
        if (limit !== 'maxSerializedResultBytes') expect(await wasm.validate(selected, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit } } });
      }
    } finally { await wasm.close(); }
  });

});
