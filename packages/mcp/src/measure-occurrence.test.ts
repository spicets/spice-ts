import { describe, expect, it } from 'vitest';
import { measureResult } from './measure.js';
import { simulate } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const trace = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2, 3, 4, 5, 6], voltagesV: { out: [0, 2, 0, 2, 0, 2, 0] }, currentsA: {} }] };

describe('crossing occurrence', () => {
  it('counts initial falling departures and plateaus before later crossings', () => {
    const base = { kind: 'cross', signal: 'v(out)', analysis: 0, value: 1, edge: 'falling' };
    for (const [timeS, out, first, second] of [
      [[0, 1, 2, 3], [1, 0, 2, 0], 0, 2.5],
      [[0, 1, 2, 3, 4], [1, 1, 0, 2, 0], 1, 3.5],
    ] as const) {
      const input = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [...timeS], voltagesV: { out: [...out] }, currentsA: {} }] };
      const items = [base, { ...base, kind: 'when', occurrence: 2 }, { ...base, edge: 'either', occurrence: 1 }, { ...base, from: first + 0.1, occurrence: 1 }];
      expect(measureResult(input, items).measurements).toEqual([
        { value: first, unit: 's' }, { value: second, unit: 's' }, { value: first, unit: 's' }, { value: second, unit: 's' },
      ]);
    }
  });
  it('selects the second and third rising crossings', () => {
    const items = [2, 3].map(occurrence => ({ kind: occurrence === 2 ? 'cross' : 'when', signal: 'v(out)', analysis: 0, value: 1, edge: 'rising', occurrence }));
    expect(measureResult(trace, items).measurements).toEqual([{ value: 2.5, unit: 's' }, { value: 4.5, unit: 's' }]);
  });
  it('counts edges in the inclusive window and preserves the first crossing', () => {
    const base = { kind: 'cross', signal: 'v(out)', analysis: 0, value: 1 };
    const items = [base, { ...base, occurrence: 1 }, { ...base, edge: 'falling', occurrence: 2 },
      { ...base, edge: 'either', occurrence: 3 }, { ...base, edge: 'rising', from: 2.5, to: 4.5, occurrence: 2 },
      { ...base, edge: 'rising', from: 2.5, to: 4.5, occurrence: 3 }];
    expect(measureResult(trace, items).measurements).toEqual([
      { value: 0.5, unit: 's' }, { value: 0.5, unit: 's' }, { value: 3.5, unit: 's' },
      { value: 2.5, unit: 's' }, { value: 4.5, unit: 's' },
      { error: { code: 'NO_CROSSING', message: 'No crossing in the selected window' } },
    ]);
  });

  it('selects later current crossings and the third falling or either edge', () => {
    const current = { ...trace, analyses: [{ ...trace.analyses[0], currentsA: { v1: [0, 2, 0, 2, 0, 2, 0] } }] };
    const base = { kind: 'cross', signal: 'i(V1)', analysis: 0, value: 1 };
    expect(measureResult(current, [{ ...base, edge: 'falling', occurrence: 3 }, { ...base, edge: 'either', occurrence: 3 }]).measurements).toEqual([
      { value: 5.5, unit: 's' }, { value: 2.5, unit: 's' },
    ]);
  });

  it('counts shared threshold samples and plateaus once', () => {
    const plateau = { ...trace, analyses: [{ ...trace.analyses[0], voltagesV: { out: [0, 1, 1, 2, 1, 1, 0] } }] };
    const base = { kind: 'when', signal: 'v(out)', analysis: 0, value: 1, edge: 'either' };
    expect(measureResult(plateau, [base, { ...base, occurrence: 2 }, { ...base, occurrence: 3 }]).measurements).toMatchObject([
      { value: 1, unit: 's' }, { value: 4, unit: 's' }, { error: { code: 'NO_CROSSING' } },
    ]);
  });

  it('validates counts and conditional fields in both schema and evaluator', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    const base = { kind: 'when', signal: 'v(out)', analysis: 0, value: 1 };
    const cases = [{ ...base, occurrence: 2 }, { ...base, kind: 'cross', occurrence: 3 },
      ...[0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(occurrence => ({ ...base, occurrence })),
      { kind: 'min', signal: 'v(out)', analysis: 0, occurrence: 2 },
      { kind: 'at', signal: 'v(out)', analysis: 0, at: 1, occurrence: 2 },
      { kind: 'delay', analysis: 0, occurrence: 2, trigger: { signal: 'v(out)', threshold: 1 }, target: { signal: 'v(out)', threshold: 1 } }];
    cases.forEach((item, i) => {
      const valid = i < 2;
      expect(validate({ request, measurements: [item] }).valid, `schema ${i}`).toBe(valid);
      expect('error' in measureResult(trace, [item]).measurements[0], `runtime ${i}`).toBe(!valid);
    });
  });

  it('matches core WHEN RISE/FALL counts on the same bounded pulse/RC grid', async () => {
    // TD excludes earlier crossings; TO ends after the selected second crossings.
    const source = '* pulse RC\nV1 in 0 PULSE(0 1 0 1u 1u 3m 6m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 24m\n.meas tran rise2 when v(out)=0.5 rise=2 td=5m\n.meas tran fall2 when v(out)=0.5 fall=2 td=5m\n.end';
    const core = await simulate(source);
    const tran = core.transient!;
    const sameGrid = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [...tran.time], voltagesV: { out: [...tran.voltage('out')] }, currentsA: {} }] };
    const specs = ['rising', 'falling'].map(edge => ({ kind: 'when', signal: 'v(out)', analysis: 0, value: 0.5, edge, occurrence: 2, from: 0.005, to: 0.023 }));
    const actual = measureResult(sameGrid, specs).measurements;
    for (const [i, name] of ['rise2', 'fall2'].entries()) {
      const reference = core.measurements?.find(m => m.name === name);
      const result = actual[i];
      expect(reference).toMatchObject({ status: 'ok', value: expect.any(Number) });
      if ('error' in result || reference?.value === undefined) throw new Error('measurement failed');
      process.stdout.write(`${name}: mcp=${result.value} core=${reference.value} delta=${result.value - reference.value}\n`);
      expect(Math.abs(result.value - reference.value)).toBeLessThan(1e-9);
    }
    const currentSpec = { kind: 'cross', analysis: 0, signal: 'i(V1)', value: -0.0005, edge: 'falling', occurrence: 2 };
    const current = tran.current('V1');
    const currentCrossings: number[] = [];
    for (let i = 1; i < tran.time.length; i++) {
      if (current[i - 1] > currentSpec.value && current[i] <= currentSpec.value) {
        currentCrossings.push(tran.time[i - 1] + (tran.time[i] - tran.time[i - 1]) * (currentSpec.value - current[i - 1]) / (current[i] - current[i - 1]));
      }
    }
    expect(currentCrossings.length).toBeGreaterThanOrEqual(2);
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source } }, measurements: [...specs, currentSpec] });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ measurements: [actual[0], actual[1], { value: currentCrossings[1], unit: 's' }] });
  });
});
