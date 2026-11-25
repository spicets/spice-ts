import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine, type SpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: i === 0 ? 'p' : 'n', net })), params,
});
const divider: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', ['in', '0'], { dc: 12 }),
    component('R', 'R1', ['in', 'out'], { resistance: 2000 }),
    component('R', 'R2', ['out', '0'], { resistance: 1000 }),
  ] }, analyses: [{ type: 'op' }],
};
const rc: SpiceTsCircuitDocumentV1 = {
  ...divider,
  circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 }),
    component('R', 'R1', ['in', 'out'], { resistance: 1000 }),
    component('C', 'C1', ['out', '0'], { capacitance: 1e-6 }),
  ] }, analyses: [{ type: 'ac', variation: 'dec', points: 5, startFreq: 10, stopFreq: 10000 }],
};

function selectedRequest(engine: SpiceEngine, document: SpiceTsCircuitDocumentV1): SimulationRequestV1 {
  expect(engine.capabilities.nativeSchemaVersions).toContain(document.schemaVersion);
  expect(engine.capabilities.numericWasm?.inputFormats).toContain('spice-ts');
  return { apiVersion: '1', input: { format: 'spice-ts', document } };
}
function close(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
}

describe('native WASM discovery', () => {
  it('advertises bounded native input without changing artifact identity or limits', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
      expect(engine.capabilities.nativeSchemaVersions).toEqual(['1.0']);
      expect(engine.capabilities.numericWasm).toMatchObject({
        inputFormats: ['spice', 'spice-ts'], fallback: 'reject',
        kernel: 'dense-gaussian-complex-f64-v2', abiVersion: 2,
        artifactSha256: manifest.numericWasm.sha256, artifactBytes: manifest.numericWasm.byteLength,
        limits: { maxSourceBytes: 65536, maxComponents: 256, maxSystemOrder: 64, maxAcPoints: 1025, maxResultPoints: 4096, memoryPages: 3 },
      });
      expect(engine.capabilities.engineBuildId).toBe(manifest.numericWasm.engineBuildId);
    } finally { await engine.close(); }
  });

  it('leaves JS discovery unchanged', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-js' });
    try {
      expect(engine.capabilities).toEqual({
        protocolVersions: ['1'], nativeSchemaVersions: ['1.0'], backends: ['spice-ts-js'],
        analyses: ['op', 'dc', 'tran', 'ac'], determinism: ['strict', 'relaxed'],
        streamChunkPoints: 256, engineBuildId: expect.stringMatching(/^spice-ts-js-[0-9a-f]{16}$/),
      });
    } finally { await engine.close(); }
  });

  it.each([['divider OP', divider], ['RC AC', rc]] as const)('executes discovered %s through numeric WASM in batch and stream', async (_name, document) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const request = selectedRequest(engine, document);
      expect(await engine.validate(request, { requestId: 'validate' })).toMatchObject({ ok: true });
      const result = await engine.simulate(request, { requestId: 'batch' });
      expect(result).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm', resolvedOptions: { backend: 'spice-ts-wasm' } } });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const actual = result.data.analyses[0];
      const core = (await simulateProtocolV1(request)).analyses[0];
      if (actual?.type === 'op' && core?.type === 'op') {
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(core[field]).sort());
          for (const [key, value] of Object.entries(core[field])) close(actual[field][key]!, value);
        }
        close(actual.voltagesV.out!, 4);
      } else if (actual?.type === 'ac' && core?.type === 'ac') {
        expect(actual.frequencyHz).toEqual(core.frequencyHz);
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(core[field]).sort());
          for (const [key, samples] of Object.entries(core[field])) {
            expect(actual[field][key]).toHaveLength(samples.length);
            samples.forEach((sample, i) => {
              const value = actual[field][key]![i]!;
              for (const trig of [Math.cos, Math.sin]) close(value.magnitude * trig(value.phaseDegrees * Math.PI / 180), sample.magnitude * trig(sample.phaseDegrees * Math.PI / 180));
            });
          }
        }
        expect(actual.voltagePhasors.out![0]!.magnitude).toBeGreaterThan(0.9);
      } else throw new Error('Unexpected analysis types');
      const reads = [];
      for await (const read of engine.simulateStream(request, { requestId: 'stream', chunkPoints: 4 })) reads.push(read);
      const terminal = reads.at(-1);
      expect(terminal).toMatchObject({ status: 'complete', terminal: { ok: true, metadata: { backend: 'spice-ts-wasm' }, data: result.data } });
      expect(reads.flatMap(read => read.events).some(event => event.type === 'analysis-start')).toBe(true);
    } finally { await engine.close(); }
  });

  it('executes discovered native AC output selection in validation, batch and stream', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const request = { ...selectedRequest(engine, rc), outputs: ['V(out)'] };
      expect(await engine.validate(request, { requestId: 'selected-validation' })).toMatchObject({ ok: true });
      const result = await engine.simulate(request, { requestId: 'selected-batch' });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const ac = result.data.analyses[0];
      if (ac?.type !== 'ac') throw new Error('expected AC');
      expect(Object.keys(ac.voltagePhasors)).toEqual(['out']);
      expect(ac.currentPhasors).toEqual({});
      const reads = [];
      for await (const read of engine.simulateStream(request, { requestId: 'selected-stream' })) reads.push(read);
      expect(reads.at(-1)).toMatchObject({ status: 'complete', terminal: { ok: true, data: result.data } });
    } finally { await engine.close(); }
  });
});
