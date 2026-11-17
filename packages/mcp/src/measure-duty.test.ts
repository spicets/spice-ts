import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { measureResult } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';

const transient = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 3], voltagesV: { out: [0, 2, 2], ref: [0, 0, 0] }, currentsA: { v1: [0, 2, 2] } }] };
const selector = { kind: 'duty', signal: 'v(out)', analysis: 0, value: 1 };

describe('transient duty measurements', () => {
  it('weights nonuniform time and interpolates off-sample window boundaries and crossings', () => {
    const result = measureResult(transient, [selector, { ...selector, from: 0.25, to: 2.5 }]).measurements;
    expect(result[0]).toMatchObject({ unit: '1' });
    expect('value' in result[0] && Math.abs(result[0].value - 5 / 6)).toBeLessThan(1e-12);
    expect('value' in result[1] && Math.abs(result[1].value - 8 / 9)).toBeLessThan(1e-12);
  });

  it('handles extreme finite samples and clipped windows without overflow', () => {
    const trace = { ...transient, analyses: [{ ...transient.analyses[0], timeS: [0, 1], voltagesV: { out: [1e308, -1e308] } }] };
    const specs = [
      { ...selector, value: 0 },
      { ...selector, value: 0, from: 0.25, to: 0.75 },
      { ...selector, value: 5e307 },
      { ...selector, value: -5e307, from: 0.25, to: 0.75 },
    ];
    expect(measureResult(trace, specs).measurements).toEqual([0.5, 0.5, 0.25, 1].map(value => ({ value, unit: '1' })));
    const rising = { ...trace, analyses: [{ ...trace.analyses[0], voltagesV: { out: [-1e308, 1e308] } }] };
    expect(measureResult(rising, specs).measurements).toEqual([0.5, 0.5, 0.25, 1].map(value => ({ value, unit: '1' })));
  });

  it('handles flat below, above, equal and symmetric triangle', () => {
    const trace = { ...transient, analyses: [{ ...transient.analyses[0], timeS: [0, 1, 2], voltagesV: { below: [0, 0, 0], above: [2, 2, 2], equal: [1, 1, 1], triangle: [0, 2, 0] } }] };
    const results = measureResult(trace, ['below', 'above', 'equal', 'triangle'].map(signal => ({ ...selector, signal: `v(${signal})` }))).measurements;
    expect(results).toEqual([0, 1, 0, 0.5].map(value => ({ value, unit: '1' })));
  });

  it('supports voltage, differential voltage, current and selected steps', () => {
    const a = transient.analyses[0];
    const stepped = { ...transient, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index }, voltagesV: { ...a.voltagesV, out: index ? [0, 2, 2] : [0, 0, 0] } })) };
    const measurements = [selector, ...['v(out)', 'v(out,ref)', 'i(v1)'].map(signal => ({ ...selector, signal, step: 1 })), { ...selector, step: 0 }, { ...selector, step: 2 }];
    const result = measureResult(stepped, measurements).measurements;
    expect(result[0]).toMatchObject({ error: { code: 'AMBIGUOUS_ANALYSIS' } });
    for (const entry of result.slice(1, 4)) expect(entry).toEqual({ value: 5 / 6, unit: '1' });
    expect(result[4]).toEqual({ value: 0, unit: '1' });
    expect(result[5]).toMatchObject({ error: { code: 'UNKNOWN_STEP' } });
  });

  it('aligns schema and runtime for required threshold and irrelevant fields', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    const { value: _value, ...missing } = selector;
    const crossing = { signal: 'v(out)', threshold: 1 };
    const cases = [selector, missing, ...[NaN, Infinity, -Infinity].map(value => ({ ...selector, value })), ...Object.entries({ at: 1, edge: 'rising', occurrence: 1, trigger: crossing, target: crossing }).map(([key, value]) => ({ ...selector, [key]: value }))];
    cases.forEach((measurement, i) => {
      // Non-finite JavaScript numbers become null on the JSON transport.
      const wire = JSON.parse(JSON.stringify({ request, measurements: [measurement] }));
      expect(validate(wire).valid, `schema ${i}`).toBe(i === 0);
      const result = measureResult(transient, [measurement]).measurements[0];
      if (i === 0) expect(result).toMatchObject({ unit: '1' });
      else expect(result).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    });
  });

  it('rejects zero, reversed and out-of-axis windows with structured errors', () => {
    const items = [{ from: 1, to: 1 }, { from: 2, to: 1 }, { from: -1 }, { to: 4 }].map(window => ({ ...selector, ...window }));
    const results = measureResult(transient, items).measurements;
    expect(results).toMatchObject([{ error: { code: 'OUT_OF_RANGE' } }, { error: { code: 'INVALID_MEASUREMENT' } }, { error: { code: 'OUT_OF_RANGE' } }, { error: { code: 'OUT_OF_RANGE' } }]);
  });

  it('rejects non-transient analyses', () => {
    const analyses = [
      { type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} },
      { type: 'dc' as const, analysisIndex: 1, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} },
      { type: 'ac' as const, analysisIndex: 2, frequencyHz: [1], voltagePhasors: { out: [{ real: 1, imaginary: 0, magnitude: 1, phaseDegrees: 0 }] }, currentPhasors: {} },
    ];
    const results = measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...selector, analysis: a.analysisIndex })));
    expect(results.measurements).toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });

  it('runs through executeTool with an actual transient simulation', async () => {
    const response = await executeTool('spice_measure', {
      request: { apiVersion: '1', input: { format: 'spice', source: '* constant source\nV1 out 0 2\nR1 out 0 1k\n.tran 10u 1m\n.end' } },
      measurements: [selector, { ...selector, value: 2 }],
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({ measurements: [{ value: 1, unit: '1' }, { value: 0, unit: '1' }] });
  });
});
