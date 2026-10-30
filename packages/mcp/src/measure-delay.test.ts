import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { MCP_TOOLS } from './server.js';
import { simulate } from '@spice-ts/core';
import { executeTool } from './server.js';
import { measurementListSchema, measureResult } from './measure.js';

const trace = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 3, 4, 5, 6], voltagesV: { input: [0, 2, 0, 0, 2, 0, 0], output: [0, 0, 2, 0, 0, 2, 0] }, currentsA: {} }] };
const delay = { kind: 'delay', analysis: 0, trigger: { signal: 'v(input)', threshold: 1, edge: 'rising', occurrence: 2 }, target: { signal: 'v(output)', threshold: 1, edge: 'rising', occurrence: 2 } };

describe('transient delay measurements', () => {
  it('counts an initial threshold departure as the first falling crossing', () => {
    const input = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 3, 4], voltagesV: { a: [1, 0, 2, 0, 0] }, currentsA: {} }] };
    const fall = { signal: 'v(a)', threshold: 1, edge: 'falling' };
    const item = { kind: 'delay', analysis: 0, trigger: fall, target: fall };
    const flat = { ...input, analyses: [{ ...input.analyses[0], timeS: [0, 1, 2], voltagesV: { a: [1, 0, 0] } }] };
    expect(measureResult(flat, [item]).measurements).toEqual([{ value: 0, unit: 's' }]);
    expect(measureResult(input, [item, { ...item, target: { ...fall, occurrence: 2 } }]).measurements).toEqual([
      { value: 0, unit: 's' }, { value: 2.5, unit: 's' },
    ]);
  });
  it('includes trigger and target crossings exactly at the lower window boundary', () => {
    const boundary = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2], voltagesV: { a: [0, 2, 2], b: [0, 0, 2] }, currentsA: {} }] };
    const item = { kind: 'delay', analysis: 0, trigger: { signal: 'v(a)', threshold: 1, edge: 'rising' }, target: { signal: 'v(b)', threshold: 1, edge: 'rising' }, from: 0.5, to: 2 };
    expect(measureResult(boundary, [item, { ...item, trigger: item.target, target: item.trigger }]).measurements).toEqual([{ value: 1, unit: 's' }, { value: -1, unit: 's' }]);
  });
  it('aligns advertised conditional fields with evaluator validation', () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_measure')!;
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    const normal = { kind: 'max', analysis: 0, signal: 'v(input)' };
    const cases = [delay, normal, ...['signal', 'at', 'value', 'edge'].map(key => ({ ...delay, [key]: key === 'signal' ? 'v(input)' : key === 'edge' ? 'rising' : 1 })), ...['trigger', 'target'].map(key => ({ ...normal, [key]: delay.trigger }))];
    for (const [i, measurement] of cases.entries()) {
      const expected = i < 2;
      expect(validate({ request, measurements: [measurement] }).valid, `schema case ${i}`).toBe(expected);
      expect(!('error' in measureResult(trace, [measurement]).measurements[0]), `evaluator case ${i}`).toBe(expected);
    }
  });

  it('selects trigger and target occurrences independently with distinct delays', () => {
    const distinct = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 3, 4, 5, 6, 7], voltagesV: { input: [0, 2, 0, 0, 2, 0, 0, 0], output: [0, 0, 2, 0, 0, 0, 2, 0] }, currentsA: {} }] };
    const select = (trigger: number, target: number) => ({ ...delay, trigger: { ...delay.trigger, occurrence: trigger }, target: { ...delay.target, occurrence: target } });
    expect(measureResult(distinct, [select(1, 1), select(1, 2), select(2, 1), select(2, 2)]).measurements).toEqual([1, 5, -2, 2].map(value => ({ value, unit: 's' })));
  });

  it('matches core text TRIG/TARG on the very same pulse/RC waveform grid', async () => {
    const source = 'V1 in 0 PULSE(0 1 0 1u 1u 3m 6m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 5m\n.meas tran prop trig v(in) val=0.5 rise=1 targ v(out) val=0.5 rise=1\n.end';
    const core = await simulate(`RC delay\n${source}`);
    const tran = core.transient!;
    const sameGrid = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [...tran.time], voltagesV: { in: [...tran.voltage('in')], out: [...tran.voltage('out')] }, currentsA: {} }] };
    const item = { kind: 'delay', analysis: 0, trigger: { signal: 'v(in)', threshold: 0.5, edge: 'rising' }, target: { signal: 'v(out)', threshold: 0.5, edge: 'rising' } };
    const actual = measureResult(sameGrid, [item]).measurements[0];
    const reference = core.measurements?.find(m => m.name === 'prop');
    expect(reference).toMatchObject({ status: 'ok', value: expect.any(Number) });
    expect(actual).toMatchObject({ unit: 's', value: expect.any(Number) });
    if ('error' in actual || reference?.value === undefined) throw new Error('measurement failed');
    console.log('RC delay seconds', { mcp: actual.value, core: reference.value, delta: actual.value - reference.value });
    expect(Math.abs(actual.value - reference.value)).toBeLessThan(1e-9);
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source } }, measurements: [item] });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ measurements: [{ value: actual.value, unit: 's' }] });
  });

  it('validates occurrences and isolates missing crossings and unknown signals', () => {
    const measurements = [
      ...[0, -1, 1.5, null, Infinity].map(occurrence => ({ ...delay, trigger: { ...delay.trigger, occurrence } })),
      { ...delay, target: { ...delay.target, threshold: 3 } },
      { ...delay, trigger: { ...delay.trigger, signal: 'v(missing)' } },
      { ...delay, target: { ...delay.target, signal: 'v(missing)' } },
    ];
    expect(measureResult(trace, measurements).measurements).toMatchObject([
      ...Array(5).fill({ error: { code: 'INVALID_MEASUREMENT' } }),
      { error: { code: 'NO_CROSSING' } }, { error: { code: 'UNKNOWN_SIGNAL' } }, { error: { code: 'UNKNOWN_SIGNAL' } },
    ]);
    expect(measurementListSchema.items.properties).toHaveProperty('trigger');
    expect(measurementListSchema.items.properties).toHaveProperty('target');
  });

  it('selects step metadata and counts crossings inside the selected window', () => {
    const analysis = trace.analyses[0];
    const stepped = { ...trace, analyses: [{ ...analysis, step: { index: 0, parameter: 'r', value: 1 } }, { ...analysis, step: { index: 2, parameter: 'r', value: 2 } }] };
    expect(measureResult(stepped, [delay, { ...delay, step: 1 }, { ...delay, step: 2 }]).measurements).toMatchObject([
      { error: { code: 'AMBIGUOUS_ANALYSIS' } }, { error: { code: 'UNKNOWN_STEP' } }, { value: 1, unit: 's' },
    ]);
    const first = { ...delay, trigger: { ...delay.trigger, occurrence: 1 }, target: { ...delay.target, occurrence: 1 }, from: 3, to: 6 };
    expect(measureResult(trace, [first, { ...first, to: 4 }, { ...first, from: -1 }]).measurements).toMatchObject([
      { value: 1 }, { error: { code: 'NO_CROSSING' } }, { error: { code: 'OUT_OF_RANGE' } },
    ]);
  });

  it('supports falling and either edges and signed delays', () => {
    const item = { ...delay, trigger: { ...delay.trigger, edge: 'falling', occurrence: 1 }, target: { ...delay.target, edge: 'either', occurrence: 1 } };
    expect(measureResult(trace, [item, { ...item, trigger: item.target, target: item.trigger }]).measurements).toEqual([{ value: 0, unit: 's' }, { value: 0, unit: 's' }]);
    expect(measureResult(trace, [{ ...delay, trigger: delay.target, target: delay.trigger }]).measurements).toEqual([{ value: -1, unit: 's' }]);
  });
});
