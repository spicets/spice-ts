import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored fixtures, MIT. Fixed-grid WASM does not yet share
// core's adaptive timestep driver; only constant waveforms have exact grid parity.
const rectifier = 'V1 in 0 SIN(0 2 1k)\nR1 in a 100\nD1 a out junction\nR2 out 0 1k\nC1 out 0 100n\n.model junction D(IS=1e-14 N=1 RS=2)\n.tran 1u 2m';
const clamp = 'V1 in 0 2\nR1 in out 1k\nD1 out 0 junction\n.model junction D(IS=1e-14 N=1)\n.tran 1u 10u';
const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options: { reltol: 1e-10, vntol: 1e-13, abstol: 1e-16, ...options },
});

describe('bounded static-diode WASM transient', () => {
  it('matches the core constant diode clamp at every WASM timepoint', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await engine.simulate(request(clamp), { requestId: 'clamp' });
      expect(actual.ok).toBe(true);
      if (!actual.ok) return;
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(clamp))).analyses[0];
      expect(a?.type).toBe('tran');
      expect(b?.type).toBe('tran');
      if (a?.type !== 'tran' || b?.type !== 'tran') return;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const values of Object.values(b[field])) {
          expect(values).toHaveLength(b.timeS.length);
          const reference = values[0]!;
          for (const value of values) {
            expect(Math.abs(value - reference)).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(reference));
          }
        }
        for (const [name, values] of Object.entries(a[field])) {
          expect(values).toHaveLength(a.timeS.length);
          for (const value of values) {
            const reference = b[field][name]![0]!;
            expect(Math.abs(value - reference)).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(reference));
          }
        }
      }
    } finally { await engine.close(); }
  });

  it('runs a SIN-driven half-wave rectifier deterministically with capacitor history', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await engine.simulate(request(rectifier), { requestId: 'rectifier' });
      expect(actual.ok).toBe(true);
      if (!actual.ok) return;
      expect(await engine.simulate(request(rectifier), { requestId: 'repeat' })).toMatchObject({ ok: true, data: actual.data });
      const a = actual.data.analyses[0];
      if (a?.type !== 'tran') throw new Error('Expected transient');
      expect(a.timeS).toHaveLength(2001);
      expect(Math.max(...a.voltagesV.out!)).toBeGreaterThan(1);
      expect(Math.min(...a.voltagesV.out!)).toBeGreaterThan(-1e-6);
      // At 0.75 ms the source is negative, but stored capacitor charge remains.
      expect(a.voltagesV.in![750]).toBeCloseTo(-2, 12);
      expect(a.voltagesV.out![750]).toBeGreaterThan(0.001);
      for (let i = 1; i < a.timeS.length; i++) {
        const v = a.voltagesV.out!;
        const current = a.currentsA.V1!;
        const capacitor = 2e-7 / (a.timeS[i]! - a.timeS[i - 1]!) * (v[i]! - v[i - 1]!);
        const terminal = -current[i]! - current[i - 1]! - (v[i]! + v[i - 1]!) / 1e3;
        expect(Math.abs(capacitor - terminal)).toBeLessThan(1e-12);
      }
      const b = (await simulateProtocolV1(request(rectifier))).analyses[0];
      if (b?.type !== 'tran') throw new Error('Expected core transient');
      // This is a discretisation check, NOT the issue's 1e-9 identical-grid
      // acceptance: core has adaptive points; interpolate only for this bound.
      let j = 0;
      let squaredError = 0;
      for (let i = 0; i < a.timeS.length; i++) {
        const time = a.timeS[i]!;
        while (j + 1 < b.timeS.length - 1 && b.timeS[j + 1]! < time) j++;
        const weight = (time - b.timeS[j]!) / (b.timeS[j + 1]! - b.timeS[j]!);
        const reference = b.voltagesV.out![j]! + weight * (b.voltagesV.out![j + 1]! - b.voltagesV.out![j]!);
        const error = a.voltagesV.out![i]! - reference;
        squaredError += error * error;
        expect(Math.abs(error)).toBeLessThan(5e-5);
      }
      expect(Math.sqrt(squaredError / a.timeS.length)).toBeLessThan(1e-5);
    } finally { await engine.close(); }
  });

  it.each(['CJO=1p', 'TT=1n', 'BV=10', 'IKF=1m'])(
    'rejects unsupported diode model parameter %s without fallback', async parameter => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const result = await engine.simulate(request(clamp.replace('N=1)', `N=1 ${parameter})`)), { requestId: 'unsupported' });
        expect(result).toMatchObject({ ok: false, error: {
          code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'diode-model-parameter' },
        } });
      } finally { await engine.close(); }
    },
  );

  it('rejects other nonlinear devices without fallback', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(clamp.replace('D1 out 0 junction', 'B1 out 0 I=v(out)')), { requestId: 'device' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'device-or-directive' } } });
    } finally { await engine.close(); }
  });

  it('reports bounded per-timestep Newton failure and enforces result point limits', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = clamp.replace('V1 in 0 2', 'V1 in 0 SIN(0 2 100k)');
      expect(await engine.simulate(request(source, { maxTransientIterations: 1 }), { requestId: 'newton-limit' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve', details: { maxIterations: 1 } } });
      expect(await engine.simulate(request(rectifier, { limits: { maxResultPoints: 10 } }), { requestId: 'point-limit' }))
        .toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
    } finally { await engine.close(); }
  });
});
