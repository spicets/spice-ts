import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationResultV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const source = '* Original divider\nVin in 0 0\nR1 in out 1k\nR2 out 0 1k\n.dc Vin 0 5 0.5\n.step R2 list 1k 3k\n.end\n';
const request = { apiVersion: '1' as const, input: { format: 'spice' as const, source } };

describe('DC metric selectors', () => {
  it('selects stepped divider traces and preserves ambiguity without a selector', async () => {
    const raw = await simulateProtocolV1(request);
    expect(raw.analyses).toHaveLength(2);
    for (const [step, gain] of [[0, 0.5], [1, 0.75]] as const) {
      const trace = raw.analyses.find(a => a.type === 'dc' && a.step?.index === step);
      if (!trace || trace.type !== 'dc') throw new Error('missing DC trace');
      for (const [i, x] of trace.axis.values.entries()) {
        expect(Math.abs(trace.voltagesV.out[i] - gain * x)).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(gain * x));
      }
      const response = await executeTool('spice_dc_metrics', { request, sweptSource: 'vIN', output: 'v(out)', step });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ gainMax: { value: expect.closeTo(gain, 9) }, voh: { value: 0 }, vol: { value: expect.closeTo(5 * gain, 9) } });
    }
    expect(await executeTool('spice_dc_metrics', { request, sweptSource: 'Vin', output: 'v(out)' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('selects between two real DC analyses of the same source', async () => {
    const two = { ...request, input: { ...request.input, source: source.replace('.step R2 list 1k 3k', '.dc Vin 0 4 1') } };
    const raw = await simulateProtocolV1(two);
    expect(raw.analyses.filter(a => a.type === 'dc')).toHaveLength(2);
    for (const [analysis, endpoint] of [[0, 2.5], [1, 2]] as const) {
      const response = await executeTool('spice_dc_metrics', { request: two, sweptSource: 'Vin', output: 'v(out)', analysis });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ vol: { value: expect.closeTo(endpoint, 9) } });
    }
    expect(await executeTool('spice_dc_metrics', { request: two, sweptSource: 'Vin', output: 'v(out)' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('selects analysisIndex and step identity, rejecting missing and duplicate identities', async () => {
    const trace = (analysisIndex: number, index: number, gain: number) => ({
      type: 'dc' as const, analysisIndex, step: { index, parameter: 'R2', value: index + 1 },
      axis: { name: 'Vin', unit: 'V' as const, values: [0, 1, 2] },
      voltagesV: { out: [0, gain, 2 * gain], in: [0, 1, 2] }, currentsA: {},
    });
    const result: SimulationResultV1 = { status: 'complete', analyses: [trace(8, 4, 0.25), { type: 'op', analysisIndex: 3, voltagesV: {}, currentsA: {} }, trace(2, 4, 0.5), trace(2, 7, 0.75)] };
    const before = structuredClone(result);
    const run = (args: object, data = result) => executeTool('spice_dc_metrics', { request, sweptSource: 'vin', output: 'v(out,0)', ...args }, { simulate: async () => data });
    expect((await run({ analysis: 8, step: 4 })).structuredContent).toMatchObject({ gainMax: { value: 0.25 } });
    expect((await run({ analysis: 2, step: 7 })).structuredContent).toMatchObject({ gainMax: { value: 0.75 } });
    for (const args of [{}, { analysis: 2 }, { step: 4 }, { analysis: 0 }, { analysis: 3 }, { analysis: 2, step: 99 }]) {
      expect(await run(args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    expect(await run({ analysis: 8, step: 4 }, { ...result, analyses: [...result.analyses, result.analyses[0]] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    const { step: _step, ...single } = trace(8, 4, 0.25);
    const unstepped: SimulationResultV1 = { status: 'complete', analyses: [single] };
    expect((await run({ analysis: 8, step: 0 }, unstepped)).structuredContent).toEqual((await run({}, unstepped)).structuredContent);
    expect(await run({ step: 1 }, unstepped)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    expect(result).toEqual(before);
  });

  it('validates selector schema and runtime', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
    const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    expect(validate({ request, sweptSource: 'Vin', output: 'v(out)', analysis: 0, step: 0 }).valid).toBe(true);
    for (const selector of ['analysis', 'step']) {
      expect((tool.inputSchema.properties as Record<string, unknown>)[selector]).toMatchObject({ type: 'integer', minimum: 0 });
      for (const value of [-1, 0.5, NaN, Infinity, -Infinity, '1']) {
        const args = { request, sweptSource: 'Vin', output: 'v(out)', [selector]: value };
        // Non-finite numbers are not representable in JSON.
        if (typeof value !== 'number' || Number.isFinite(value)) expect(validate(args).valid).toBe(false);
        expect(await executeTool('spice_dc_metrics', args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      }
    }
  });

  it('selects native JSON stepped DC traces without mutating the request', async () => {
    const document: SpiceTsCircuitDocumentV1 = {
      format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
      circuit: { nets: ['in', 'out'], components: [
        { type: 'V', id: 'Vin', name: 'Vin', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 0 } },
        { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
        { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
      ] }, analyses: [{ type: 'dc', source: 'Vin', start: 0, stop: 5, step: 0.5 }],
    };
    const native = { apiVersion: '1' as const, input: { format: 'spice-ts' as const, document } };
    const before = structuredClone(native);
    // Native componentSweep rejects DC. Inject genuine stepped protocol vectors.
    const raw = await simulateProtocolV1(request);
    expect(raw.analyses.map(a => a.step?.index)).toEqual([0, 1]);
    for (const [step, gain] of [[0, 0.5], [1, 0.75]] as const) {
      const response = await executeTool('spice_dc_metrics', { request: native, sweptSource: 'Vin', output: 'v(out)', analysis: 0, step }, { simulate: async () => raw });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ gainMax: { value: expect.closeTo(gain, 9) }, vol: { value: expect.closeTo(5 * gain, 9) } });
    }
    const unstepped = await executeTool('spice_dc_metrics', { request: native, sweptSource: 'Vin', output: 'v(out)', analysis: 0, step: 0 });
    expect(unstepped.structuredContent).toMatchObject({ gainMax: { value: expect.closeTo(0.5, 9) }, vol: { value: expect.closeTo(2.5, 9) } });
    expect(native).toEqual(before);
  });
});
