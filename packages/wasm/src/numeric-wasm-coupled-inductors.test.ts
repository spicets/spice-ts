import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT fixtures. Identical netlists/options in both backends.
const windings = 'R1 in a 10\nL1 a 0 10m\nL2 b 0 40m\nR2 b 0 20';
const topologies = [
  { name: 'two-winding K=0.5', devices: `${windings}\nK1 L1 L2 0.5` },
  { name: 'two-winding K=0.99', devices: `${windings}\nK1 L1 L2 0.99` },
  { name: 'three-winding pairwise', devices: `${windings}\nL3 c 0 20m\nR3 c 0 15\nK1 L1 L2 0.5\nK2 L1 L3 0.3\nK3 L2 L3 0.2` },
  { name: 'negative K', devices: `${windings}\nk1 L1 L2 -0.5` },
  { name: 'reversed dot', devices: `${windings.replace('L2 b 0', 'L2 0 b')}\nK1 L1 L2 0.5` },
];
const fixtures = topologies.flatMap(topology => ['op', 'dc', 'tran', 'ac'].map(analysis => ({
  name: `${topology.name} ${analysis}`,
  source: `V1 in 0 ${analysis === 'tran' ? 'PULSE(0 1 20u 10u 10u 200u 500u)' : analysis === 'ac' ? 'DC 1 AC 1' : '1'}\n${topology.devices}\n${analysis === 'dc' ? '.dc V1 -1 1 0.5' : analysis === 'tran' ? '.tran 10u 1m' : analysis === 'ac' ? '.ac dec 5 10 100k' : '.op'}`,
})));
const request = (source: string): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice', source } });
// Shared roundoff allowance for the core controller using different linear solvers.
// Accepted point counts must still match; timestamps are neither rounded nor resampled.
const GRID_ROUNDOFF_S = 1e-15;

function compareVectors(actual: Record<string, number[]>, expected: Record<string, number[]>, relativeOnly = false): number {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  let maximum = 0;
  for (const [name, values] of Object.entries(expected)) {
    expect(actual[name]).toHaveLength(values.length);
    values.forEach((value, i) => {
      const error = Math.abs(actual[name]![i]! - value);
      maximum = Math.max(maximum, error);
      expect(error, `${name}[${i}]`).toBeLessThanOrEqual(relativeOnly ? 1e-9 * Math.abs(value) : Math.max(1e-12, 1e-9 * Math.abs(value)));
    });
  }
  return maximum;
}

