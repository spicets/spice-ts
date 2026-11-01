import { describe, expect, it } from 'vitest';
import { dcMetricsResult } from './dc-metrics.js';
import { executeTool } from './server.js';

const trace = {
  status: 'complete' as const,
  analyses: [{ type: 'dc' as const, analysisIndex: 0,
    axis: { name: 'Vin', unit: 'V' as const, values: [0, 1, 2, 3, 4, 5] },
    voltagesV: { out: [5, 4.8, 4.4, 0.6, 0.2, 0] }, currentsA: {} }],
};

describe('DC metric sweep direction', () => {
  it('gives the same transfer metrics for a reversed inverter sweep', () => {
    const a = trace.analyses[0];
    const reversed = { ...trace, analyses: [{ ...a,
      axis: { ...a.axis, values: [...a.axis.values].reverse() },
      voltagesV: { out: [...a.voltagesV.out].reverse() },
    }] };
    const before = structuredClone(reversed);
    const ascending = dcMetricsResult(trace, { sweptSource: 'Vin', output: 'v(out)' });
    const descending = dcMetricsResult(reversed, { sweptSource: 'Vin', output: 'v(out)' });
    for (const key of ['voh', 'vol', 'vil', 'vih', 'nmL', 'nmH', 'switchingThreshold'] as const) {
      expect(descending[key].value).not.toBeNull();
      expect(Math.abs(descending[key].value! - ascending[key].value!)).toBeLessThanOrEqual(1e-12);
    }
    for (const key of ['value', 'input', 'sweepPoint'] as const) {
      expect(Math.abs(descending.gainMax[key]! - ascending.gainMax[key]!)).toBeLessThanOrEqual(1e-12);
    }
    expect(ascending.voh.value).toBe(5);
    expect(ascending.vol.value).toBe(0);
    expect(reversed).toEqual(before);
  });

  it('keeps explicit voltage coordinates aligned with a descending current sweep', () => {
    const a = trace.analyses[0];
    const current = { ...trace, analyses: [{ ...a, axis: { name: 'Iin', unit: 'A' as const, values: [5, 4, 3, 2, 1, 0] },
      voltagesV: { ...a.voltagesV, in: [...a.axis.values] } }] };
    const reversed = { ...current, analyses: [{ ...current.analyses[0],
      axis: { ...current.analyses[0].axis, values: [...current.analyses[0].axis.values].reverse() },
      voltagesV: { in: [...current.analyses[0].voltagesV.in].reverse(), out: [...a.voltagesV.out].reverse() } }] };
    const before = structuredClone(reversed);
    const args = { sweptSource: 'Iin', input: 'v(in)', output: 'v(out)' };
    const forward = dcMetricsResult(current, args);
    const backward = dcMetricsResult(reversed, args);
    expect(backward).toEqual(forward);
    expect(forward.gainMax).toMatchObject({ value: 3.8000000000000003, input: 2.5, sweepPoint: 2.5 });
    expect(reversed).toEqual(before);
  });

  it.each([[0, 1, 1, 3, 4, 5], [0, 1, 3, 2, 4, 5]])('rejects non-strict or nonmonotonic voltage input %s', (...values) => {
    const a = trace.analyses[0];
    const invalid = { ...trace, analyses: [{ ...a, axis: { ...a.axis, values } }] };
    expect(() => dcMetricsResult(invalid, { sweptSource: 'Vin', output: 'v(out)' })).toThrow(/strictly monotonic/);
  });

  it('normalizes descending SPICE and native JSON requests through the registered tool', async () => {
    const ports = (p: string, n: string) => [{ name: 'p', net: p }, { name: 'n', net: n }];
    const components = [
      { type: 'V', id: 'v1', name: 'V1', ports: ports('in', '0'), params: { dc: 0 } },
      { type: 'R', id: 'r1', name: 'R1', ports: ports('in', 'out'), params: { resistance: 1000 } },
      { type: 'R', id: 'r2', name: 'R2', ports: ports('out', '0'), params: { resistance: 1000 } },
    ];
    for (const format of ['spice', 'spice-ts'] as const) {
      const request = (descending: boolean) => format === 'spice'
        ? { apiVersion: '1', input: { format, source: `* divider\nV1 in 0 0\nR1 in out 1k\nR2 out 0 1k\n.dc V1 ${descending ? '4 0 -1' : '0 4 1'}\n.end\n` } }
        : { apiVersion: '1', input: { format, document: { format, schemaVersion: '1.0', models: [], subcircuits: [],
          circuit: { nets: ['in', 'out'], components }, analyses: [{ type: 'dc', source: 'V1',
            start: descending ? 4 : 0, stop: descending ? 0 : 4, step: descending ? -1 : 1 }] } } };
      const run = (descending: boolean) => executeTool('spice_dc_metrics', { request: request(descending), sweptSource: 'V1', output: 'v(out)' });
      const ascending = await run(false);
      const descending = await run(true);
      expect(ascending.isError, JSON.stringify(ascending.structuredContent)).not.toBe(true);
      expect(descending.isError, JSON.stringify(descending.structuredContent)).not.toBe(true);
      expect(descending.structuredContent).toEqual(ascending.structuredContent);
    }
  });

});
