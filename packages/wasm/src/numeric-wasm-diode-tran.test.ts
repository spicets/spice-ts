import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored fixtures, MIT.
const rectifier = 'V1 in 0 SIN(0 2 1k)\nR1 in a 100\nD1 a out junction\nR2 out 0 1k\nC1 out 0 100n\n.model junction D(IS=1e-14 N=1 RS=2)\n.tran 1u 2m';
const clamp = 'V1 in 0 2\nR1 in out 1k\nD1 out 0 junction\n.model junction D(IS=1e-14 N=1)\n.tran 1u 10u';
const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options,
});

describe('bounded adaptive-diode WASM transient', () => {
  it.each([false, true])('compares rectifier grids and all signals (tight=%s)', async tight => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm', ...(tight ? { maxPoints: 12_000 } : {}) });
    try {
      const input = request(rectifier, tight ? { reltol: 1e-10, vntol: 1e-13, abstol: 1e-16 } : undefined);
      const actual = await engine.simulate(input, { requestId: 'rectifier' });
      expect(actual.ok).toBe(true);
      if (!actual.ok) return;
      expect(await engine.simulate(input, { requestId: 'repeat' })).toMatchObject({ ok: true, data: actual.data });
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(a.timeS).toHaveLength(tight ? 10215 : 2008);
      expect(a.timeS).toHaveLength(b.timeS.length);
      expect(a.timeS.at(-1)).toBe(0.002);
      let maxDelta = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
        for (const [name, values] of Object.entries(a[field])) {
          expect(values).toHaveLength(a.timeS.length);
          values.forEach((value, i) => { maxDelta = Math.max(maxDelta, Math.abs(value - b[field][name]![i]!)); });
        }
      }
      if (tight) {
        // Expected difference: dense/sparse rounding feeds adaptive LTE decisions.
        expect(maxDelta).toBeGreaterThan(1e-10);
        expect(maxDelta).toBeLessThanOrEqual(9e-10);
        expect(Math.max(...a.timeS.map((time, i) => Math.abs(time - b.timeS[i]!)))).toBeLessThanOrEqual(1.1e-13);
      } else {
        expect(a.timeS).toEqual(b.timeS);
        expect(maxDelta).toBeLessThanOrEqual(1e-12);
      }
    } finally { await engine.close(); }
  });

  it('matches the constant clamp including the DC initial sample', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await engine.simulate(request(clamp), { requestId: 'clamp' });
      expect(actual.ok).toBe(true);
      if (!actual.ok) return;
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(clamp))).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(a.timeS).toEqual(b.timeS);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        for (const [name, values] of Object.entries(a[field])) {
          values.forEach((value, i) => expect(Math.abs(value - b[field][name]![i]!)).toBeLessThanOrEqual(1e-12));
        }
      }
    } finally { await engine.close(); }
  });

  it.each([1, 10, 2007, 2008])('reports the explicit maxPoints=%s budget including t=0', async maxPoints => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints });
    try {
      if (maxPoints === 2008) {
        expect(await engine.simulate(request(rectifier), { requestId: 'exact-budget' })).toMatchObject({ ok: true });
        return;
      }
      expect(await engine.simulate(request(rectifier), { requestId: 'budget' }))
        .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxPoints', configured: maxPoints, observed: maxPoints + 1 } } });
    } finally { await engine.close(); }
  });

  it.each(['CJSW=1p', 'IKF=1m'])('rejects unsupported parameter %s', async parameter => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(clamp.replace('N=1)', `N=1 ${parameter})`)), { requestId: 'unsupported' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: `diode-model-parameter:${parameter.split('=')[0]}` } } });
    } finally { await engine.close(); }
  });

  it('rejects other nonlinear devices without fallback', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(clamp.replace('D1 out 0 junction', 'B1 out 0 I=v(out)')), { requestId: 'device' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'device-or-directive' } } });
    } finally { await engine.close(); }
  });

  it('respects the separate protocol result limit', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(rectifier, { limits: { maxResultPoints: 10 } }), { requestId: 'point-limit' }))
        .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints', configured: 10, observed: 11 } } });
    } finally { await engine.close(); }
  });

  it('defaults to 4096 points rather than an unbounded adaptive run', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(rectifier, { reltol: 1e-10, vntol: 1e-13, abstol: 1e-16 }), { requestId: 'default-limit' }))
        .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxPoints', configured: 4096, observed: 4097 } } });
    } finally { await engine.close(); }
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maxPoints=%s', async maxPoints => {
    await expect(createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints })).rejects.toThrow(RangeError);
  });
});