describe('WASM constant coupled inductors', () => {
  it.each(fixtures)('matches core nodes, currents and accepted grid: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: name });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(source))).analyses[0];
      let maxAbsoluteError = 0;
      let points = 1;
      if (a?.type === 'op' && b?.type === 'op') {
        for (const field of ['voltagesV', 'currentsA'] as const) {
          const vectors = (record: Record<string, number>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, [value]]));
          maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(vectors(a[field]), vectors(b[field])));
        }
      } else if ((a?.type === 'dc' && b?.type === 'dc') || (a?.type === 'tran' && b?.type === 'tran')) {
        if (a.type === 'dc' && b.type === 'dc') { expect(a.axis).toEqual(b.axis); points = a.axis.values.length; }
        if (a.type === 'tran' && b.type === 'tran') {
          expect(a.timeS).toHaveLength(b.timeS.length);
          points = a.timeS.length;
          const maxTimeDelta = Math.max(...a.timeS.map((time, i) => Math.abs(time - b.timeS[i]!)));
          process.stdout.write(`Coupled grid ${JSON.stringify({ name, points, maxTimeDelta })}\n`);
        }
        for (const field of ['voltagesV', 'currentsA'] as const) maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(a[field], b[field]));
      } else if (a?.type === 'ac' && b?.type === 'ac') {
        expect(a.frequencyHz).toEqual(b.frequencyHz);
        points = a.frequencyHz.length;
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          for (const key of ['magnitude', 'phaseDegrees'] as const) {
            const vectors = (record: typeof a[typeof field]) => Object.fromEntries(Object.entries(record).map(([node, values]) => [node, values.map(value => value[key])]));
            maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(vectors(a[field]), vectors(b[field]), true));
          }
        }
      } else throw new Error('Expected matching analyses');
      process.stdout.write(`Coupled parity ${JSON.stringify({ name, points, maxAbsoluteError })}\n`);
      if (a?.type === 'tran' && b?.type === 'tran') {
        expect(a.timeS).toHaveLength(b.timeS.length);
        a.timeS.forEach((time, i) => expect(Math.abs(time - b.timeS[i]!)).toBeLessThanOrEqual(GRID_ROUNDOFF_S));
      }
    } finally { await wasm.close(); }
  });

  it('normalizes mixed-case coupling references on the adaptive transient reparse', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    const source = `V1 in 0 PULSE(0 1 20u 10u 10u 200u 500u)\n${windings}\nK1 l1 l2 0.5\n.tran 10u 1m`;
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'mixed-case' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(source.replace('K1 l1 l2', 'K1 L1 L2')))).analyses[0];
      expect(a?.type).toBe('tran');
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient analyses');
      expect(a.timeS).toHaveLength(b.timeS.length);
      a.timeS.forEach((time, i) => expect(Math.abs(time - b.timeS[i]!)).toBeLessThanOrEqual(GRID_ROUNDOFF_S));
      compareVectors(a.voltagesV, b.voltagesV);
      compareVectors(a.currentsA, b.currentsA);
    } finally { await wasm.close(); }
  });

  it.each(['op', 'dc', 'tran', 'ac'])('rejects invalid coupling cards with structured errors: %s', async analysis => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    const control = analysis === 'dc' ? '.dc V1 0 1 0.5' : analysis === 'tran' ? '.tran 10u 100u' : analysis === 'ac' ? '.ac lin 1 100 100' : '.op';
    try {
      for (const [card, code] of [
        ['K1 L1 L2 {0.5}', 'UNSUPPORTED_FEATURE'],
        ['K1 L1 L2 0.5+0.1', 'UNSUPPORTED_FEATURE'],
        ['K1 L1 L2', 'UNSUPPORTED_FEATURE'],
        ['K1 L1 L2 0.5 extra', 'UNSUPPORTED_FEATURE'],
        ['K1 L1 L2 1.01', 'INVALID_CIRCUIT'],
        ['K1 L1 L2 -1.01', 'INVALID_CIRCUIT'],
        ['K1 L1 Lmissing 0.5', 'INVALID_CIRCUIT'],
        ['K1 L1 R2 0.5', 'INVALID_CIRCUIT'],
        ['K1 L1 l1 0.5', 'INVALID_CIRCUIT'],
        ['K1 L1 L2 0.5\nL2 c 0 1m', 'INVALID_CIRCUIT'],
      ]) {
        const result = await wasm.simulate(request(`V1 in 0 ${analysis === 'ac' ? 'AC 1' : '1'}\n${windings}\n${card}\n${control}`), { requestId: card! });
        expect(result, card).toMatchObject({ ok: false, error: { code, retryable: false }, metadata: { backend: 'spice-ts-wasm' } });
      }
      expect(await wasm.simulate(request(`V1 in 0 1\nK1 L1 L2 0.5\n${windings}\n${control}`), { requestId: 'forward' }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT', phase: 'validation' } });
    } finally { await wasm.close(); }
  });

  it.each([-1, 0, 1])('accepts boundary and zero coupling k=%s', async k => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(`V1 in 0 AC 1\n${windings}\nK1 l1 l2 ${k}\n.ac lin 1 100 100`), { requestId: 'boundary' }))
        .toMatchObject({ ok: true });
    } finally { await wasm.close(); }
  });

  it('counts inductor branches against the 64-unknown ceiling without adding a K branch', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const count of [31, 32]) {
        const load = Array.from({ length: count }, (_, i) => `R${i + 1} in n${i + 1} 10\nL${i + 1} n${i + 1} 0 1m`).join('\n');
        const result = await wasm.simulate(request(`V1 in 0 1\n${load}\nK1 L1 L2 0.5\n.op`), { requestId: 'ceiling' });
        expect(result).toMatchObject(count === 31 ? { ok: true } : { ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder', configured: 64, observed: 66 } } });
      }
    } finally { await wasm.close(); }
  });
});
