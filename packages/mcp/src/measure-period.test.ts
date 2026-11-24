import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool } from './server.js';
import { measurementListSchema, measureResult } from './measure.js';

const pulse = '* Original MIT-authored period probe\nV1 out 0 PULSE(0 1 0 1u 1u 499u 1m)\nR1 out 0 1k\n.tran 10u 4m 0 10u\n.end\n';
const signal = [0, 2, 0, 2, 0, 2, 0];
const trace = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 4, 5, 8, 10], voltagesV: { out: signal, ref: signal.map(() => 0) }, currentsA: { v1: signal } }] };
const base = { kind: 'period', signal: 'v(out)', analysis: 0, value: 1, edge: 'rising' };

describe('bounded period and frequency', () => {
  it('measures a real pulse via the public MCP tool', async () => {
    const measurements = ['rising', 'falling'].flatMap(edge => ['period', 'frequency'].map(kind => ({ kind, edge, signal: 'v(out)', analysis: 0, value: 0.5 })));
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source: pulse } }, measurements });
    expect(response.isError).not.toBe(true);
    const values = (response.structuredContent as { measurements: { value: number; unit: string }[] }).measurements;
    for (let i = 0; i < values.length; i++) {
      const expected = i % 2 ? 1000 : 0.001;
      expect(values[i].unit).toBe(i % 2 ? 'Hz' : 's');
      expect(Math.abs(values[i].value / expected - 1)).toBeLessThan(1e-6);
    }
  });

  it('interpolates consecutive crossings on a nonuniform trace and selects windows and signals', () => {
    // Rising crossings are 0.5, 3, and 6.5 seconds: periods 2.5 and 3.5.
    const items = [base, { ...base, kind: 'frequency' }, { ...base, occurrence: 2 },
      { ...base, from: 1, to: 7 }, { ...base, signal: 'i(v1)' }, { ...base, signal: 'v(out,ref)' },
      { ...base, from: 1, to: 6 }, { ...base, occurrence: 3 }];
    expect(measureResult(trace, items).measurements).toEqual([
      { value: 2.5, unit: 's' }, { value: 0.4, unit: 'Hz' }, { value: 3.5, unit: 's' },
      { value: 3.5, unit: 's' }, { value: 2.5, unit: 's' }, { value: 2.5, unit: 's' },
      expect.objectContaining({ error: expect.objectContaining({ code: 'NO_CROSSING' }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: 'NO_CROSSING' }) }),
    ]);
  });

  it('does not count repeated threshold plateaus as crossings', () => {
    const t = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [0, 1, 2, 3, 4, 5, 6, 7], voltagesV: { out: [0, 1, 1, 2, 0, 1, 1, 2] }, currentsA: {} }] };
    expect(measureResult(t, [base, { ...base, occurrence: 2 }, { ...base, from: 1.5 }]).measurements).toMatchObject([
      { value: 4, unit: 's' }, { error: { code: 'NO_CROSSING' } }, { error: { code: 'NO_CROSSING' } },
    ]);
  });

  it('rejects invalid measurement fields and non-transient analyses', () => {
    const invalid = [{ edge: 'either' }, { edge: undefined }, { value: undefined }, { value: NaN }, { value: Infinity },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(occurrence => ({ occurrence })),
      { at: 1 }, { trigger: {} }, { target: {} }];
    expect(measureResult(trace, invalid.map(fields => ({ ...base, ...fields }))).measurements).toMatchObject(invalid.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
    const dc = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 2] }, currentsA: {} }] };
    expect(measureResult(dc, [base, { ...base, kind: 'frequency' }]).measurements).toMatchObject([{ error: { code: 'INVALID_MEASUREMENT' } }, { error: { code: 'INVALID_MEASUREMENT' } }]);
  });

  it('rejects an unrepresentable reciprocal', () => {
    const tiny = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [0, 1e-310, 2e-310, 3e-310], voltagesV: { out: [0, 2, 0, 2] }, currentsA: {} }] };
    expect(measureResult(tiny, [{ ...base, kind: 'frequency' }]).measurements).toMatchObject([{ error: { code: 'NON_FINITE_RESULT' } }]);
  });

  it('advertises the same field requirements in the public schema', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(measurementListSchema);
    expect(validate([base, { ...base, kind: 'frequency', occurrence: 2 }]).valid).toBe(true);
    for (const item of [{ ...base, edge: 'either' }, { ...base, value: undefined }, { ...base, at: 1 }, { ...base, occurrence: 0 }]) {
      expect(validate([item]).valid).toBe(false);
    }
  });
});
