import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const source = readFileSync(new URL('../../../benchmarks/wasm-mos1-tran/inverter.cir', import.meta.url), 'utf8');
const request = (text = source, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source: text }, options,
});
const fixtures = [
  { name: 'Meyer and area/sidewall junction charge', source },
  { name: 'explicit junction charge', source: source.replace(/CJ=100u CJSW=100p/g, 'CBD=3f CBS=2f') },
  { name: 'static model defaults', source: source.replace(/ AD=.*$/gm, '').replace(/ TOX=.*\)/g, ')') },
];

describe('bounded adaptive MOS1 WASM transient', () => {
  it('compares the identical deck against the committed ngspice-47 output', async () => {
    const oracle = JSON.parse(readFileSync(new URL('../../../benchmarks/wasm-mos1-tran/ngspice.json', import.meta.url), 'utf8')) as {
      oracle: string; sourceSha256: string; timeS: number[]; signals: Record<string, number[]>;
    };
    expect(oracle.oracle).toBe('ngspice-47');
    expect(oracle.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await engine.simulate(request(), { requestId: 'oracle' });
      if (!result.ok) throw new Error(result.error.message);
      const a = result.data.analyses[0];
      if (a?.type !== 'tran') throw new Error('Expected transient');
      for (const field of ['voltagesV', 'currentsA'] as const) {
        for (const [name, values] of Object.entries(a[field])) {
          const key = field === 'voltagesV' ? `v(${name.toLowerCase()})` : `i(${name.toLowerCase()})`;
          const reference = oracle.signals[key] ?? oracle.signals[`${name.toLowerCase()}#branch`];
          expect(reference).toHaveLength(oracle.timeS.length);
          let j = 0;
          values.forEach((value, i) => {
            const time = a.timeS[i]!;
            while (j + 1 < oracle.timeS.length - 1 && oracle.timeS[j + 1]! < time) j++;
            const weight = (time - oracle.timeS[j]!) / (oracle.timeS[j + 1]! - oracle.timeS[j]!);
            const expected = reference![j]! + weight * (reference![j + 1]! - reference![j]!);
            // Regression ceilings, not a claim of strict ngspice parity.
            expect(Math.abs(value - expected)).toBeLessThanOrEqual(field === 'voltagesV' ? 2e-3 : 6e-6);
          });
        }
      }
    } finally { await engine.close(); }
  });

  it.each(fixtures)('bounds default core grid drift and matches signals: $name', async ({ name, source: text }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request(text);
      const actual = await engine.simulate(input, { requestId: 'mos1-tran' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      expect(a.timeS).toHaveLength(b.timeS.length);
      const maxTimeDelta = Math.max(...a.timeS.map((time, i) => Math.abs(time - b.timeS[i]!)));
      // Supervisor-approved transient parity contract; solver options stay at defaults.
      const stopTime = b.timeS.at(-1)!;
      a.timeS.forEach((time, i) => {
        expect(Math.abs(time - b.timeS[i]!)).toBeLessThanOrEqual(
          1e-12 * stopTime,
        );
      });
      expect(a.timeS[0]).toBe(0);
      expect(a.timeS.at(-1)).toBe(b.timeS.at(-1));
      expect(a.timeS.at(-1)).toBeCloseTo(150e-9, 20);
      expect(Math.max(...a.voltagesV.out!) - Math.min(...a.voltagesV.out!)).toBeGreaterThan(2.5);
      let maxVoltageDelta = 0;
      let maxCurrentDelta = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
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
      process.stdout.write(`MOS1 transient parity ${JSON.stringify({ name, points: a.timeS.length, maxTimeDelta, maxVoltageDelta, maxCurrentDelta })}\n`);
      expect(await engine.simulate(input, { requestId: 'repeat' })).toMatchObject({ ok: true, data: actual.data });
      for (const budget of [a.timeS.length, a.timeS.length - 1]) {
        const bounded = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: budget });
        try {
          expect(await bounded.simulate(input, { requestId: 'budget' })).toMatchObject(budget === a.timeS.length
            ? { ok: true, data: actual.data }
            : { ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxPoints', configured: budget, observed: budget + 1 } } });
        } finally { await bounded.close(); }
      }
    } finally { await engine.close(); }
  });

  it.each([false, true])('counts t=0 with independent protocol budget: %s', async protocolLimit => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: protocolLimit ? 4096 : 1 });
    try {
      expect(await engine.simulate(request(source, protocolLimit ? { limits: { maxResultPoints: 1 } } : undefined), { requestId: 'limit' }))
        .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: {
          limit: protocolLimit ? 'maxResultPoints' : 'maxPoints', configured: 1, observed: 2,
        } } });
    } finally { await engine.close(); }
  });

  it.each(['LEVEL=2', 'LEVEL=3', 'LEVEL=8', 'LEVEL=2 LEVEL=1', 'RD=10', 'TNOM=30'])(
    'rejects out-of-subset model %s', async parameter => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await engine.simulate(request(source.replace('LEVEL=1', parameter)), { requestId: 'unsupported' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'mosfet-model-parameter' } } });
      } finally { await engine.close(); }
    },
  );
});
