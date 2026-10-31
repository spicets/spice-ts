import { describe, expect, it } from 'vitest';
import { dcMetricsInput, dcMetricsProperties, dcMetricsResult } from './dc-metrics.js';
import { executeTool } from './server.js';

const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0,
  axis: { name: 'Vin', unit: 'V' as const, values: [0, 1, 2, 3] },
  voltagesV: { ip: [10, 12, 14, 16], im: [10, 11, 12, 13], op: [25, 24, 23, 22], om: [20, 21, 22, 23], x: [0, 1, 2, 3], y: [5, 3, 1, -1] }, currentsA: {} }] };

describe('differential DC metrics', () => {
  it('matches independently formed difference vectors with common-mode offsets', () => {
    const before = structuredClone(result);
    const input = dcMetricsInput({ sweptSource: 'Vin', input: 'V(IP,IM)', output: 'v(OP,OM)' });
    const actual = dcMetricsResult(result, input);
    const expected = dcMetricsResult(result, { sweptSource: 'Vin', input: 'v(x)', output: 'v(y)' });
    expect(actual).toEqual(expected);
    expect(actual.gainMax.value).toBe(2);
    expect(Math.abs(actual.switchingThreshold.value! - 5 / 3)).toBeLessThan(1e-12);
    expect(result).toEqual(before);
  });

  it.each(['v()', 'v(,a)', 'v(a,)', 'v(a,b,c)', 'v(a,,b)', 'v(v(a),b)', 'v( ,b)', 'i(a,b)'])('rejects malformed expression %s consistently with the schema', signal => {
    expect(new RegExp(dcMetricsProperties.output.pattern).test(signal)).toBe(false);
    expect(() => dcMetricsInput({ sweptSource: 'Vin', output: signal })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => dcMetricsInput({ sweptSource: 'Vin', output: 'v(x)', input: signal })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it.each(['v(x,missing)', 'v(missing,0)', 'v(0,missing)'])('rejects unknown nodes in %s', output => {
    expect(() => dcMetricsResult(result, { sweptSource: 'Vin', output })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('validates finite aligned terminal vectors and monotonic differential input', () => {
    for (const bad of [[10, 11], [10, NaN, 12, 13], [10, 11, Infinity, 13], [10, 12, 14, 16]]) {
      const altered = { ...result, analyses: [{ ...result.analyses[0], voltagesV: { ...result.analyses[0].voltagesV, im: bad } }] };
      expect(() => dcMetricsResult(altered, { sweptSource: 'Vin', input: 'v(ip,im)', output: 'v(y)' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
    const current = { ...result, analyses: [{ ...result.analyses[0], axis: { ...result.analyses[0].axis, unit: 'A' as const } }] };
    expect(() => dcMetricsResult(current, { sweptSource: 'Vin', output: 'v(op,om)' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(dcMetricsResult(current, { sweptSource: 'Vin', input: 'v(ip,im)', output: 'v(op,om)' }).gainMax.value).toBe(2);
  });

  it('runs native JSON through the registered tool with ground and case-insensitive differential inputs', async () => {
    const ports = (p: string, n: string) => [{ name: 'p', net: p }, { name: 'n', net: n }];
    const request = { apiVersion: '1', input: { format: 'spice-ts', document: {
      format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
      circuit: { nets: ['in', 'out'], components: [
        { type: 'V', id: 'v1', name: 'V1', ports: ports('in', '0'), params: { dc: 0 } },
        { type: 'R', id: 'r1', name: 'R1', ports: ports('in', 'out'), params: { resistance: 1000 } },
        { type: 'R', id: 'r2', name: 'R2', ports: ports('out', '0'), params: { resistance: 1000 } },
      ] }, analyses: [{ type: 'dc', source: 'V1', start: 0, stop: 4, step: 1 }],
    } } };
    const before = structuredClone(request);
    const run = (input: string, output: string) => executeTool('spice_dc_metrics', { request, sweptSource: 'v1', input, output });
    const base = await run('v(in)', 'v(out)');
    expect(base.isError, JSON.stringify(base.structuredContent)).not.toBe(true);
    expect((await run('V(IN,0)', 'v(OUT,0)')).structuredContent).toEqual(base.structuredContent);
    const reverse = await run('v(0,IN)', 'V(0,OUT)');
    expect(reverse.isError, JSON.stringify(reverse.structuredContent)).not.toBe(true);
    expect(reverse.structuredContent).toMatchObject({ gainMax: { value: 0.5 }, voh: { value: 0 }, vol: { value: -2 } });
    const invalid = await run('v(in,0)', 'v(out,missing)');
    expect(invalid).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    expect(await run('v(in,0)', 'v(out,,0)')).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    expect(request).toEqual(before);
  });
});
