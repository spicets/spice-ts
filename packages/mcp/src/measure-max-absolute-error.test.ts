import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { simulateProtocolV1 } from '@spice-ts/core';
import { executeTool, MCP_TOOLS } from './server.js';
import { measureResult, measurementListSchema } from './measure.js';

const transient = {
  status: 'complete' as const,
  analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 3], voltagesV: { out: [0, 4, -2], ref: [0, 0, 0] }, currentsA: { a: [0, 4, -2], b: [0, 0, 0] } }],
};
const spec = { kind: 'maxAbsoluteError', analysis: 0, signal: 'v(out)', referenceSignal: 'v(ref)' };

describe('transient maximum absolute tracking error', () => {
  it('accepts the new kind in the runtime handler', () => {
    expect(measureResult(transient, [spec]).measurements[0]).toEqual({ value: 4, unit: 'V' });
  });
  it('advertises the kind and measures nonuniform samples and interpolated boundaries', () => {
    expect(measurementListSchema.items.properties.kind.enum).toContain('maxAbsoluteError');
    expect(measureResult(transient, [spec, { ...spec, from: 1.5, to: 2.5 }]).measurements)
      .toEqual([{ value: 4, unit: 'V' }, { value: 2.5, unit: 'V' }]);
  });

  it('supports identical, signed differential, case-insensitive and current selectors', () => {
    const results = measureResult(transient, [
      { ...spec, referenceSignal: 'v(OUT)' },
      { ...spec, signal: 'V(REF,OUT)', referenceSignal: 'V(0)' },
      { ...spec, signal: 'I(A)', referenceSignal: 'i(B)' },
      { ...spec, from: 2.5, to: 3 },
    ]).measurements;
    expect(results).toEqual([{ value: 0, unit: 'V' }, { value: 4, unit: 'V' }, { value: 4, unit: 'A' }, { value: 2, unit: 'V' }]);
  });

  it('selects the requested analysis and step and reports invalid requests independently', () => {
    const a = transient.analyses[0];
    const stepped = { ...transient, analyses: [0, 1].map(index => ({ ...a, step: { index, parameter: 'r', value: index } })) };
    expect(measureResult(stepped, [spec, { ...spec, step: 1 }, { ...spec, step: 2 }, { ...spec, analysis: 3, step: 0 }]).measurements)
      .toMatchObject([{ error: { code: 'AMBIGUOUS_ANALYSIS' } }, { value: 4, unit: 'V' }, { error: { code: 'UNKNOWN_STEP' } }, { error: { code: 'UNKNOWN_ANALYSIS' } }]);
    const cases = [
      { ...spec, referenceSignal: undefined }, { ...spec, referenceSignal: '' },
      { ...spec, signal: 'v(missing)' }, { ...spec, referenceSignal: 'v(missing)' }, { ...spec, referenceSignal: 'i(a)' },
      { ...spec, from: NaN }, { ...spec, from: -1 }, { ...spec, to: 4 }, { ...spec, from: 2, to: 1 }, { ...spec, from: 1, to: 1 },
      { ...spec, at: 1 }, { ...spec, value: 1 }, { ...spec, edge: 'rising' },
    ];
    const codes = ['INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'UNKNOWN_SIGNAL', 'UNKNOWN_SIGNAL', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'OUT_OF_RANGE', 'OUT_OF_RANGE', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'INVALID_MEASUREMENT'];
    expect(measureResult(transient, cases).measurements).toMatchObject(codes.map(code => ({ error: { code } })));
  });

  it('rejects non-transient analyses and nonfinite computed differences', () => {
    const dc = { type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} };
    const ac = { type: 'ac' as const, analysisIndex: 1, frequencyHz: [1, 2], voltagePhasors: {}, currentPhasors: {} };
    expect(measureResult({ status: 'complete', analyses: [dc, ac] }, [spec, { ...spec, analysis: 1 }]).measurements)
      .toMatchObject([{ error: { code: 'INVALID_MEASUREMENT' } }, { error: { code: 'INVALID_MEASUREMENT' } }]);
    const a = transient.analyses[0];
    const overflow = { ...a, voltagesV: { out: [0, 1e308, 0], ref: [0, -1e308, 0] } };
    expect(measureResult({ ...transient, analyses: [overflow] }, [spec]).measurements[0]).toMatchObject({ error: { code: 'NON_FINITE_RESULT' } });
  });

  it('validates the advertised schema and compares a real RC run to its returned samples', async () => {
    const request = { apiVersion: '1' as const, input: { format: 'spice' as const, source: '* RC tracking\nV1 in 0 PULSE(0 1 0 1u 1u 1m 2m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 3m\n.end' } };
    const measurements = [{ ...spec, referenceSignal: 'v(in)' }, { ...spec, signal: 'v(in)', referenceSignal: 'v(in)' }];
    const tool = MCP_TOOLS.find(t => t.name === 'spice_measure')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    expect(input({ request, measurements }).valid).toBe(true);
    for (const invalid of [{ ...spec, referenceSignal: undefined }, { ...spec, at: 1 }, { ...spec, occurrence: 1 }]) {
      expect(input({ request, measurements: [invalid] }).valid).toBe(false);
      expect(measureResult(transient, [invalid]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    const simulate = vi.fn(simulateProtocolV1);
    const response = await executeTool('spice_measure', { request, measurements }, { simulate });
    expect(response.isError).not.toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(output(response.structuredContent).valid).toBe(true);
    const simulated = await simulate.mock.results[0].value;
    const analysis = simulated.analyses[0];
    if (analysis.type !== 'tran') throw new Error('Expected transient');
    const actual = (response.structuredContent as { measurements: { value: number; unit: string }[] }).measurements;
    const expected = Math.max(...analysis.voltagesV.out.map((v: number, i: number) => Math.abs(v - analysis.voltagesV.in[i])));
    expect(expected).toBeGreaterThan(0);
    expect(actual[0].unit).toBe('V');
    expect(Number.isFinite(actual[0].value) && actual[0].value >= 0).toBe(true);
    expect(actual[0].value).toBeCloseTo(expected, 12);
    expect(actual[1]).toEqual({ value: 0, unit: 'V' });
  });
});
