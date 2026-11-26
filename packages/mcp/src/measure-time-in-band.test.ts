import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { measureResult } from './measure.js';
import { executeTool, MCP_TOOLS } from './server.js';

const trace = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 3], voltagesV: { out: [0, 2, 0], ref: [0, 0, 0] }, currentsA: { v1: [0, 2, 0] } }] };
const band = { kind: 'timeInBand', signal: 'v(out)', analysis: 0, lower: 0.5, upper: 1.5 };

describe('transient time in band', () => {
  it('integrates nonuniform triangular traces and clipped windows', () => {
    const specs = [band, { ...band, from: 0.5, to: 2 }, { ...band, from: 1, to: 1 }];
    expect(measureResult(trace, specs).measurements).toEqual([1.5, 0.75, 0].map(value => ({ value, unit: 's' })));
  });

  it('includes flat boundaries but not isolated zero-width crossings', () => {
    const flat = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [0, 1, 2, 3, 4], voltagesV: { out: [0, 1, 1, 2, 2] }, currentsA: {} }] };
    const specs = [{ ...band, lower: 1, upper: 1 }, { ...band, lower: 2, upper: 2 }, { ...band, lower: 1, upper: 2 }, { ...band, lower: 3, upper: 4 }];
    expect(measureResult(flat, specs).measurements).toEqual([1, 1, 3, 0].map(value => ({ value, unit: 's' })));
  });

  it('handles large finite values without overflowing interpolation', () => {
    const extreme = { ...trace, analyses: [{ ...trace.analyses[0], timeS: [0, 1], voltagesV: { out: [-1e308, 1e308] }, currentsA: {} }] };
    expect(measureResult(extreme, [{ ...band, lower: -5e307, upper: 5e307 }, { ...band, lower: -5e307, upper: 5e307, from: 0.25, to: 0.75 }]).measurements).toEqual([0.5, 0.5].map(value => ({ value, unit: 's' })));
  });

  it('supports differential voltage, current, analysis and step selection', () => {
    const a = trace.analyses[0];
    const stepped = { ...trace, analyses: [0, 1].map(index => ({ ...a, analysisIndex: 2, step: { index, parameter: 'r', value: index } })) };
    const specs = ['v(out,ref)', 'i(v1)'].map(signal => ({ ...band, analysis: 2, step: 1, signal }));
    expect(measureResult(stepped, specs).measurements).toEqual([1.5, 1.5].map(value => ({ value, unit: 's' })));
    expect(measureResult(stepped, [{ ...band, analysis: 2 }, { ...band, analysis: 2, step: 4 }, { ...band, analysis: 9 }, { ...band, analysis: 2, step: 0, signal: 'v(missing)' }]).measurements).toMatchObject(['AMBIGUOUS_ANALYSIS', 'UNKNOWN_STEP', 'UNKNOWN_ANALYSIS', 'UNKNOWN_SIGNAL'].map(code => ({ error: { code } })));
  });

  it('validates fields and schema, and rejects incompatible analyses and windows', () => {
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_measure')!.inputSchema);
    const request = { apiVersion: '1', input: { format: 'spice', source: '* test\n.end' } };
    const { lower: _lower, ...missingLower } = band;
    const { upper: _upper, ...missingUpper } = band;
    const invalid = [missingLower, missingUpper, ...[NaN, Infinity, -Infinity].flatMap(n => [{ ...band, lower: n }, { ...band, upper: n }]), ...Object.entries({ at: 1, value: 1, edge: 'rising', occurrence: 1, trigger: {}, target: {}, referenceSignal: 'v(out)' }).map(([key, value]) => ({ ...band, [key]: value }))];
    expect(validate({ request, measurements: [band] }).valid).toBe(true);
    for (const item of invalid) {
      expect(validate(JSON.parse(JSON.stringify({ request, measurements: [item] }))).valid).toBe(false);
      expect(measureResult(trace, [item]).measurements[0]).toMatchObject({ error: { code: 'INVALID_MEASUREMENT' } });
    }
    expect(measureResult(trace, [{ ...band, lower: 2 }, { ...band, from: 2, to: 1 }, { ...band, from: -1 }, { ...band, to: 4 }, { kind: 'duty', signal: 'v(out)', analysis: 0, value: 1, lower: 0 }]).measurements).toMatchObject(['INVALID_MEASUREMENT', 'INVALID_MEASUREMENT', 'OUT_OF_RANGE', 'OUT_OF_RANGE', 'INVALID_MEASUREMENT'].map(code => ({ error: { code } })));
    const analyses = [{ type: 'op' as const, analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} }, { type: 'dc' as const, analysisIndex: 1, axis: { name: 'V1', unit: 'V' as const, values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} }, { type: 'ac' as const, analysisIndex: 2, frequencyHz: [1], voltagePhasors: { out: [{ real: 1, imaginary: 0, magnitude: 1, phaseDegrees: 0 }] }, currentPhasors: {} }];
    expect(measureResult({ status: 'complete', analyses }, analyses.map(a => ({ ...band, analysis: a.analysisIndex }))).measurements).toMatchObject(analyses.map(() => ({ error: { code: 'INVALID_MEASUREMENT' } })));
  });

  it('measures constant voltage through public SPICE text and native requests', async () => {
    const components = [
      { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { waveform: 'dc', dc: 2 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
    ];
    const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['out'] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }], models: [], subcircuits: [] };
    for (const input of [{ format: 'spice', source: '* constant\nV1 out 0 2\nR1 out 0 1k\n.tran 10u 1m\n.end' }, { format: 'spice-ts', document }]) {
      const response = await executeTool('spice_measure', { request: { apiVersion: '1', input }, measurements: [
        { ...band, lower: 1, upper: 2 },
        { ...band, signal: 'v(out,0)', lower: 2, upper: 2, from: 0.0002, to: 0.0008, step: 0 },
        { ...band, signal: 'i(v1)', lower: -0.003, upper: -0.001 },
      ] });
      expect(response.structuredContent).toEqual({ measurements: [{ value: 0.001, unit: 's' }, { value: 0.0006000000000000001, unit: 's' }, { value: 0.001, unit: 's' }] });
    }
  });
});
