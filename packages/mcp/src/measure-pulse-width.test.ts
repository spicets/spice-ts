import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { simulateProtocolV1 } from '@spice-ts/core';
import { measureResult } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';

const trace = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 4, 7], voltagesV: { out: [0, 2, 2, 0, 0] }, currentsA: {} }] };
const pulse = { kind: 'pulseWidth', signal: 'v(out)', analysis: 0, value: 1, edge: 'rising' };
const makeTrace = (timeS: number[], out: number[]) => ({ ...trace, analyses: [{ ...trace.analyses[0], timeS, voltagesV: { out } }] });
const code = (name: string) => ({ error: { code: name } });
const close = (actual: unknown, expected: number) => {
  expect(actual).toMatchObject({ value: expect.any(Number), unit: 's' });
  expect(Math.abs((actual as { value: number }).value - expected)).toBeLessThanOrEqual(1e-12 * (1 + Math.abs(expected)));
};

describe('complete pulse widths', () => {
  it('interpolates a complete high and low pulse on nonuniform axes', () => {
    close(measureResult(trace, [pulse]).measurements[0], 2.5);
    const low = makeTrace([0, 1, 2, 4, 7], [2, 0, 0, 2, 2]);
    close(measureResult(low, [{ ...pulse, edge: 'falling' }]).measurements[0], 2.5);
  });

  it('skips the leading incomplete pulse and counts complete pairs in the window', () => {
    const t = makeTrace([0, 1, 2, 3, 4, 6, 8, 9, 10, 12], [2, 0, 0, 2, 0, 0, 2, 2, 0, 2]);
    const results = measureResult(t, [pulse, { ...pulse, occurrence: 2 }, { ...pulse, occurrence: 3 }, { ...pulse, from: 3, to: 10 }, { ...pulse, from: 3.1, to: 10 }]).measurements;
    close(results[0], 1);
    close(results[1], 2.5);
    expect(results[2]).toMatchObject(code('NO_CROSSING'));
    close(results[3], 2.5);
    close(results[4], 2.5);
  });

  it('counts first threshold contact at exact knots, with plateaus producing no extra crossings', () => {
    // Entry 1, exit 4. Leaving a plateau is not another crossing.
    const t = makeTrace([0, 1, 2, 3, 4, 5, 6], [0, 1, 1, 2, 1, 1, 0]);
    close(measureResult(t, [pulse]).measurements[0], 3);
    expect(measureResult(t, [{ ...pulse, from: 1.5 }]).measurements[0]).toMatchObject(code('NO_CROSSING'));
  });

  it('reports missing crossings, trailing incomplete pulses and invalid arrays', () => {
    expect(measureResult(trace, [{ ...pulse, value: 5 }, { ...pulse, to: 2 }]).measurements).toMatchObject([code('NO_CROSSING'), code('NO_CROSSING')]);
    const invalid = [makeTrace([], []), makeTrace([0, 1], [0]), makeTrace([0, 1], [0, NaN]), makeTrace([0, 1, 1], [0, 2, 0]), makeTrace([2, 1, 0], [0, 2, 0])];
    expect(invalid.map(t => measureResult(t, [pulse]).measurements[0])).toMatchObject([code('NON_FINITE_RESULT'), code('NON_FINITE_RESULT'), code('NON_FINITE_RESULT'), code('INVALID_MEASUREMENT'), code('INVALID_MEASUREMENT')]);
    const extreme = makeTrace([0, 1, 2], [-1e308, 1e308, -1e308]);
    close(measureResult(extreme, [{ ...pulse, value: 0 }]).measurements[0], 1);
  });

  it('preserves differential/current selectors, step selection and window errors', () => {
    const a = trace.analyses[0];
    const stepped = { ...trace, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index }, voltagesV: { ...a.voltagesV, ref: [0, 0, 0, 0, 0] }, currentsA: { v1: [0, -2, -2, 0, 0] } })) };
    const results = measureResult(stepped, [pulse, { ...pulse, step: 2 }, { ...pulse, step: 1, signal: 'v(missing)' }, { ...pulse, step: 1, signal: 'v(out,ref)' }, { ...pulse, step: 1, signal: 'i(v1)', value: -1, edge: 'falling' }, { ...pulse, step: 1, from: -1 }]).measurements;
    expect(results.slice(0, 3)).toMatchObject([code('AMBIGUOUS_ANALYSIS'), code('UNKNOWN_STEP'), code('UNKNOWN_SIGNAL')]);
    close(results[3], 2.5); close(results[4], 2.5);
    expect(results[5]).toMatchObject(code('OUT_OF_RANGE'));
  });

  it('aligns schema and runtime validation', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    const { value: _value, ...missingValue } = pulse;
    const { edge: _edge, ...missingEdge } = pulse;
    const cases = [pulse, { ...pulse, occurrence: 2 }, missingValue, missingEdge, ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null].map(occurrence => ({ ...pulse, occurrence })), { ...pulse, edge: 'either' }, { ...pulse, at: 1 }, { ...pulse, trigger: { signal: 'v(out)', threshold: 1 } }, { ...pulse, value: NaN }, { ...pulse, value: Infinity }];
    cases.forEach((measurement, i) => {
      const wire = JSON.parse(JSON.stringify({ request, measurements: [measurement] }));
      expect(validate(wire).valid, `schema ${i}`).toBe(i < 2);
      const result = measureResult(trace, [measurement]).measurements[0];
      if (i < 2) expect(result).not.toMatchObject(code('INVALID_MEASUREMENT'));
      else expect(result).toMatchObject(code('INVALID_MEASUREMENT'));
    });
  });

  it('rejects non-transient analyses', () => {
    const analyses = [
      { type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} },
      { type: 'dc' as const, analysisIndex: 1, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} },
      { type: 'ac' as const, analysisIndex: 2, frequencyHz: [1], voltagePhasors: {}, currentPhasors: {} },
    ];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...pulse, analysis: a.analysisIndex }))).measurements).toMatchObject(analyses.map(() => code('INVALID_MEASUREMENT')));
  });

  it('measures real voltage and signed source current in one simulation', async () => {
    const request = { apiVersion: '1' as const, input: { format: 'spice' as const, source: '* pulse width\nV1 out 0 PULSE(0 2 1m 1u 1u 2m 5m)\nR1 out 0 1k\n.tran 10u 12m\n.end' } };
    const simulate = vi.fn(simulateProtocolV1);
    const measurements = [pulse, { ...pulse, signal: 'i(v1)', value: -0.001, edge: 'falling' }, { ...pulse, from: 0.002, to: 0.009 }, { ...pulse, edge: 'either' }];
    const response = await executeTool('spice_measure', { request, measurements }, { simulate });
    expect(response.isError).not.toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
    const values = (response.structuredContent as { measurements: unknown[] }).measurements;
    values.slice(0, 3).forEach(value => close(value, 0.002001));
    expect(values[3]).toMatchObject(code('INVALID_MEASUREMENT'));
  });
});
