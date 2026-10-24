import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

type Analysis = 'op' | 'dc' | 'tran' | 'ac';
type Fixture = { name: string; body: string; analyses: Analysis[]; output?: number };
type ErrorMetrics = { maxRelativeError: number; maxZeroAbsoluteError: number; values: number };

// Project-authored fixtures. Core must accept each fixture before WASM is tested.
const divider = `.subckt divider a z PARAMS: top=1k bottom=2k
Rtop a z {top}
Rbottom z 0 {bottom}
.ends divider`;
const fixtures: Fixture[] = [
  { name: 'parameter expression defaults', analyses: ['op', 'dc'], output: 0.6,
    body: `.param base=1k
X1 in out divider
.subckt divider a z PARAMS: top={base * 2} bottom={top}
Rtop a z {top}
Rbottom z 0 {bottom}
.ends divider` },
  { name: 'divider defaults', analyses: ['op', 'dc'], output: 0.8,
    body: `X1 in out divider\n${divider}` },
  { name: 'numeric instance override', analyses: ['op', 'dc'], output: 0.6,
    body: `X1 in out divider top=2k\n${divider}` },
  { name: 'top-level parameter expression with whitespace', analyses: ['op', 'dc'], output: 0.48,
    body: `.param base=1k factor=3\nX1 in out divider top={base * factor}\n${divider}` },
  { name: 'nested local parameter propagation', analyses: ['op', 'dc'], output: 0.4,
    body: `X1 in out outer r=2k
.subckt outer a z PARAMS: r=1k
Xchild a z divider top={r * 2}
.ends outer
${divider}` },
  { name: 'RC defaults', analyses: ['tran', 'ac'], body: `X1 in out lowpass
.subckt lowpass a z PARAMS: r=1k c=1u
R1 a z {r}
C1 z 0 {c}
.ends lowpass` },
  { name: 'RC expression overrides', analyses: ['tran', 'ac'], body: `.param base=1k cap=2u
X1 in out lowpass r={base * 2} c={cap / 2}
.subckt lowpass a z PARAMS: r=1k c=1u
R1 a z {r}
C1 z 0 {c}
.ends lowpass` },
];
const directives: Record<Analysis, string> = {
  op: '.op', dc: '.dc VIN 0 1 0.2', tran: '.tran 1u 10u', ac: '.ac dec 3 10 10k',
};
const cases = fixtures.flatMap(fixture => fixture.analyses.map(analysis => ({
  ...fixture, analysis, source: `${analysis === 'tran'
    ? 'VIN in 0 PULSE(0 1.2 2u 1u 1u 3u 8u)'
    : analysis === 'ac' ? 'VIN in 0 DC 1.2 AC 1' : 'VIN in 0 DC 1.2'}\n${fixture.body}\n${directives[analysis]}`,
})));
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

// Every exported numeric value is checked. Nonzero references use relative error;
// zero references use absolute error, with the same analysis-specific tolerance.
function compare(actual: unknown, expected: unknown, tolerance: number, metrics: ErrorMetrics, path = 'analysis'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(Number.isFinite(actual), path).toBe(true);
    const difference = Math.abs((actual as number) - expected);
    metrics.values++;
    if (expected === 0) {
      metrics.maxZeroAbsoluteError = Math.max(metrics.maxZeroAbsoluteError, difference);
      expect(difference, path).toBeLessThanOrEqual(tolerance);
    } else {
      const relative = difference / Math.abs(expected);
      metrics.maxRelativeError = Math.max(metrics.maxRelativeError, relative);
      expect(relative, path).toBeLessThanOrEqual(tolerance);
    }
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect(actual, path).toHaveLength(expected.length);
    expected.forEach((value, index) => compare((actual as unknown[])[index], value, tolerance, metrics, `${path}[${index}]`));
  } else if (expected !== null && typeof expected === 'object') {
    expect(actual, path).not.toBeNull();
    const fields = actual as Record<string, unknown>;
    expect(Object.keys(fields).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) compare(fields[key], value, tolerance, metrics, `${path}.${key}`);
  } else {
    expect(actual, path).toEqual(expected);
  }
}

describe('numeric WASM subcircuit parameters (#1741)', () => {
  it('returns a structured unsupported error for subcircuit-local .param', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      await expect(engine.simulate(request(`VIN in 0 1
X1 in out divider
.subckt divider a z PARAMS: r=1k
.param local=2k
R1 a z {r}
R2 z 0 {local}
.ends divider
.op`), { requestId: 'subckt-local-param' })).resolves.toMatchObject({
        ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'subcircuit-parameters' } },
      });
    } finally { await engine.close(); }
  });

  it.each(cases)('matches core: $name ($analysis)', async ({ source, analysis, name, output }) => {
    const reference = await simulateProtocolV1(request(source));
    expect(reference.analyses).toHaveLength(1);
    const expected = reference.analyses[0]!;
    expect(expected.type).toBe(analysis);
    if (expected.type === 'op' && output !== undefined) {
      expect(expected.voltagesV['out']).toBeCloseTo(output, 12);
    }
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await engine.simulate(request(source), { requestId: 'subckt-params-parity' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      expect(result.data.analyses).toHaveLength(1);
      const actual = result.data.analyses[0]!;
      if (actual.type === 'tran' && expected.type === 'tran') expect(actual.timeS).toEqual(expected.timeS);
      if (actual.type === 'ac' && expected.type === 'ac') expect(actual.frequencyHz).toEqual(expected.frequencyHz);
      if (actual.type === 'dc' && expected.type === 'dc') expect(actual.axis).toEqual(expected.axis);
      const metrics: ErrorMetrics = { maxRelativeError: 0, maxZeroAbsoluteError: 0, values: 0 };
      compare(actual, expected, analysis === 'op' ? 1e-12 : 1e-9, metrics);
      console.info('subckt-params metrics', JSON.stringify({ name, analysis, ...metrics }));
    } finally { await engine.close(); }
  });
});
