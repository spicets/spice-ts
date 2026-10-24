import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored RC fixtures, MIT; no third-party netlists.
const waveforms = [
  { name: 'EXP full', parameters: (scale: number) => `EXP(0 ${scale} 137u 43u 613u 91u)` },
  { name: 'EXP omitted', parameters: (scale: number) => `EXP(0 ${scale})` },
  { name: 'EXP partial defaults', parameters: (scale: number) => `EXP(0 ${scale} 137u)` },
  { name: 'SFFM full', parameters: (scale: number) => `SFFM(0 ${scale} 2k 1.5 500)` },
  { name: 'SFFM omitted', parameters: (scale: number) => `SFFM(0 ${scale})` },
  { name: 'SFFM partial defaults', parameters: (scale: number) => `SFFM(0 ${scale} 2k 1.5)` },
];
const fixtures = ['V', 'I'].flatMap(kind => waveforms.map(({ name, parameters }) => ({
  name: `${kind} ${name}`,
  kind,
  // A zero-volt sensor exposes the current-source branch in the protocol result.
  source: `${kind === 'V' ? 'V1 in 0' : 'Rload out 0 1k\nVsense feed in 0\nI1 0 feed'} ${parameters(kind === 'V' ? 1 : 0.001)}\nR1 in out 1k\nC1 out 0 100n\n.tran 10u 1m`,
})));
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

describe('WASM EXP/SFFM transient sources', () => {
  it.each(fixtures)('matches core accepted points and signals: $name', async ({ name, source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request(source);
      const actual = await engine.simulate(input, { requestId: name });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(a.timeS.length).toBeGreaterThan(2);
      expect(a.timeS).toHaveLength(b.timeS.length);
      expect(a.timeS[0]).toBe(0);
      expect(a.timeS.at(-1)).toBe(0.001);
      const maxTimeDelta = Math.max(...a.timeS.map((time, i) => Math.abs(time - b.timeS[i]!)));
      expect(maxTimeDelta).toBeLessThanOrEqual(1e-15);
      // Every fixture must actually excite the load; matching zero arrays is not parity.
      for (const result of [a, b]) {
        const output = result.voltagesV.out!;
        expect(Math.max(...output) - Math.min(...output)).toBeGreaterThan(1e-6);
      }
      expect(Object.keys(a.currentsA).length).toBeGreaterThan(0);
      const signals: Record<string, { peak: number; maxDelta: number; relativeDelta: number }> = {};
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [signal, values] of Object.entries(a[field])) {
          const reference = b[field][signal]!;
          expect(values).toHaveLength(a.timeS.length);
          expect(values.every(Number.isFinite)).toBe(true);
          const peak = Math.max(...reference.map(Math.abs));
          const maxDelta = Math.max(...values.map((value, i) => Math.abs(value - reference[i]!)));
          const relativeDelta = peak === 0 ? maxDelta : maxDelta / peak;
          expect(relativeDelta, `${field}.${signal}`).toBeLessThanOrEqual(peak === 0 ? 1e-15 : 1e-9);
          signals[`${field}.${signal}`] = { peak, maxDelta, relativeDelta };
        }
      }
      process.stdout.write(`EXP/SFFM parity ${JSON.stringify({ name, points: a.timeS.length, maxTimeDelta, signals })}\n`);
    } finally { await engine.close(); }
  });

  it.each(['V', 'I'].flatMap(kind => [
    'EXP(0)', 'EXP(0 1 1u 2u 3u 4u 5u)',
    'SFFM(0)', 'SFFM(0 1 2k 1.5 500 0 0 0 1)',
  ].map(waveform => ({ kind, waveform }))))('returns structured parse errors: $kind $waveform', async ({ kind, waveform }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(`${kind}1 in 0 ${waveform}\nR1 in 0 1k\n.tran 10u 1m`), { requestId: 'malformed' })).toMatchObject({
        ok: false, error: { code: 'INVALID_CIRCUIT', phase: 'compile', message: expect.stringContaining(`${waveform.split('(')[0]} source`) },
      });
    } finally { await engine.close(); }
  });
});
