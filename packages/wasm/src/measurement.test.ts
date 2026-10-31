import { describe, expect, it } from 'vitest';
import { parseTitleless, simulate } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';
import { addMeasurements, parseWasmMeasurement } from './measurement.js';

const deck = `V1 in 0 PULSE(0 1 0 1m 1m 2m 5m)
R1 in out 1k
C1 out 0 1u
.tran 10u 3m 0 10u
.meas tran sample find v(out) at=1m
.meas tran mean avg v(out) from=0 to=3m
.meas tran low min v(out) from=0 to=3m
.meas tran high max v(out) from=0 to=3m
.meas tran rmsval rms v(out) from=0 to=3m`;
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: deck } };

describe('WASM transient measurements', () => {
  it('evaluates RC measurements from the WASM waveform', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await engine.simulate(request, { requestId: 'meas' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata.backend).toBe('spice-ts-wasm');
      const tran = actual.data.analyses[0];
      if (tran?.type !== 'tran') throw new Error('expected transient');
      expect(tran.measurements).toHaveLength(5);
      expect(tran.measurements?.map(m => m.name)).toEqual(['sample', 'mean', 'low', 'high', 'rmsval']);
      // A 1 V/ms ramp into a 1 ms RC has v(1 ms) = exp(-1) V.
      const sample = tran.measurements![0]!;
      if (!('value' in sample)) throw new Error('sample failed');
      expect(Math.abs(sample.value - Math.exp(-1))).toBeLessThan(1e-5);
      const core = await simulate(parseTitleless(deck));
      expect(core.measurements).toHaveLength(5);
      const differences: number[] = [];
      tran.measurements!.forEach((m, i) => {
        if (!('value' in m)) throw new Error(JSON.stringify(m));
        expect(m.unit).toBe('V');
        expect(Number.isFinite(m.value)).toBe(true);
        const delta = Math.abs(m.value - core.measurements![i]!.value!);
        differences.push(delta);
        expect(delta).toBeLessThanOrEqual(1e-9);
      });
      process.stdout.write(`Measurement parity ${JSON.stringify({ values: tran.measurements, differences })}\n`);
    } finally { await engine.close(); }
  });

  it('evaluates hand-calculated constant and linear ramp samples including clipped bounds', () => {
    const cards = [
      '.meas tran sample find v(ramp) at=0.5',
      '.meas tran mean avg v(ramp) from=0 to=2',
      '.meas tran low min v(ramp) from=0 to=2',
      '.meas tran high max v(ramp) from=0 to=2',
      '.meas tran rmsval rms v(constant) from=0 to=2',
      '.meas tran clipped avg v(constant) from=-1 to=3',
      '.meas tran current avg i(v1) from=0 to=2',
    ].map((card, i) => parseWasmMeasurement(card, i + 1)!);
    const result: import('@spice-ts/core/protocol').TransientResultV1 = { type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2], voltagesV: { ramp: [0, 1, 2], constant: [3, 3, 3] }, currentsA: { v1: [-0.002, -0.002, -0.002] } };
    addMeasurements(result, cards);
    expect(result.measurements).toEqual([
      { name: 'sample', value: 0.5, unit: 'V' }, { name: 'mean', value: 1, unit: 'V' },
      { name: 'low', value: 0, unit: 'V' }, { name: 'high', value: 2, unit: 'V' },
      { name: 'rmsval', value: 3, unit: 'V' }, { name: 'clipped', value: 3, unit: 'V' },
      { name: 'current', value: -0.002, unit: 'A' },
    ]);
  });

  it('measures a constant circuit on the fixed-step WASM path', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 2\nR1 out 0 1k\n.tran 100u 1m\n.meas tran mean avg v(out) from=-1m to=2m\n.meas tran current find i(v1) at=0.5m' } };
      const result = await engine.simulate(input, { requestId: 'fixed' });
      expect(result.ok).toBe(true);
      if (!result.ok || result.data.analyses[0]?.type !== 'tran') throw new Error('expected tran');
      const entries = result.data.analyses[0].measurements!;
      expect(entries[0]).toMatchObject({ name: 'mean', value: 2, unit: 'V' });
      expect(entries[1]).toMatchObject({ name: 'current', value: -0.002, unit: 'A' });
    } finally { await engine.close(); }
  });

  it('advertises its bounded transient forms', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try { expect(engine.capabilities.numericWasm?.measurements).toEqual(['tran:find-at', 'tran:avg', 'tran:min', 'tran:max', 'tran:rms', 'dc:find-at']); }
    finally { await engine.close(); }
  });

  it.each([
    '.meas tran x when v(out)=1', '.meas tran x integ v(out) from=0 to=1m',
    '.meas ac x avg v(out) from=0 to=1m', '.meas tran x avg v(out) from=2m to=1m',
    '.meas tran x max v(out) from=1m to=1m', '.meas tran x find v(out) at=1e999',
    '.meas tran x avg v( out ) from=0 to=1m', '.meas tran x find v (out) at=0.5m',
    '.meas tran x avg v(out) from=1e-3k to=2',
  ])('rejects unsupported or invalid card %s', async card => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: `V1 out 0 1\nR1 out 0 1k\n.tran 10u 1m\n${card}` } };
      expect(await engine.simulate(input, { requestId: 'invalid' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
    } finally { await engine.close(); }
  });

  it('returns a diagnostic for an absent vector', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 1\nR1 out 0 1k\n.tran 10u 1m\n.meas tran missing avg v(nope) from=0 to=1m' } };
      const result = await engine.simulate(input, { requestId: 'missing' });
      expect(result.ok).toBe(true);
      if (!result.ok || result.data.analyses[0]?.type !== 'tran') throw new Error('expected tran');
      expect(result.data.analyses[0].measurements).toMatchObject([{ name: 'missing', diagnostic: { code: 'MEASUREMENT_FAILED' } }]);
    } finally { await engine.close(); }
  });

  it('bounds the number of cards before evaluation', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = `V1 out 0 1\nR1 out 0 1k\n.tran 100u 1m\n${Array.from({ length: 129 }, (_, i) => `.meas tran m${i} avg v(out) from=0 to=1m`).join('\n')}`;
      expect(await engine.simulate({ apiVersion: '1', input: { format: 'spice', source } }, { requestId: 'many' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxMeasurements', configured: 128, observed: 129 } } });
    } finally { await engine.close(); }
  });

  it('preserves Fourier tables when measurements are present', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = 'V1 out 0 SIN(0 1 1k)\nR1 out 0 1k\n.tran 10u 3m\n.four 1k v(out)';
      const base = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source } }, { requestId: 'four' });
      const measured = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: `${source}\n.meas tran mean avg v(out) from=0 to=3m` } }, { requestId: 'both' });
      if (!base.ok || !measured.ok || base.data.analyses[0]?.type !== 'tran' || measured.data.analyses[0]?.type !== 'tran') throw new Error('expected transient results');
      expect(measured.data.analyses[0].fourier).toEqual(base.data.analyses[0].fourier);
      expect(measured.data.analyses[0].measurements).toHaveLength(1);
    } finally { await engine.close(); }
  });

  it('counts measurements towards the serialized result limit', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = 'V1 out 0 1\nR1 out 0 1k\n.tran 100u 1m';
      const base: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source } };
      const plain = await engine.simulate(base, { requestId: 'plain' });
      if (!plain.ok) throw new Error('expected success');
      const limit = new TextEncoder().encode(JSON.stringify(plain.data)).length;
      const withMeas: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: `${source}\n.meas tran avgout avg v(out) from=0 to=1m` }, options: { limits: { maxSerializedResultBytes: limit } } };
      expect(await engine.simulate(withMeas, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } });
    } finally { await engine.close(); }
  });
});
