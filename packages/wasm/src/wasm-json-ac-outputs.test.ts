import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: i === 0 ? 'p' : 'n', net })), params });
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 }),
    component('R', 'R1', ['in', 'out'], { resistance: 1000 }),
    component('C', 'C1', ['out', '0'], { capacitance: 1e-6 }),
  ] }, analyses: [{ type: 'ac', variation: 'dec', points: 5, startFreq: 10, stopFreq: 10000 }],
} } };

describe('native WASM AC output selection', () => {
  it('selects phasors without changing frequency or values', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const selected = { ...request, outputs: ['v(out)', 'i(V1)'] };
      expect(await wasm.validate(selected, { requestId: 'selected' })).toMatchObject({ ok: true });
      const full = await wasm.simulate(request, { requestId: 'full' });
      const actual = await wasm.simulate(selected, { requestId: 'selected' });
      const core = (await simulateProtocolV1(request)).analyses[0];
      if (!actual.ok || !full.ok || actual.data.analyses[0]?.type !== 'ac' || full.data.analyses[0]?.type !== 'ac' || core?.type !== 'ac') throw new Error(JSON.stringify(actual));
      const a = actual.data.analyses[0], b = full.data.analyses[0];
      expect(a.frequencyHz).toEqual(b.frequencyHz);
      expect(a.voltagePhasors).toEqual({ out: b.voltagePhasors.out });
      expect(a.currentPhasors).toEqual({ V1: b.currentPhasors.V1 });
      for (const [field, name] of [['voltagePhasors', 'out'], ['currentPhasors', 'V1']] as const) {
        for (const [i, sample] of a[field][name]!.entries()) {
          const expected = core[field][name]![i]!;
          for (const trig of [Math.cos, Math.sin]) {
            const x = sample.magnitude * trig(sample.phaseDegrees * Math.PI / 180);
            const y = expected.magnitude * trig(expected.phaseDegrees * Math.PI / 180);
            expect(Math.abs(x - y)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(y)));
          }
        }
      }
    } finally { await wasm.close(); }
  });
  it.each([
    [['v(OUT)'], ['out'], []],
    [['i(v1)'], [], ['V1']],
    [['V(OUT)', 'i(v1)', 'v(out)', 'I(V1)'], ['out'], ['V1']],
  ])('uses OP case and deduplication semantics: %j', async (outputs, nodes, branches) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const full = await wasm.simulate(request, { requestId: 'full' });
      const actual = await wasm.simulate({ ...request, outputs }, { requestId: 'case' });
      if (!actual.ok || !full.ok || actual.data.analyses[0]?.type !== 'ac' || full.data.analyses[0]?.type !== 'ac') throw new Error(JSON.stringify(actual));
      expect(Object.keys(actual.data.analyses[0].voltagePhasors)).toEqual(nodes);
      expect(Object.keys(actual.data.analyses[0].currentPhasors)).toEqual(branches);
      expect(Object.keys(full.data.analyses[0].voltagePhasors).sort()).toEqual(['in', 'out']);
      expect(Object.keys(full.data.analyses[0].currentPhasors)).toEqual(['V1']);
    } finally { await wasm.close(); }
  });

  it.each([
    [[], '/outputs'], [Array(65).fill('v(out)'), '/outputs'], [null, '/outputs'],
    [['v(out)', 'v(missing)'], '/outputs/1'], [['i(R1)'], '/outputs/0'],
    [['v(a,b)'], '/outputs/0'], [[5], '/outputs/0'], [['v(out)\n'], '/outputs/0'],
  ])('rejects invalid selectors deterministically: %j', async (outputs, path) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = { ...request, outputs } as unknown as SimulationRequestV1;
      const validation = await wasm.validate(input, { requestId: 'invalid' });
      const simulation = await wasm.simulate(input, { requestId: 'invalid' });
      expect(validation).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
      expect(simulation).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
      if (!validation.ok && !simulation.ok) {
        expect(simulation.error).toEqual(validation.error);
        const details = validation.error.details;
        expect(details?.path === path || (Array.isArray(details?.errors) && details.errors.some(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry.path === path))).toBe(true);
      }
    } finally { await wasm.close(); }
  });

  it('evaluates measurements before projection and enforces bytes after projection', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const measured = structuredClone(request);
      if (measured.input.format !== 'spice-ts') throw new Error('expected native');
      Object.assign(measured.input.document.analyses[0]!, { measurements: [{ name: 'source', kind: 'find', vector: 'vm(in)', at: 1000 }] });
      const full = await wasm.simulate(measured, { requestId: 'full' });
      const selected = await wasm.simulate({ ...measured, outputs: ['v(out)'] }, { requestId: 'selected' });
      if (!full.ok || !selected.ok || full.data.analyses[0]?.type !== 'ac' || selected.data.analyses[0]?.type !== 'ac') throw new Error(JSON.stringify(selected));
      expect(selected.data.analyses[0].measurements).toEqual(full.data.analyses[0].measurements);
      expect(selected.data.analyses[0].measurements).toEqual([{ name: 'source', value: 1 }]);
      expect(selected.data.analyses[0].voltagePhasors.in).toBeUndefined();
      const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).byteLength;
      const selectedBytes = bytes(selected.data), fullBytes = bytes(full.data);
      expect(selectedBytes).toBeLessThan(fullBytes);
      process.stdout.write(`AC output bytes: selected=${selectedBytes} full=${fullBytes}\n`);
      const options = { limits: { maxSerializedResultBytes: selectedBytes } };
      expect(await wasm.simulate({ ...measured, outputs: ['v(out)'], options }, { requestId: 'limit' })).toMatchObject({ ok: true });
      expect(await wasm.simulate({ ...measured, options }, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } });
    } finally { await wasm.close(); }
  });

});
