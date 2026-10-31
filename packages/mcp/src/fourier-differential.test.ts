import { describe, expect, it } from 'vitest';
import { ngspiceFourier, simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';

const source = '* differential Fourier\nV1 a 0 SIN(2 1 1k)\nV2 b 0 SIN(0.5 0.25 1k)\nR1 a 0 1k\nR2 b 0 1k\n.tran 1u 5m 0 1u\n.end';
const request = { apiVersion: '1' as const, input: { format: 'spice' as const, source } };
const base = { request, signal: 'v(a,b)', fundamentalHz: 1000, harmonicCount: 3 };
type Metrics = { dc: number; unit: string; harmonics: { magnitude: number; phase: number }[] };

async function run(signal: string, result?: SimulationResultV1, extra: object = {}) {
  return executeTool('spice_fourier', { ...base, signal, ...extra }, result ? { simulate: async () => result } : undefined);
}
function trace(voltagesV: Record<string, number[]>, timeS = Array.from({ length: 1001 }, (_, i) => i * 0.000005)): SimulationResultV1 {
  return { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS, voltagesV, currentsA: {} }] };
}
function sine(offset: number, amp: number, timeS: number[]) { return timeS.map(t => offset + amp * Math.sin(2 * Math.PI * 1000 * t)); }
function compare(actual: Metrics, expected: Metrics) {
  expect(actual.unit).toBe('V');
  expect(Math.abs(actual.dc - expected.dc)).toBeLessThan(1e-9);
  expect(actual.harmonics).toHaveLength(expected.harmonics.length);
  actual.harmonics.forEach((row, i) => {
    expect(Math.abs(row.magnitude - expected.harmonics[i].magnitude)).toBeLessThan(1e-9);
    if (expected.harmonics[i].magnitude > 1e-9) expect(Math.abs(row.phase - expected.harmonics[i].phase)).toBeLessThan(1e-7);
  });
}

