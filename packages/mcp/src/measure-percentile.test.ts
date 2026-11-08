import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { measureResult } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';

const ramp = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 9, 10], voltagesV: { out: [0, 1, 9, 10] }, currentsA: {} }] };
const item = { kind: 'percentile', analysis: 0, signal: 'v(out)', percentile: 25 };
const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 PWL(0 0 3 0 4 4)\nR1 out 0 1k\n.tran 0.01 4' } };

describe('time-weighted percentile', () => {
  it('integrates nonuniform ramp samples and clipped windows', () => {
    const entries = [item, { ...item, percentile: 50 }, { ...item, from: 2, to: 6 }];
    expect(measureResult(ramp, entries).measurements).toEqual([2.5, 5, 3].map(value => ({ value, unit: 'V' })));
    const sparse = { ...ramp, analyses: [{ ...ramp.analyses[0], timeS: [0, 10], voltagesV: { out: [0, 10] } }] };
    expect(measureResult(sparse, entries).measurements).toEqual(measureResult(ramp, entries).measurements);
  });

  it('handles point masses, tied levels, negative descending ramps and endpoints', () => {
    const a = ramp.analyses[0];
    const plateau = { ...ramp, analyses: [{ ...a, timeS: [0, 1, 3, 4], voltagesV: { out: [0, 0, 0, 4] } }] };
    expect(measureResult(plateau, [0, 50, 75, 87.5, 100].map(percentile => ({ ...item, percentile }))).measurements).toEqual([0, 0, 0, 2, 4].map(value => ({ value, unit: 'V' })));
    const down = { ...ramp, analyses: [{ ...a, timeS: [0, 1, 2], voltagesV: { out: [2, -2, 2] } }] };
    expect(measureResult(down, [0, 25, 50, 100].map(percentile => ({ ...item, percentile }))).measurements).toEqual([-2, -1, 0, 2].map(value => ({ value, unit: 'V' })));
    const flat = { ...ramp, analyses: [{ ...a, voltagesV: { out: [-3, -3, -3, -3] } }] };
    expect(measureResult(flat, [0, 50, 100].map(percentile => ({ ...item, percentile }))).measurements).toEqual(Array(3).fill({ value: -3, unit: 'V' }));
  });

  it('selects steps, differential voltage and branch current', () => {
    const a = ramp.analyses[0];
    const stepped = { ...ramp, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index }, voltagesV: { out: [0, 1, 9, 10], ref: [0, 0.5, 4.5, 5] }, currentsA: { v1: [0, -1, -9, -10] } })) };
    const results = measureResult(stepped, [item, { ...item, step: 1, signal: 'v(out,ref)' }, { ...item, step: 0, signal: 'i(v1)' }, { ...item, step: 2 }]).measurements;
    expect(results).toMatchObject([{ error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: 1.25, unit: 'V' }, { value: -7.5, unit: 'A' }, { error: { code: 'UNKNOWN_STEP' } }]);
  });

  it('rejects invalid options, zero-duration windows and non-transient analyses', () => {
    const invalid = [undefined, null, '25', NaN, Infinity, -1, 101].map(percentile => ({ ...item, percentile }));
    const results = measureResult(ramp, [...invalid, { ...item, kind: 'avg' }, { ...item, from: 2, to: 2 }]).measurements;
    expect(results).toMatchObject([...invalid.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })), { error: { code: 'INVALID_MEASUREMENT' } }, { error: { code: 'OUT_OF_RANGE' } }]);
    const op = { status: 'complete' as const, analyses: [{ type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} }] };
    expect(measureResult(op, [item]).measurements).toMatchObject([{ error: { code: 'INVALID_MEASUREMENT' } }]);
    const bad = { ...ramp, analyses: [{ ...ramp.analyses[0], voltagesV: { out: [0, NaN, 9, 10] } }] };
    expect(measureResult(bad, [item]).measurements).toMatchObject([{ error: { code: 'NON_FINITE_RESULT' } }]);
  });

  it('advertises conditional input and validates actual output through the MCP call', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_measure')!;
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const payload = (measurement: unknown) => ({ request, measurements: [measurement] });
    expect(validate(payload(item)).valid).toBe(true);
    for (const bad of [{ ...item, percentile: -1 }, { ...item, percentile: 101 }, { ...item, percentile: '25' }, { kind: 'percentile', analysis: 0, signal: 'v(out)' }, { ...item, kind: 'avg' }]) expect(validate(payload(bad)).valid).toBe(false);
    const response = await executeTool('spice_measure', { request, measurements: [{ ...item, percentile: 87.5 }, { kind: 'avg', analysis: 0, signal: 'v(out)' }] });
    expect(response.isError).not.toBe(true);
    const output = response.structuredContent as { measurements: { value: number; unit: string }[] };
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(output).valid).toBe(true);
    // 3 s at zero, followed by a 1 s ramp to 4 V. CDF(2 V) = 3.5 / 4 = 87.5%.
    expect(output.measurements[0].unit).toBe('V');
    expect(Math.abs(output.measurements[0].value - 2)).toBeLessThan(1e-10);
    expect(output.measurements[1].unit).toBe('V');
    expect(Math.abs(output.measurements[1].value - 0.5)).toBeLessThan(1e-12);
  });
});
