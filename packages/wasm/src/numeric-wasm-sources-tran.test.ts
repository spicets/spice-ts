import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored fixtures, MIT. Both source polarities drive passive RC/RLC loads.
const fixtures = ['V', 'I'].flatMap(kind => {
  const source = kind === 'V' ? 'V1 in 0' : 'Rload out 0 1k\nI1 0 in';
  const scale = kind === 'V' ? 1 : 0.001;
  const load = 'R1 in out 1k\nC1 out 0 100n';
  return [
    { name: `${kind} SIN RC`, source: `${source} SIN(0 ${scale} 1k)\n${load}\n.tran 10u 1m`, corners: [] },
    { name: `${kind} delayed damped phased SIN RC`, source: `${source} SIN(0 ${scale} 1k 137u 500 30)\n${load}\n.tran 10u 1m`, corners: [] },
    ...[false, true].map(rlc => ({
      name: `${kind} repeated-corner PWL ${rlc ? 'RLC' : 'RC'}`,
      source: `${source} PWL(0 0 137u 0 137u ${scale} 413u ${scale} 729u 0)\n${rlc ? 'R1 in mid 100\nL1 mid out 10m\nC1 out 0 100n' : load}\n.tran 10u 1m`,
      corners: [137e-6, 413e-6, 729e-6],
    })),
  ];
});
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

describe('WASM SIN/PWL transient sources', () => {
  it.each(fixtures)('matches core accepted points and signals: $name', async ({ name, source, corners }) => {
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
      expect(a.timeS).toHaveLength(b.timeS.length);
      expect(a.timeS[0]).toBe(0);
      expect(a.timeS.at(-1)).toBe(0.001);
      // Core's accept-time PWL arithmetic can land one ulp from a literal corner.
      for (const corner of corners) {
        expect(Math.min(...a.timeS.map(time => Math.abs(time - corner)))).toBeLessThanOrEqual(Number.EPSILON * 0.001);
      }
      let maxVoltageDelta = 0;
      let maxCurrentDelta = 0;
      let maxTimeDelta = 0;
      a.timeS.forEach((time, i) => { maxTimeDelta = Math.max(maxTimeDelta, Math.abs(time - b.timeS[i]!)); });
      expect(maxTimeDelta).toBeLessThanOrEqual(1e-12 * 0.001);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [signal, values] of Object.entries(a[field])) {
          expect(values).toHaveLength(a.timeS.length);
          values.forEach((value, i) => {
            const delta = Math.abs(value - b[field][signal]![i]!);
            expect(delta).toBeLessThanOrEqual(field === 'voltagesV' ? 1e-9 : 1e-12);
            if (field === 'voltagesV') maxVoltageDelta = Math.max(maxVoltageDelta, delta);
            else maxCurrentDelta = Math.max(maxCurrentDelta, delta);
          });
        }
      }
      process.stdout.write(`Source transient parity ${JSON.stringify({ name, points: a.timeS.length, maxVoltageDelta, maxCurrentDelta, maxTimeDelta })}\n`);
      expect(await engine.simulate(input, { requestId: 'repeat' })).toMatchObject({ ok: true, data: actual.data });
      const limited = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: a.timeS.length - 1 });
      try {
        expect(await limited.simulate(input, { requestId: 'limit' })).toMatchObject({
          ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxPoints' } },
        });
      } finally { await limited.close(); }
    } finally { await engine.close(); }
  });

  it.each(['V', 'I'].flatMap(kind => ['AC 1', 'DC 1 SIN(0 1 1k)', 'DC 1 PWL(0 0 1m 1)', 'SIN(0 1 1k) AC 1', 'PWL(0 0 1m 1) AC 1'].map(waveform => ({ kind, waveform }))))(
    'rejects AC/compound transient forms: $kind $waveform', async ({ kind, waveform }) => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await engine.simulate(request(`${kind}1 in 0 ${waveform}\nR1 in 0 1k\n.tran 10u 1m`), { requestId: 'unsupported' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'source-waveform' } },
        });
      } finally { await engine.close(); }
    },
  );
});
