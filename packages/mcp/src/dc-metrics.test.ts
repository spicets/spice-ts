import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/protocol';
import { executeTool } from './server.js';

type Metric = { value: number | null; unit: string; reason?: string; sweepPoint?: number; input?: number };
type Metrics = Record<'gainMax' | 'switchingThreshold' | 'voh' | 'vol' | 'vil' | 'vih' | 'nmL' | 'nmH', Metric> & { monotonic: boolean };
export const divider = '* Original MIT DC divider probe\nVin in 0 0\nR1 in out 1k\nR2 out 0 1k\n.dc Vin 0 5 0.005\n.end\n';
export const inverter = '* Original MIT CMOS transfer probe\nVdd dd 0 5\nVin in 0 0\nMp out in dd dd PM W=20u L=1u\nMn out in 0 0 NM W=10u L=1u\n.model NM NMOS (LEVEL=1 VTO=0.7 KP=120u LAMBDA=0.02)\n.model PM PMOS (LEVEL=1 VTO=-0.7 KP=60u LAMBDA=0.02)\n.dc Vin 0 5 0.005\n.end\n';
const request = (source: string): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice', source } });
async function metrics(source: string, extra = {}) {
  const response = await executeTool('spice_dc_metrics', { request: request(source), sweptSource: 'Vin', output: 'v(out)', ...extra });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as Metrics;
}

describe('spice_dc_metrics', () => {
  it('returns exact divider gain, monotonicity, and explicit undefined crossing reasons', async () => {
    const m = await metrics(divider);
    expect(m.gainMax.value).toBe(0.5);
    expect(m.gainMax.unit).toBe('V/V');
    expect(m.monotonic).toBe(true);
    expect(m.voh.value).toBe(0);
    expect(m.vol.value).toBe(2.5);
    for (const key of ['switchingThreshold', 'vil', 'vih', 'nmL', 'nmH'] as const) {
      expect(m[key]).toMatchObject({ value: null, reason: expect.any(String), unit: 'V' });
    }
    expect((await metrics(divider, { input: 'V(IN)' })).gainMax.value).toBeCloseTo(0.5, 12);
  });

  it('matches independently interpolated CMOS raw-sweep metrics within 1 mV', async () => {
    const raw = await simulateProtocolV1(request(inverter));
    const a = raw.analyses.find(a => a.type === 'dc');
    if (!a || a.type !== 'dc') throw new Error('Missing DC sweep');
    const x = a.axis.values; const y = a.voltagesV.out;
    // Independent raw-vector oracle: secant gains at interval midpoints.
    const slopes = x.slice(1).map((v, i) => (y[i + 1] - y[i]) / (v - x[i]));
    const mid = x.slice(1).map((v, i) => (v + x[i]) / 2);
    const roots = (axis: number[], values: number[], target: number) => values.slice(1).flatMap((v, i) => {
      const prev = values[i];
      return (prev < target && v >= target) || (prev > target && v <= target)
        ? [axis[i] + (target - prev) * (axis[i + 1] - axis[i]) / (v - prev)] : [];
    });
    const vm = roots(x, y.map((v, i) => v - x[i]), 0)[0];
    const [vil, vih] = roots(mid, slopes, -1);
    const expected = { switchingThreshold: vm, vil, vih, nmL: vil - y.at(-1)!, nmH: y[0] - vih };
    const m = await metrics(inverter);
    for (const [key, value] of Object.entries(expected)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(m[key as keyof typeof expected].value! - value)).toBeLessThan(0.001);
    }
    expect(m.gainMax.value).toBeCloseTo(Math.max(...slopes.map(Math.abs)), 10);
    expect(m.monotonic).toBe(true);
    expect(m.voh.value).toBe(y[0]);
    expect(m.vol.value).toBe(y.at(-1));
    expect(JSON.stringify(m)).not.toMatch(/voltagesV|currentsA/);
  });

  it('advertises the tool', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_dc_metrics']) });
  });

  it.each([
    ['missing DC', 'Vin out 0 1\nR1 out 0 1k\n.op', {}],
    ['unknown output', divider, { output: 'v(absent)' }],
    ['unknown input', divider, { input: 'v(absent)' }],
    ['wrong source', divider, { sweptSource: 'absent' }],
    ['non-voltage output', divider, { output: 'i(Vin)' }],
    ['nonmonotonic input', inverter, { input: 'v(out)' }],
    ['invalid fields', divider, { output: 4 }],
  ])('returns structured errors for %s', async (_label, source, extra) => {
    const response = await executeTool('spice_dc_metrics', { request: request(source), sweptSource: 'Vin', output: 'v(out)', ...extra });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', message: expect.any(String) } } });
  });
});
