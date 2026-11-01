import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { simulateProtocolV1 } from '@spice-ts/core';
import { executeTool, MCP_TOOLS } from './server.js';
import { tranMetrics } from './tran-metrics.js';

const trace = (index: number, duration: number) => ({
  type: 'tran' as const, analysisIndex: 2, step: { index, parameter: 'R1', value: duration },
  timeS: [0, duration, 2 * duration, 4 * duration],
  voltagesV: { out: [0, 1, 1, 1] }, currentsA: { V1: [0, 2, 2, 2] },
});
const result: SimulationResultV1 = { status: 'complete', analyses: [trace(7, 1), trace(3, 2)] };
const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end' } };
const validator = new AjvJsonSchemaValidator();
const tool = MCP_TOOLS.find(t => t.name === 'spice_tran_metrics')!;

describe('transient stepped trace selection', () => {
  it('selects step.index, matching standalone voltage and current metrics without mutating the result', () => {
    const before = structuredClone(result);
    for (const [index, expected] of [[7, 0.8], [3, 1.6]] as const) {
      for (const signal of ['v(out)', 'i(V1)']) {
        const metrics = tranMetrics(result, { signal, analysis: 2, step: index });
        const standalone = tranMetrics({ status: 'complete', analyses: [result.analyses.find(a => a.step?.index === index)!] }, { signal });
        expect(metrics).toEqual(standalone);
        expect(metrics).toMatchObject({ riseTimeS: expect.closeTo(expected), unit: signal[0] === 'v' ? 'V' : 'A', slewUnit: signal[0] === 'v' ? 'V/s' : 'A/s' });
      }
    }
    expect(result).toEqual(before);
  });

  it('rejects ambiguity and unknown steps while preserving analysis selection', async () => {
    const simulate = async () => result;
    const run = (args: object) => executeTool('spice_tran_metrics', { request, signal: 'v(out)', ...args }, { simulate });
    for (const args of [{}, { analysis: 2 }]) {
      expect(await run(args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_TRANSIENT' } } });
    }
    const missing = await run({ analysis: 2, step: 0 });
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNKNOWN_STEP' } } });
    expect(validator.getValidator(tool.outputSchema!)(missing.structuredContent).valid).toBe(true);
    for (const step of [-1, 0.5, Infinity, -Infinity, NaN, '1']) {
      expect(await run({ step })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const other: SimulationResultV1 = { status: 'complete', analyses: [...result.analyses, { type: 'op', analysisIndex: 1, voltagesV: {}, currentsA: {} }] };
    expect(tranMetrics(other, { signal: 'v(out)', analysis: 1, step: 7 })).toMatchObject({ error: { code: 'NOT_TRANSIENT' } });
    expect(tranMetrics(other, { signal: 'v(out)', analysis: 2, step: 7 })).toEqual(tranMetrics(result, { signal: 'v(out)', step: 7 }));
    const twoAnalyses: SimulationResultV1 = { status: 'complete', analyses: [trace(7, 1), { ...trace(7, 2), analysisIndex: 4 }] };
    expect(tranMetrics(twoAnalyses, { signal: 'v(out)', step: 7 })).toMatchObject({ error: { code: 'NOT_TRANSIENT' } });
  });

  it('accepts unstepped traces with omitted step or zero', () => {
    const { step: _step, ...single } = trace(7, 1);
    const unstepped: SimulationResultV1 = { status: 'complete', analyses: [single] };
    expect(tranMetrics(unstepped, { signal: 'v(out)', step: 0 })).toEqual(tranMetrics(unstepped, { signal: 'v(out)' }));
    expect(tranMetrics(unstepped, { signal: 'v(out)', step: 1 })).toMatchObject({ error: { code: 'UNKNOWN_STEP' } });
  });

  it('exposes the selector in the registered schema and runs a native stepped transient', async () => {
    const document: SpiceTsCircuitDocumentV1 = {
      format: 'spice-ts' as const, schemaVersion: '1.0' as const, models: [], subcircuits: [],
      circuit: { nets: ['in', 'out'], components: [
        { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
        { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
        { type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { capacitance: 1e-6 } },
      ] }, analyses: [{ type: 'tran' as const, timestep: 1e-5, stopTime: 0.03, uic: true as const }],
      initialConditions: { out: 0 }, componentSweep: { component: 'R1', values: [1000, 2000] },
    };
    const nativeRequest = { apiVersion: '1' as const, input: { format: 'spice-ts' as const, document }, outputs: ['v(out)', 'i(V1)'] };
    const original = structuredClone(nativeRequest);
    const simulation = await simulateProtocolV1(nativeRequest);
    expect(simulation.analyses.map(a => a.step?.index)).toEqual([0, 1]);
    for (const step of [0, 1]) {
      const args = { request: nativeRequest, signal: 'v(out)', analysis: 0, step };
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await executeTool('spice_tran_metrics', args);
      expect(response.isError).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      expect(response.structuredContent).toEqual(tranMetrics({ status: 'complete', analyses: [simulation.analyses[step]] }, { signal: 'v(out)' }));
    }
    expect(nativeRequest).toEqual(original);
  });
});