describe('spice_fourier differential voltages', () => {
  it('matches a pointwise oracle for a real two-source transient', async () => {
    const result = await simulateProtocolV1(request);
    const a = result.analyses[0];
    if (a.type !== 'tran') throw new Error('expected transient');
    const diff = a.voltagesV.a.map((v, i) => v - a.voltagesV.b[i]);
    const oracle = ngspiceFourier('oracle', Float64Array.from(a.timeS), Float64Array.from(diff), 1000, 4, 200, 1, 1);
    const response = await run('v(a,b)');
    expect(response, JSON.stringify(response)).not.toHaveProperty('isError', true);
    const actual = response.structuredContent as Metrics;
    compare(actual, { dc: oracle.harmonics[0].magnitude, unit: 'V', harmonics: oracle.harmonics.slice(1) });
    console.log('oracle/actual DC and fundamental', oracle.harmonics[0].magnitude, actual.dc, oracle.harmonics[1].magnitude, actual.harmonics[0].magnitude);
  });

  it('resolves ground on either side, case, whitespace and literal-name collisions', async () => {
    const times = Array.from({ length: 1001 }, (_, i) => i * 0.000005);
    const result = trace({ A: sine(2, 1, times), b: sine(0.5, 0.25, times), 'a,b': sine(4, 2, times), ' a,b ': sine(8, 3, times) }, times);
    async function metrics(signal: string) {
      const response = await run(signal, result);
      expect(response, JSON.stringify(response)).not.toHaveProperty('isError', true);
      return response.structuredContent as Metrics;
    }
    compare(await metrics('v(a,b)'), await metrics('v(A,B)'));
    const literal = await metrics('v(a,b)');
    expect(literal.dc).toBeCloseTo(4, 8);
    expect(literal.harmonics[0].magnitude).toBeCloseTo(2, 4);
    const whitespaceLiteral = await metrics('v( a,b )');
    expect(whitespaceLiteral.dc).toBeCloseTo(8, 8);
    const differential = await metrics('v( A , b )');
    expect(differential.dc).toBeCloseTo(1.5, 8);
    expect(differential.harmonics[0].magnitude).toBeCloseTo(0.75, 4);
    compare(await metrics('v(A, 0)'), await metrics('v(a)'));
    compare(await metrics('v(A, GND)'), await metrics('v(a)'));
    const neg = await metrics('v(0, A)');
    const negAlias = await metrics('v(gNd, a)');
    compare(neg, negAlias);
    expect(neg.dc).toBeCloseTo(-2, 8);
    expect(neg.harmonics[0].magnitude).toBeCloseTo(1, 4);
  });

  it.each(['v(a,missing)', 'v(missing,b)', 'v(a,)', 'v(,b)', 'v(a,b,c)', 'v(a,,b)', 'v(a,b', 'i(a,b)'])('rejects missing or malformed selector %s', async signal => {
    const time = Array.from({ length: 1001 }, (_, i) => i * 0.000005);
    const response = await run(signal, trace({ a: sine(0, 1, time), b: sine(0, 0.5, time) }, time));
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNKNOWN_SIGNAL' } } });
  });

  it('reports a zero fundamental for equal real source waveforms with different offsets', async () => {
    const equal = source.replace('SIN(0.5 0.25 1k)', 'SIN(1 1 1k)');
    const response = await executeTool('spice_fourier', { ...base, request: { apiVersion: '1', input: { format: 'spice', source: equal } } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_DATA' } } });
  });

  it('retains a small but resolvable differential signal', async () => {
    const time = Array.from({ length: 1001 }, (_, i) => i * 0.000005);
    const result = trace({ a: sine(1, 1e-12, time), b: time.map(() => 1) }, time);
    const response = await run('v(a,b)', result);
    expect(response.isError).not.toBe(true);
    expect((response.structuredContent as Metrics).harmonics[0].magnitude).toBeGreaterThan(9e-13);
  });

  it('rejects misaligned differential data and a zero fundamental without NaN', async () => {
    const time = Array.from({ length: 1001 }, (_, i) => i * 0.000005);
    const samples = sine(0, 0.25, time);
    // Binary-exact samples yield a constant difference despite different DC offsets.
    const quantized = samples.map(v => Math.round(v * 1024) / 1024);
    const constant = trace({ a: quantized.map(v => v + 2), b: quantized.map(v => v + 1) }, time);
    for (const result of [constant, trace({ a: samples, b: samples.slice(1) }, time)]) {
      const response = await run('v(a,b)', result);
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_DATA' } } });
      expect(JSON.stringify(response)).not.toContain('NaN');
    }
  });

  it('matches real stepped differential traces to standalone simulations', async () => {
    const deck = (resistance: string, step = '') => `* stepped differential\nV1 a 0 SIN(2 1 1k)\nV2 in 0 SIN(0.5 0.5 1k)\nR1 in b 1k\nR2 b 0 ${resistance}\n.tran 1u 5m 0 1u\n${step}\n.end`;
    const steppedRequest = { apiVersion: '1', input: { format: 'spice', source: deck('1k', '.step R2 list 1k 3k') } };
    const call = (req: unknown, extra: object = {}) => executeTool('spice_fourier', { ...base, request: req, ...extra });
    expect(await call(steppedRequest)).toMatchObject({ isError: true, structuredContent: { error: { code: 'AMBIGUOUS_ANALYSIS' } } });
    for (const [step, resistance] of [[0, '1k'], [1, '3k']] as const) {
      const selected = await call(steppedRequest, { analysis: 0, step });
      const standalone = await call({ apiVersion: '1', input: { format: 'spice', source: deck(resistance) } });
      expect(selected.isError).not.toBe(true);
      expect(standalone.isError).not.toBe(true);
      compare(selected.structuredContent as Metrics, standalone.structuredContent as Metrics);
    }
  });

  it('selects each step and analysis without combining traces', async () => {
    const time = Array.from({ length: 1001 }, (_, i) => i * 0.000005);
    const make = (index: number) => ({ type: 'tran' as const, analysisIndex: 2, step: { index, parameter: 'R2', value: index }, timeS: time, voltagesV: { a: sine(2, 1 + index, time), b: sine(0.5, 0.25, time) }, currentsA: {} });
    const traces = [make(0), make(1)];
    const stepped: SimulationResultV1 = { status: 'complete', analyses: traces };
    for (const [extra, code] of [[{ analysis: 2 }, 'AMBIGUOUS_ANALYSIS'], [{ analysis: 2, step: 2 }, 'UNKNOWN_STEP'], [{ analysis: 1, step: 0 }, 'NO_TRANSIENT']] as const) {
      expect(await run('v(a,b)', stepped, extra)).toMatchObject({ isError: true, structuredContent: { error: { code } } });
    }
    for (const step of [0, 1]) {
      const selected = await run('v(a,b)', stepped, { analysis: 2, step });
      const standalone = await run('v(a,b)', { status: 'complete', analyses: [traces[step]] }, { analysis: 2 });
      expect(selected.isError).not.toBe(true);
      expect(standalone.isError).not.toBe(true);
      compare(selected.structuredContent as Metrics, standalone.structuredContent as Metrics);
      expect((selected.structuredContent as Metrics).harmonics[0].magnitude).toBeCloseTo(0.75 + step, 3);
    }
  });
});
