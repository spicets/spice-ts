import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';
import { optimizeProperties, runOptimize } from './optimize.js';

const ports = (a: string, b: string) => [{ name: 'p', net: a }, { name: 'n', net: b }];
const native = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', circuit: { components: [
  { type: 'V', id: 'V1', name: 'V1', ports: ports('in', '0'), params: { waveform: 'dc', dc: 10, acMagnitude: 2 } },
  { type: 'R', id: 'R1', name: 'R1', ports: ports('in', 'out'), params: { resistance: 1000 } },
  { type: 'R', id: 'R2', name: 'R2', ports: ports('out', '0'), params: { resistance: 1000 } },
], nets: ['in', 'out'] }, analyses: [{ type: 'op' }], models: [], subcircuits: [] } } } as unknown as SimulationRequestV1;
const args = { parameters: [{ kind: 'source', name: 'v1', min: 0, max: 10 }], objective: { kind: 'at', signal: 'v(out)', analysis: 0, at: 0 }, target: 2.5, tolerance: 0.0001, maxEvaluations: 30 };
type Result = { bestParams: Record<string, number>; achievedValue: number; evaluations: number; history: { value: number }[] };

describe('source optimization', () => {
  it('rejects malformed native components before simulation through the public tool', async () => {
    const request = structuredClone(native);
    if (request.input.format !== 'spice-ts') throw new Error('Expected native input');
    request.input.document.circuit.components.unshift(null as unknown as typeof request.input.document.circuit.components[number]);
    expect(await executeTool('spice_optimize', { ...args, request })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } },
    });
  });

  it('accepts source in the schema and optimizes a real native divider without mutation', async () => {
    expect(optimizeProperties.parameters.items.properties.kind.enum).toContain('source');
    const request = structuredClone(native);
    const before = structuredClone(request);
    const response = await executeTool('spice_optimize', { ...args, request });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const result = response.structuredContent as unknown as Result;
    expect(Math.abs(result.achievedValue - 2.5)).toBeLessThanOrEqual(0.0001);
    expect(result.bestParams.v1).toBeGreaterThanOrEqual(0);
    expect(result.bestParams.v1).toBeLessThanOrEqual(10);
    expect(result.evaluations).toBeLessThanOrEqual(30);
    expect(request).toEqual(before);
    if (request.input.format !== 'spice-ts') throw new Error('Expected native input');
    request.input.document.circuit.components[0].params.dc = result.bestParams.v1;
    const measured = await executeTool('spice_measure', { request, measurements: [args.objective] });
    expect(measured.isError, JSON.stringify(measured.structuredContent)).not.toBe(true);
    const measurement = (measured.structuredContent?.measurements as { value: number }[])[0];
    expect(measurement.value).toBeCloseTo(result.achievedValue, 12);
    console.info('source receipt', JSON.stringify({ best: result.bestParams, achieved: result.achievedValue, measured: measurement.value, evaluations: result.evaluations }));
  }, 120000);

  it('optimizes a current source over negative and zero bounds', async () => {
    const request = structuredClone(native);
    if (request.input.format !== 'spice-ts') throw new Error('Expected native input');
    request.input.document.circuit.components[0] = { type: 'I', id: 'I1', name: 'I1', ports: ports('in', '0'), params: { waveform: 'dc', dc: 0 } };
    const response = await executeTool('spice_optimize', { ...args, request, parameters: [{ kind: 'source', name: 'i1', min: -0.01, max: 0 }], target: 2.5 });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const result = response.structuredContent as unknown as Result;
    expect(result.bestParams.i1).toBeGreaterThanOrEqual(-0.01);
    expect(result.bestParams.i1).toBeLessThanOrEqual(0);
    expect(Math.abs(result.achievedValue - 2.5)).toBeLessThanOrEqual(0.0001);
    expect(result.evaluations).toBeLessThanOrEqual(30);
    console.info('current source receipt', JSON.stringify({ best: result.bestParams, achieved: result.achievedValue, evaluations: result.evaluations }));
  }, 120000);

  it('preserves other source fields and sends signed endpoints without mutating input', async () => {
    const request = structuredClone(native);
    const before = structuredClone(request);
    const seen: number[] = [];
    await runOptimize({ ...args, parameters: [{ kind: 'source', name: 'V1', min: -2, max: 0 }], maxEvaluations: 2 }, request, async changed => {
      if (changed.input.format !== 'spice-ts') throw new Error('Expected native input');
      const params = changed.input.document.circuit.components[0].params;
      expect(params.acMagnitude).toBe(2);
      expect(params.waveform).toBe('dc');
      seen.push(Number(params.dc));
      return { content: [], structuredContent: { measurements: [{ value: 100 }] } };
    }, () => {});
    expect(seen).toEqual([-2, 0]);
    expect(request).toEqual(before);
  });

  it('rejects invalid sources, bounds, duplicate names and formats before execution', async () => {
    const requests: SimulationRequestV1[] = [];
    const missing = structuredClone(native);
    if (missing.input.format !== 'spice-ts') throw new Error('Expected native input');
    missing.input.document.circuit.components.shift();
    requests.push(missing);
    const nested = structuredClone(native);
    if (nested.input.format !== 'spice-ts') throw new Error('Expected native input');
    const source = nested.input.document.circuit.components.shift()!;
    nested.input.document.subcircuits = [{ name: 'nested', ports: ['a', 'b'], components: [source] }] as typeof nested.input.document.subcircuits;
    requests.push(nested);
    const duplicate = structuredClone(native);
    if (duplicate.input.format !== 'spice-ts') throw new Error('Expected native input');
    duplicate.input.document.circuit.components.push({ ...duplicate.input.document.circuit.components[0], name: 'v1' });
    requests.push(duplicate);
    const invalidParams: Record<string, string | number>[] = [{ waveform: 'pulse', dc: 1 }, { waveform: 'dc' }, { waveform: 'dc', dc: 1, distortionF1: 1 }];
    for (const params of invalidParams) {
      const request = structuredClone(native);
      if (request.input.format !== 'spice-ts') throw new Error('Expected native input');
      request.input.document.circuit.components[0].params = params;
      requests.push(request);
    }
    const nonsource = structuredClone(native);
    if (nonsource.input.format !== 'spice-ts') throw new Error('Expected native input');
    nonsource.input.document.circuit.components[0].type = 'R';
    requests.push(nonsource);
    requests.push({ apiVersion: '1', input: { format: 'spice', source: '* nested\n.subckt sub a b\nV1 a b 1\n.ends\n.end' } } as SimulationRequestV1);
    for (const request of requests) {
      let executions = 0;
      await expect(runOptimize(args, request, async () => { executions++; return { content: [] }; }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation' });
      expect(executions).toBe(0);
    }
    expect(await executeTool('spice_optimize', { ...args, request: missing })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    for (const parameter of [{ ...args.parameters[0], min: NaN }, { ...args.parameters[0], max: Infinity }, { ...args.parameters[0], min: 0, max: 0 }]) {
      await expect(runOptimize({ ...args, parameters: [parameter] }, native, async () => { throw new Error('executed'); }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(runOptimize({ ...args, parameters: [args.parameters[0], { ...args.parameters[0], name: 'V1' }] }, native, async () => { throw new Error('executed'); }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('preserves objective failures and cancellation for source optimization', async () => {
    expect(await executeTool('spice_optimize', { ...args, request: native, objective: { ...args.objective, signal: 'v(missing)' } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'OBJECTIVE_ERROR' } } });
    expect(await executeTool('spice_optimize', { ...args, request: native }, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
  });
});
