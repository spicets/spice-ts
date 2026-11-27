import { describe, expect, it } from 'vitest';
import { measureResult } from './measure.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const trace = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 3], voltagesV: { out: [0, 2, 0, 2] }, currentsA: {} }] };

describe('crossingCount', () => {
  it('counts crossings rather than selecting one', () => {
    expect(measureResult(trace, [{ kind: 'crossingCount', analysis: 0, signal: 'v(out)', value: 1 }]).measurements).toEqual([{ value: 3, unit: '1' }]);
  });

  it('counts nonuniform contacts inclusively at both boundaries without inventing clipped contacts', () => {
    // Contacts are rising at 1, falling at 4, rising at 8, falling at 13.
    const data = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 2, 6, 10, 16], voltagesV: { out: [0, 2, 0, 2, 0] }, currentsA: {} }] };
    const base = { kind: 'crossingCount', analysis: 0, signal: 'v(out)', value: 1 };
    const specs = [base, { ...base, edge: 'rising' }, { ...base, edge: 'falling' },
      { ...base, from: 4, to: 13 }, { ...base, from: 4, to: 13, edge: 'rising' },
      { ...base, from: 4, to: 13, edge: 'falling' }, { ...base, from: 4.1, to: 12.9 },
      { ...base, from: 1, to: 1 }, { ...base, from: 1.1, to: 3.9 }];
    expect(measureResult(data, specs).measurements).toEqual([4, 2, 2, 3, 1, 2, 1, 1, 0].map(value => ({ value, unit: '1' })));
  });

  it('treats touch-and-return plateaus as a single directional contact at first touch', () => {
    // Rising contact at 1, falling contacts at 4 and 7; the first falling plateau returns above.
    const data = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], voltagesV: { out: [0, 1, 1, 2, 1, 1, 2, 1, 1, 0] }, currentsA: {} }] };
    const base = { kind: 'crossingCount', analysis: 0, signal: 'v(out)', value: 1 };
    const specs = [base, { ...base, edge: 'rising' }, { ...base, edge: 'falling' },
      { ...base, from: 2, to: 7 }, { ...base, from: 1.5, to: 2.5 }];
    // The final plateau is approached from above, so it is falling, not rising.
    expect(measureResult(data, specs).measurements).toEqual([3, 1, 2, 2, 0].map(value => ({ value, unit: '1' })));
    const flat = { ...data, analyses: [{ ...data.analyses[0], voltagesV: { out: Array(10).fill(1) } }] };
    expect(measureResult(flat, [base]).measurements).toEqual([{ value: 0, unit: '1' }]);
    const risingTouch = { ...data, analyses: [{ ...data.analyses[0], timeS: [0, 1, 2, 3], voltagesV: { out: [0, 1, 1, 0] } }] };
    expect(measureResult(risingTouch, [{ ...base, edge: 'rising' }, { ...base, edge: 'falling' }]).measurements).toEqual([{ value: 1, unit: '1' }, { value: 0, unit: '1' }]);
  });

  it('selects differential voltage, current, analysis and step', () => {
    const a = trace.analyses[0];
    const result = { status: 'complete' as const, analyses: [
      { ...a, analysisIndex: 3, step: { index: 0, parameter: 'r', value: 1 }, voltagesV: { out: [0, 2, 0, 2], ref: [0, 0, 0, 0] }, currentsA: { v1: [0, 2, 0, 2] } },
      { ...a, analysisIndex: 3, step: { index: 1, parameter: 'r', value: 2 }, voltagesV: { out: [0, 0, 0, 0], ref: [0, 0, 0, 0] }, currentsA: { v1: [0, 0, 0, 0] } },
    ] };
    const base = { kind: 'crossingCount', analysis: 3, value: 1 };
    expect(measureResult(result, [{ ...base, signal: 'v(OUT,ref)', step: 0 }, { ...base, signal: 'i(V1)', step: 0 }, { ...base, signal: 'v(out)', step: 1 }, { ...base, signal: 'v(out)' }, { ...base, signal: 'v(out)', step: 2 }]).measurements)
      .toMatchObject([{ value: 3, unit: '1' }, { value: 3, unit: '1' }, { value: 0, unit: '1' }, { error: { code: 'AMBIGUOUS_ANALYSIS' } }, { error: { code: 'UNKNOWN_STEP' } }]);
  });

  it('preserves cross semantics for an initial threshold plateau', () => {
    // Existing cross counts the first falling departure at t=1, not each plateau sample.
    const data = { ...trace, analyses: [{ ...trace.analyses[0], voltagesV: { out: [1, 1, 0, 2] } }] };
    const base = { kind: 'crossingCount', analysis: 0, signal: 'v(out)', value: 1 };
    expect(measureResult(data, [base, { ...base, edge: 'falling' }, { ...base, edge: 'rising' }, { ...base, from: 1.1, to: 2.4 }]).measurements)
      .toEqual([2, 1, 1, 0].map(value => ({ value, unit: '1' })));
  });

  it('exposes discovery schema and rejects incompatible fields in schema and evaluator', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    const base = { kind: 'crossingCount', signal: 'v(out)', analysis: 0, value: 1 };
    expect(validate({ request, measurements: [{ ...base, edge: 'either', from: 0, to: 2 }] }).valid).toBe(true);
    const invalid = [{ ...base, value: undefined },
      { ...base, occurrence: 1 }, { ...base, at: 1 }, { ...base, trigger: { signal: 'v(out)', threshold: 1 } },
      { ...base, target: { signal: 'v(out)', threshold: 1 } }];
    for (const item of invalid) {
      expect(validate({ request, measurements: [item] }).valid).toBe(false);
      expect(measureResult(trace, [item]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(measureResult(trace, [{ ...base, value }]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    const dc = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 2] }, currentsA: {} }] };
    expect(measureResult(dc, [base]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
  });

  it('executes a real transient through spice_measure', async () => {
    const source = '* crossing count\nV1 out 0 PWL(0 0 1m 2 2m 0 3m 2)\nR1 out 0 1k\n.tran 10u 3m\n.end';
    const measurements = ['either', 'rising', 'falling'].map(edge => ({ kind: 'crossingCount', analysis: 0, signal: 'v(out)', value: 1, edge }));
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source } }, measurements });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ measurements: [3, 2, 1].map(value => ({ value, unit: '1' })) });
  });
});
