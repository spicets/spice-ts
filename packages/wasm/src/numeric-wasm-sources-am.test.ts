import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored RC fixtures, MIT. AM uses core's ngspice-47 coefficient order.
const waveforms = [
  { name: 'explicit frequencies', parameters: (s: number) => `AM(${0.2 * s} ${s} ${0.5 * s} 500 2k)` },
  { name: 'delay', parameters: (s: number) => `AM(${0.2 * s} ${s} ${0.5 * s} 500 2k 137u)` },
  { name: 'modulation phase', parameters: (s: number) => `AM(${0.2 * s} ${s} ${0.5 * s} 500 2k 137u 30)` },
  { name: 'both phases', parameters: (s: number) => `AM(${0.2 * s} ${s} ${0.5 * s} 500 2k 137u 30 -45)` },
  { name: 'omitted defaults', parameters: (s: number) => `AM(${0.2 * s} ${s})` },
  { name: 'partial defaults', parameters: (s: number) => `AM(${0.2 * s} ${s} ${0.5 * s} 500)` },
];
const fixtures = ['V', 'I'].flatMap(kind => waveforms.map(({ name, parameters }) => ({
  name: `${kind} ${name}`,
  source: `${kind === 'V' ? 'V1 in 0' : 'Rload out 0 1k\nVsense feed in 0\nI1 0 feed'} ${parameters(kind === 'V' ? 1 : 0.001)}\nR1 in out 1k\nC1 out 0 100n\n.tran 10u 1m`,
})));
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

describe('WASM AM transient sources', () => {
  it.each(fixtures)('matches core timesteps and every signal sample: $name', async ({ name, source }) => {
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
      // Compare the complete accepted grid, not interpolated output samples.
      expect(a.timeS).toEqual(b.timeS);
      expect(a.timeS[0]).toBe(0);
      expect(a.timeS.at(-1)).toBe(0.001);
      expect(Math.max(...a.voltagesV.out!) - Math.min(...a.voltagesV.out!)).toBeGreaterThan(1e-6);
      expect(Object.keys(a.currentsA).length).toBeGreaterThan(0);
      let worstRelativeDelta = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [signal, values] of Object.entries(a[field])) {
          const reference = b[field][signal]!;
          expect(values).toHaveLength(a.timeS.length);
          values.forEach((value, i) => {
            expect(Number.isFinite(value)).toBe(true);
            const expected = reference[i]!;
            const delta = Math.abs(value - expected);
            // Relative error at each nonzero sample, absolute error at exact zero.
            const relativeDelta = expected === 0 ? delta : delta / Math.abs(expected);
            expect(relativeDelta, `${field}.${signal}[${i}]`).toBeLessThanOrEqual(expected === 0 ? 1e-15 : 1e-9);
            worstRelativeDelta = Math.max(worstRelativeDelta, relativeDelta);
          });
        }
      }
      process.stdout.write(`AM parity ${JSON.stringify({ name, points: a.timeS.length, worstRelativeDelta })}\n`);
    } finally { await engine.close(); }
  });

  it.each(['V', 'I'].flatMap(kind => [
    'AM()', 'AM(0)', 'AM(0 1 0.5 500 2k 137u 30 45 99)',
    'AM(0 nope)', 'AM(0 1', 'AM(0 1) extra',
  ].map(waveform => ({ kind, waveform }))))('returns structured unsupported errors: $kind $waveform', async ({ kind, waveform }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(`${kind}1 in 0 ${waveform}\nR1 in 0 1k\n.tran 10u 1m`), { requestId: 'malformed' })).toMatchObject({
        ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { backend: 'spice-ts-wasm', feature: 'source-waveform' } },
      });
    } finally { await engine.close(); }
  });
});
