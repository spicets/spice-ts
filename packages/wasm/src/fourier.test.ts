import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, TransientResultV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const request = (source: string): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice', source } });
const fixtures = [
  { name: 'phased sine', circuit: 'V1 out 0 SIN(0 1 1k 0 0 30)\nR1 out 0 1k', outputs: 'v(out) i(V1)' },
  { name: 'two tone', circuit: 'V1 in 0 SIN(0 1 1k 0 0 30)\nV2 out in SIN(0 0.2 2k 0 0 60)\nR1 out 0 1k', outputs: 'v(out) v(in) v(out,in)' },
];
// Inherited source-transient bounds: 1e-9 V and 1e-12 A per sampled point.
// For signals >=0.01, 1e-4 degrees and percentage points conservatively cover
// amplification of these waveform errors by phase/THD normalization.
const phaseAndThdBound = 1e-4;

describe('WASM Fourier', () => {
  it.each(fixtures)('returns core-shaped tables for $name on the numeric backend', async ({ name, circuit, outputs }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request(`${circuit}\n.tran 10u 3m\n.four 1k ${outputs}`);
      const actual = await engine.simulate(input, { requestId: name });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata.backend).toBe('spice-ts-wasm');
      expect(engine.capabilities.numericWasm?.fallback).toBe('reject');
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(a.fourier).toHaveLength(outputs.split(' ').length);
      expect(b.fourier).toHaveLength(a.fourier!.length);
      let maxMagnitude = 0, maxPhase = 0, maxThd = 0;
      a.fourier!.forEach((table, i) => {
        const ref = b.fourier![i]!;
        expect({ vector: table.vector, fundamental: table.fundamental, gridSize: table.gridSize, degree: table.degree, periods: table.periods }).toEqual({ vector: ref.vector, fundamental: ref.fundamental, gridSize: ref.gridSize, degree: ref.degree, periods: ref.periods });
        expect(table.harmonics).toHaveLength(10);
        table.harmonics.forEach((row, n) => {
          const expected = ref.harmonics[n]!;
          expect([row.harmonic, row.frequency]).toEqual([expected.harmonic, expected.frequency]);
          const delta = Math.abs(row.magnitude! - expected.magnitude!);
          maxMagnitude = Math.max(maxMagnitude, delta);
          expect(delta).toBeLessThanOrEqual(/^i\s*\(/i.test(table.vector) ? 1e-12 : 1e-9);
          if (expected.magnitude !== null && Math.abs(expected.magnitude) >= 0.01) {
            const phase = Math.abs(row.phase! - expected.phase!);
            maxPhase = Math.max(maxPhase, phase);
            expect(phase).toBeLessThanOrEqual(phaseAndThdBound);
            expect(Math.abs(row.normalizedMagnitude! - expected.normalizedMagnitude!)).toBeLessThanOrEqual(phaseAndThdBound);
            expect(Math.abs(row.normalizedPhase! - expected.normalizedPhase!)).toBeLessThanOrEqual(phaseAndThdBound);
          } else if (expected.normalizedMagnitude === null) expect(row.normalizedMagnitude).toBeNull();
        });
        if (ref.thd === null) expect(table.thd).toBeNull();
        else { const delta = Math.abs(table.thd! - ref.thd); maxThd = Math.max(maxThd, delta); expect(delta).toBeLessThanOrEqual(phaseAndThdBound); }
      });
      expect(Math.abs(a.fourier![0]!.harmonics[1]!.phase!)).toBeGreaterThan(1);
      if (name === 'two tone') expect(a.fourier![0]!.thd!).toBeGreaterThan(1);
      process.stdout.write(`Fourier parity ${JSON.stringify({ name, tables: a.fourier!.length, fundamentalMagnitude: a.fourier![0]!.harmonics[1]!.magnitude, fundamentalPhase: a.fourier![0]!.harmonics[1]!.phase, thd: a.fourier![0]!.thd, maxMagnitude, maxPhase, maxThd })}\n`);
    } finally { await engine.close(); }
  });

  it.each(['.four 0 v(out)', '.four 1k v(missing)', '.four 1 v(out)'])('matches core omission for %s', async card => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request(`V1 out 0 SIN(0 1 1k)\nR1 out 0 1k\n.tran 10u 3m\n${card}`);
      const actual = await engine.simulate(input, { requestId: card });
      expect(actual.ok).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect((actual.data.analyses[0] as TransientResultV1).fourier).toEqual(((await simulateProtocolV1(input)).analyses[0] as TransientResultV1).fourier);
    } finally { await engine.close(); }
  });

  it('leaves the transient waveform unchanged when Fourier is absent', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const base = 'V1 out 0 SIN(0 1 1k)\nR1 out 0 1k\n.tran 10u 3m';
      const plain = await engine.simulate(request(base), { requestId: 'plain' });
      const withFour = await engine.simulate(request(`${base}\n.four 1k v(out)`), { requestId: 'four' });
      if (!plain.ok || !withFour.ok) throw new Error('Expected success');
      const a = plain.data.analyses[0] as TransientResultV1;
      const b = withFour.data.analyses[0] as TransientResultV1;
      expect(a.fourier).toBeUndefined();
      expect({ timeS: b.timeS, voltagesV: b.voltagesV, currentsA: b.currentsA }).toEqual({ timeS: a.timeS, voltagesV: a.voltagesV, currentsA: a.currentsA });
    } finally { await engine.close(); }
  });

  it('matches zero-signal null normalization on the fixed-step WASM path', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request('V1 out 0 0\nR1 out 0 1k\n.tran 10u 3m\n.four 1k v(out)');
      const actual = await engine.simulate(input, { requestId: 'zero' });
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0] as TransientResultV1;
      const b = (await simulateProtocolV1(input)).analyses[0] as TransientResultV1;
      expect(a.fourier).toEqual(b.fourier);
      expect(a.fourier![0]!.thd).toBeNull();
      expect(a.fourier![0]!.harmonics[1]!.normalizedMagnitude).toBeNull();
    } finally { await engine.close(); }
  });

  it.each(['options', 'option', 'opt'])('evaluates expressions and .%s Fourier options on the numeric backend', async option => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request(`V1 out 0 SIN(0 1 1k)\nR1 out 0 1k\n.tran 10u 3m\n.${option} nfreqs = 5, fourgridsize = 128\n.four 1k v(out)*2 v(out)\n.fourier 1k v(out)+v(out)`);
      const actual = await engine.simulate(input, { requestId: 'expression-options' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata.backend).toBe('spice-ts-wasm');
      const a = actual.data.analyses[0] as TransientResultV1;
      const b = (await simulateProtocolV1(input)).analyses[0] as TransientResultV1;
      expect(a.fourier).toEqual(b.fourier);
      expect(a.fourier).toHaveLength(3);
      expect(a.fourier![0]).toMatchObject({ vector: 'v(out)*2', gridSize: 128 });
      expect(a.fourier![0]!.harmonics).toHaveLength(5);
    } finally { await engine.close(); }
  });
});
