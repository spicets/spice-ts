import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT common-emitter fixtures. Same default options
// for both polarities; external capacitance exercises transient device history.
const fixtures = ['NPN', 'PNP'].map(polarity => {
  const sign = polarity === 'NPN' ? 1 : -1;
  return { polarity, source: `VCC supply 0 ${sign * 5}\nVIN input 0 PULSE(0 ${sign * 1.2} 10u 1u 1u 30u 60u)\nRC supply collector 1k\nRB input base 100k\nC1 collector 0 10n\nQ1 collector base 0 transistor\n.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80)\n.tran 1u 150u` };
});
const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options,
});

describe('bounded adaptive-BJT WASM transient', () => {
  it.each(fixtures)('matches the default core time grid and all signals: $polarity', async ({ polarity, source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request(source);
      const actual = await engine.simulate(input, { requestId: 'bjt-tran' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(a.timeS).toEqual(b.timeS);
      expect(a.timeS[0]).toBe(0);
      expect(a.timeS.at(-1)).toBe(150e-6);
      expect(Math.max(...a.voltagesV.collector!) - Math.min(...a.voltagesV.collector!)).toBeGreaterThan(0.5);
      let maxVoltageDelta = 0;
      let maxCurrentDelta = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
        for (const [name, values] of Object.entries(a[field])) {
          expect(values).toHaveLength(a.timeS.length);
          values.forEach((value, i) => {
            const delta = Math.abs(value - b[field][name]![i]!);
            expect(delta).toBeLessThanOrEqual(field === 'voltagesV' ? 1e-9 : 1e-12);
            if (field === 'voltagesV') maxVoltageDelta = Math.max(maxVoltageDelta, delta);
            else maxCurrentDelta = Math.max(maxCurrentDelta, delta);
          });
        }
      }
      process.stdout.write(`BJT transient parity ${JSON.stringify({ polarity, points: a.timeS.length, maxVoltageDelta, maxCurrentDelta })}\n`);
      expect(await engine.simulate(input, { requestId: 'repeat' })).toMatchObject({ ok: true, data: actual.data });
      const exact = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: a.timeS.length });
      try { expect(await exact.simulate(input, { requestId: 'exact' })).toMatchObject({ ok: true, data: actual.data }); }
      finally { await exact.close(); }
      const short = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: a.timeS.length - 1 });
      try {
        expect(await short.simulate(input, { requestId: 'short' })).toMatchObject({ ok: false, error: {
          code: 'RESOURCE_LIMIT', details: { limit: 'maxPoints', configured: a.timeS.length - 1, observed: a.timeS.length },
        } });
      } finally { await short.close(); }
    } finally { await engine.close(); }
  });

  it('counts t=0 and preserves the independent protocol point budget', async () => {
    for (const protocolLimit of [false, true]) {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: protocolLimit ? 4096 : 1 });
      try {
        expect(await engine.simulate(request(fixtures[0]!.source, protocolLimit ? { limits: { maxResultPoints: 1 } } : undefined), { requestId: 'limit' }))
          .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: {
            limit: protocolLimit ? 'maxResultPoints' : 'maxPoints', configured: 1, observed: 2,
          } } });
      } finally { await engine.close(); }
    }
  });

  it.each(['CJS=1p', 'XTF=1', 'XTI=3', 'IKF=1m'])(
    'rejects out-of-subset BJT parameter %s without fallback', async parameter => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await engine.simulate(request(fixtures[0]!.source.replace('VAF=80)', `VAF=80 ${parameter})`)), { requestId: 'unsupported' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'bjt-model-parameter' } } });
      } finally { await engine.close(); }
    },
  );
});
