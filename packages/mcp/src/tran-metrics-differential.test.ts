import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';
import { tranMetrics } from './tran-metrics.js';

const trace = (scale = 1, index = 0) => ({
  type: 'tran' as const, analysisIndex: 2, step: { index, parameter: 'R1', value: scale },
  timeS: [0, 1, 2, 3, 10].map(t => t * scale),
  voltagesV: { a: [5, 6, 7.5, 7, 7], b: [5, 5, 5, 5, 5], ref: [0, 1, 2.5, 2, 2] }, currentsA: { V1: [0, 1, 2.5, 2, 2] },
});
const result: SimulationResultV1 = { status: 'complete', analyses: [trace()] };
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
const dummy = request('V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end');

function compare(actual: unknown, expected: unknown) {
  expect(actual).toBeTypeOf('object');
  expect(expected).toBeTypeOf('object');
  const a = actual as Record<string, unknown>; const e = expected as Record<string, unknown>;
  expect(Object.keys(a).sort()).toEqual(Object.keys(e).sort());
  for (const key of Object.keys(e)) {
    if (typeof e[key] === 'number') {
      expect(Number.isFinite(a[key])).toBe(true);
      expect(Math.abs((a[key] as number) - (e[key] as number))).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(e[key] as number));
    } else expect(a[key]).toEqual(e[key]);
  }
}

describe('differential transient metrics', () => {
  it('matches a single-ended reference with common mode', () => {
    const expected = tranMetrics(result, { signal: 'v(ref)' });
    expect(expected).toMatchObject({ initialValue: 0, finalValue: 2, overshootPercent: 25 });
    compare(tranMetrics(result, { signal: 'v(a,b)' }), expected);
  });

  it('compares real two-source public-route rising and falling responses to independent sources', async () => {
    for (const [wave, shifted] of [
      ['0 0 1m 1 2m 2.5 3m 2 10m 2', '0 5 1m 6 2m 7.5 3m 7 10m 7'],
      ['0 2 1m 1 2m -0.5 3m 0 10m 0', '0 7 1m 6 2m 4.5 3m 5 10m 5'],
    ]) {
      const suffix = '\n.tran 0.1m 10m\n.end';
      const differential = await executeTool('spice_tran_metrics', { request: request(`VA a 0 PWL(${shifted})\nVB b 0 5${suffix}`), signal: 'v(a,b)' });
      const reference = await executeTool('spice_tran_metrics', { request: request(`VR ref 0 PWL(${wave})${suffix}`), signal: 'v(ref)' });
      expect(differential.isError).not.toBe(true); expect(reference.isError).not.toBe(true);
      compare(differential.structuredContent, reference.structuredContent);
    }
  });

  it('supports aliases, case, whitespace, literal precedence and legacy signals', () => {
    const a = tranMetrics(result, { signal: 'v(a)' });
    compare(tranMetrics(result, { signal: 'V( A , GnD )' }), a);
    compare(tranMetrics(result, { signal: 'v(a,0)' }), a);
    const negative = tranMetrics(result, { signal: 'v(0, A)' });
    const negativeRef: SimulationResultV1 = { status: 'complete', analyses: [{ ...trace(), voltagesV: { neg: trace().voltagesV.a.map(v => -v) } }] };
    compare(negative, tranMetrics(negativeRef, { signal: 'v(neg)' }));
    compare(tranMetrics(result, { signal: 'v(gnd,a)' }), negative);
    const reference = tranMetrics(result, { signal: 'v(ref)' });
    compare(tranMetrics(result, { signal: 'i(v1)' }), { ...reference, unit: 'A', slewUnit: 'A/s' });
    const literal: SimulationResultV1 = { status: 'complete', analyses: [{ ...trace(), voltagesV: { ...trace().voltagesV, 'a,b': [0, 2, 5, 4, 4], ' a ': [0, 2, 5, 4, 4] } }] };
    compare(tranMetrics(literal, { signal: 'v(a,b)' }), tranMetrics(literal, { signal: 'v( a )' }));
  });

  it('returns structured errors for malformed or absent terminals and keeps cancellation semantics', async () => {
    for (const signal of ['v(a,)', 'v(,b)', 'v(a,b,c)', 'v(a,missing)', 'v(missing,0)', 'v(a,b', 'i(a,b)']) {
      const response = await executeTool('spice_tran_metrics', { request: dummy, signal }, { simulate: async () => result });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'SIGNAL_NOT_FOUND' } } });
    }
    expect(tranMetrics(result, { signal: 'v(a,a)' })).toMatchObject({ error: { code: 'NO_TRANSITION' } });
  });

  it('selects steps without mutating traces and rejects ambiguity', async () => {
    const stepped: SimulationResultV1 = { status: 'complete', analyses: [trace(1, 7), trace(2, 3)] };
    const before = structuredClone(stepped);
    const run = (extra: object) => executeTool('spice_tran_metrics', { request: dummy, signal: 'v(a,b)', ...extra }, { simulate: async () => stepped });
    expect(await run({ analysis: 2 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_TRANSIENT' } } });
    for (const step of [7, 3]) {
      const selected = stepped.analyses.find(a => a.step?.index === step)!;
      const reference = tranMetrics({ status: 'complete', analyses: [selected] }, { signal: 'v(ref)' });
      const response = await run({ analysis: 2, step });
      expect(response.isError).not.toBe(true); compare(response.structuredContent, reference);
    }
    expect(stepped).toEqual(before);
  });

  it('rejects mismatched, nonfinite and overflowing differential data', () => {
    for (const bad of [[5], [5, 5, NaN, 5, 5], [5, 5, Infinity, 5, 5], [-Number.MAX_VALUE, 5, 5, 5, 5]]) {
      const original = trace();
      if (bad[0] === -Number.MAX_VALUE) original.voltagesV.a[0] = Number.MAX_VALUE;
      const corrupted: SimulationResultV1 = { status: 'complete', analyses: [{ ...original, voltagesV: { ...original.voltagesV, b: bad } }] };
      expect(tranMetrics(corrupted, { signal: 'v(a,b)' })).toMatchObject({ error: { code: 'INVALID_DATA' } });
    }
  });
});
