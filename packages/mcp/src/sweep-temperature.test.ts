import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { measureResult } from './measure.js';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';
import { runSweep } from './sweep.js';

const request: SimulationRequestV1 = {
  apiVersion: '1', input: { format: 'spice-ts', document: {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], analyses: [{ type: 'op' }],
    circuit: { nets: ['in'], components: [
      { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { resistance: 1000, TC1: 0.001 } },
    ] },
  } }, options: { temperature: 60, nominalTemperature: 27, reltol: 1e-8, limits: { maxResultPoints: 100 } },
};
const parameter = { kind: 'temperature', name: 'temp' };
const measurements = [{ kind: 'max', signal: 'i(V1)', analysis: 0 }];
const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_sweep')!.inputSchema);

describe('native temperature sweeps', () => {
  it.each([{ values: [-40, 27, 85] }, { range: { scale: 'lin', start: -40, stop: 85, points: 3 } }])('validates and independently overrides options for $values $range', async fields => {
    const args = { request, parameter, ...fields, measurements };
    const before = structuredClone(args);
    expect(validate(args).valid).toBe(true);
    const seen: number[] = [];
    const result = await runSweep(args, request, async (changed, selected) => {
      expect(changed.options).toEqual({ ...request.options, temperature: changed.options!.temperature });
      expect(selected).toEqual(measurements);
      seen.push(changed.options!.temperature!);
      return { content: [], structuredContent: { measurements: [{ value: changed.options!.temperature }] } };
    }, () => {});
    const expected = 'values' in fields ? fields.values : [-40, 22.5, 85];
    expect(seen).toEqual(expected);
    expect(result.points.map(p => p.value)).toEqual(expected);
    expect(args).toEqual(before);
  });

  it('matches independent direct simulations for a temperature-dependent resistor', async () => {
    const values = [-40, 27, 85];
    const response = await executeTool('spice_sweep', { request, parameter, values, measurements });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const points = response.structuredContent!.points as { measurements: { value: number }[] }[];
    const actual = points.map(p => p.measurements[0].value);
    const expected = await Promise.all(values.map(async temperature => {
      const direct = await simulateProtocolV1({ ...request, options: { ...request.options, temperature } });
      const measured = measureResult(direct, measurements).measurements[0];
      if (!('value' in measured) || typeof measured.value !== 'number') throw new Error('Expected numeric current');
      return measured.value;
    }));
    actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThanOrEqual(1e-10));
    expect(new Set(actual).size).toBeGreaterThan(1);
  });

  it('rejects invalid targets and temperatures before calling back', async () => {
    const execute = vi.fn(async () => ({ content: [], structuredContent: {} }));
    for (const [target, input, values] of [
      [{ kind: 'temperature', name: 'TEMP' }, request.input, [27]],
      [{ kind: 'temperature', name: 'other' }, request.input, [27]],
      [parameter, { format: 'spice', source: '.op' }, [27]],
      [parameter, { format: 'circuit-json', circuit: [], analyses: [] }, [27]],
      [parameter, request.input, [27, -273.15]], [parameter, request.input, [-300]],
      [parameter, request.input, [NaN]], [parameter, request.input, [Infinity]],
    ] as const) {
      const args = { parameter: target, values };
      await expect(runSweep(args, { ...request, input } as SimulationRequestV1, execute, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(validate({ request, parameter: { kind: 'temperature', name: 'other' }, values: [27] }).valid).toBe(false);
  });

  it('preserves failures, caps, checks and cancellation', async () => {
    const execute = vi.fn(async (changed: SimulationRequestV1) => changed.options!.temperature === 27
      ? { content: [], isError: true, structuredContent: { error: { code: 'FAILED' } } }
      : { content: [], structuredContent: { measurements: [{ value: 1 }] } });
    const check = vi.fn();
    const result = await runSweep({ parameter, values: [-40, 27, 85], measurements }, request, execute, check);
    expect(result.points).toMatchObject([{ status: 'complete' }, { status: 'failed', error: { code: 'FAILED' } }, { status: 'complete' }]);
    expect(check).toHaveBeenCalledTimes(6);
    await expect(runSweep({ parameter, values: Array(101).fill(27) }, request, execute, check)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(await executeTool('spice_sweep', { request, parameter, values: [27] }, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
    expect(await executeTool('spice_sweep', { request, parameter, values: [27] }, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });
});
