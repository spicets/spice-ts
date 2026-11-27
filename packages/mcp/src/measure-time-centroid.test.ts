import { describe, expect, it } from 'vitest';
import { measureResult, measurementListSchema } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const trace = (timeS: number[], values: number[]) => ({ status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS, voltagesV: { out: values }, currentsA: {} }] });
const item = { kind: 'timeCentroid', analysis: 0, signal: 'v(out)' };

describe('timeCentroid', () => {
  it('finds the center of a symmetric triangle', () => {
    expect(measureResult(trace([0, 1, 2], [0, 1, 0]), [item]).measurements).toEqual([{ value: 1, unit: 's' }]);
  });
  it('integrates ramps, clipped windows, crossings and nonuniform translated grids', () => {
    const cases: [number[], number[], Record<string, number>, number][] = [
      [[0, 3], [0, 3], {}, 2],
      [[10, 11, 13, 14], [0, 1, 3, 4], {}, 10 + 8 / 3],
      [[0, 4], [-1, 3], {}, 41 / 15],
      [[0, 4], [0, 4], { from: 1, to: 3 }, 13 / 6],
      [[4, 8], [-2, -2], {}, 6],
    ];
    for (const [times, values, window, expected] of cases) {
      const result = measureResult(trace(times, values), [{ ...item, ...window }]).measurements[0];
      expect(result).toHaveProperty('unit', 's');
      if ('value' in result) expect(result.value).toBeCloseTo(expected, 12);
    }
  });

  it('is invariant under signed extreme amplitude scales and large time offsets', () => {
    for (const scale of [1e-300, -1e-300, 1e300, -1e300]) {
      const result = measureResult(trace([1e12, 1e12 + 3], [0, scale]), [item]).measurements[0];
      expect(result).toEqual({ value: 1e12 + 2, unit: 's' });
    }
  });

  it('handles a finite centroid across an overflowing time span', () => {
    expect(measureResult(trace([-1e308, 1e308], [1, 1]), [item]).measurements[0]).toEqual({ value: 0, unit: 's' });
    const result = measureResult(trace([-1e308, 1e308], [0, 1]), [{ ...item, from: 0 }]).measurements[0];
    expect(result).toHaveProperty('unit', 's');
    if ('value' in result) expect(result.value / 1e308).toBeCloseTo(5 / 9, 14);
  });

  it('uses selectors and preserves structured errors', () => {
    const base = trace([0, 1, 2], [0, 1, 0]); const a = base.analyses[0];
    const stepped = { ...base, analyses: [0, 1].map(index => ({ ...a, analysisIndex: 2, step: { index, parameter: 'r', value: index }, voltagesV: { out: [2, 3, 2], ref: [2, 2, 2] }, currentsA: { V1: [0, -1, 0] } })) };
    const specs = [{ ...item, analysis: 2, step: 1, signal: 'V(OUT,REF)' }, { ...item, analysis: 2, step: 0, signal: 'I(v1)' }, { ...item, analysis: 2 }, { ...item, analysis: 2, step: 4 }, { ...item, analysis: 9 }, { ...item, analysis: 2, step: 0, signal: 'v(nope)' }];
    expect(measureResult(stepped, specs).measurements).toMatchObject([{ value: 1, unit: 's' }, { value: 1, unit: 's' }, ...['AMBIGUOUS_ANALYSIS', 'UNKNOWN_STEP', 'UNKNOWN_ANALYSIS', 'UNKNOWN_SIGNAL'].map(code => ({ error: { code } }))]);
    expect(measureResult(trace([0, 1], [0, 0]), [item, { ...item, from: 0, to: 0 }, { ...item, from: -1 }]).measurements).toMatchObject(['INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'OUT_OF_RANGE'].map(code => ({ error: { code } })));
  });

  it('rejects incompatible fields and non-transient analyses in schema and execution', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    expect(measurementListSchema.items.properties.kind.description).toContain('|signal|');
    expect(validate({ request, measurements: [item] }).valid).toBe(true);
    for (const [key, value] of Object.entries({ at: 1, value: 1, edge: 'rising', occurrence: 1, trigger: {}, target: {}, referenceSignal: 'v(out)', lower: 0, upper: 1 })) {
      const invalid = { ...item, [key]: value };
      expect(validate({ request, measurements: [invalid] }).valid, key).toBe(false);
      expect(measureResult(trace([0, 1], [0, 1]), [invalid]).measurements[0], key).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    const analyses = [{ type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} }, { type: 'dc' as const, analysisIndex: 1, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} }, { type: 'ac' as const, analysisIndex: 2, frequencyHz: [1], voltagePhasors: {}, currentPhasors: {} }];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...item, analysis: a.analysisIndex }))).measurements).toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });

  it('measures a bounded native JSON pulse with an RC load through spice_measure', async () => {
    const ports = (p: string, n: string) => [{ name: 'p', net: p }, { name: 'n', net: n }];
    const components = [
      { type: 'V', id: 'V1', name: 'V1', ports: ports('in', '0'), params: { waveform: 'pulse', v1: 0, v2: 1, delay: 0.0002, rise: 0.0002, fall: 0.0002, width: 0.0002, period: 0.002 } },
      { type: 'R', id: 'R1', name: 'R1', ports: ports('in', 'out'), params: { resistance: 1000 } },
      { type: 'C', id: 'C1', name: 'C1', ports: ports('out', '0'), params: { capacitance: 1e-6 } },
    ];
    const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in', 'out'] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }], models: [], subcircuits: [] };
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice-ts', document } }, measurements: [{ ...item, signal: 'v(in)', from: 0.0001, to: 0.0009 }] });
    expect(response.isError).not.toBe(true);
    const result = (response.structuredContent as { measurements: { value: number; unit: string }[] }).measurements[0];
    expect(result.unit).toBe('s');
    expect(result.value).toBeCloseTo(0.0005, 8);
  });

});
