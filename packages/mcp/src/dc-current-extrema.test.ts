import { describe, expect, it, vi } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const request = (reverse = false) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source: `* resistor oracle\nVin out 0 0\nR1 out 0 1k\n.dc Vin ${reverse ? '2 -2 -1' : '-2 2 1'}\n.end\n` } });
const base = { request: request(), sweptSource: 'Vin', output: 'v(out)' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_dc_metrics')!;
const args = { ...base, currentSignal: 'i(Vin)', includeCurrentExtrema: true };
type Extrema = { min: { currentA: number; sweepPoint: number }; max: { currentA: number; sweepPoint: number } };
const extrema = (value: unknown) => (value as { currentExtrema: Extrema }).currentExtrema;
const trace = (axis: number[], currents: number[]) => ({ status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'Vin', unit: 'V' as const, values: axis }, voltagesV: { out: axis }, currentsA: { vin: currents } }] });

describe('DC sampled current extrema', () => {
  it.each([false, true])('matches Ohm law and raw core at exact knots (reversed=%s)', async reverse => {
    const req = request(reverse);
    const raw = await simulateProtocolV1(req);
    const dc = raw.analyses.find(a => a.type === 'dc');
    if (!dc || dc.type !== 'dc') throw new Error('missing DC result');
    const simulate = vi.fn(simulateProtocolV1);
    const response = await executeTool(tool.name, { ...args, request: req }, { simulate });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(simulate).toHaveBeenCalledTimes(1);
    const actual = extrema(response.structuredContent);
    const currents = dc.currentsA[Object.keys(dc.currentsA).find(k => k.toLowerCase() === 'vin')!];
    for (const [kind, coordinate] of [['min', 2], ['max', -2]] as const) {
      expect(actual[kind].sweepPoint).toBe(coordinate);
      expect(Math.abs(actual[kind].currentA - (-coordinate / 1000))).toBeLessThan(1e-14);
      expect(actual[kind].currentA).toBe(currents[dc.axis.values.indexOf(coordinate)]);
    }
  });

  it.each([false, true])('selects first traversal sample of signed nonmonotonic plateaus (reversed=%s)', async reverse => {
    const axis = [0, 1, 2, 3, 4, 5, 6], currents = [0, -3, -3, 2, 4, 4, 1];
    const result = trace(reverse ? [...axis].reverse() : axis, reverse ? [...currents].reverse() : currents);
    const simulate = vi.fn(async () => result);
    const response = await executeTool(tool.name, args, { simulate });
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(extrema(response.structuredContent)).toEqual({ min: { currentA: -3, sweepPoint: reverse ? 2 : 1 }, max: { currentA: 4, sweepPoint: reverse ? 5 : 4 } });
  });

  it('keeps spots and crossings when extrema are requested together', async () => {
    const result = trace([0, 1, 2], [1, -2, 3]);
    const simulate = vi.fn(async () => result);
    const response = await executeTool(tool.name, { ...args, sweepPoints: [1], currentLevelsA: [0] }, { simulate });
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ currentExtrema: { min: { currentA: -2, sweepPoint: 1 }, max: { currentA: 3, sweepPoint: 2 } }, currentSpots: [{ currentA: -2 }], currentLevelCrossings: [{ currentLevelA: 0, sweepPoint: 1 / 3 }] });
  });

  it('uses the first sample for a constant-current plateau', async () => {
    const response = await executeTool(tool.name, args, { simulate: async () => trace([3, 2, 1], [-1, -1, -1]) });
    expect(extrema(response.structuredContent)).toEqual({ min: { currentA: -1, sweepPoint: 3 }, max: { currentA: -1, sweepPoint: 3 } });
  });

  it('validates input and success/error output schemas without changing defaults', async () => {
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema); const output = validator.getValidator(tool.outputSchema!);
    expect(input(args).valid).toBe(true);
    expect(input({ ...args, currentSignal: undefined }).valid).toBe(false);
    expect(input({ ...args, includeCurrentExtrema: false }).valid).toBe(false);
    expect(input({ ...args, includeCurrentExtrema: 'yes' }).valid).toBe(false);
    const result = trace([0, 1, 2], [1, -2, 3]);
    const simulate = async () => result;
    const success = await executeTool(tool.name, args, { simulate });
    expect(output(success.structuredContent).valid).toBe(true);
    const legacy = await executeTool(tool.name, base, { simulate });
    const disabled = await executeTool(tool.name, { ...base, includeCurrentExtrema: false }, { simulate });
    expect(disabled.structuredContent).toEqual(legacy.structuredContent);
    expect(legacy.structuredContent).not.toHaveProperty('currentExtrema');
    const bad = await executeTool(tool.name, { ...args, currentSignal: 'i(missing)' }, { simulate });
    expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    expect(output(bad.structuredContent).valid).toBe(true);
  });

  it('returns structured errors for invalid flags and malformed data', async () => {
    for (const extra of [{ currentSignal: undefined }, { includeCurrentExtrema: 'true' }, { currentSignal: 'i(missing)' }]) {
      const response = await executeTool(tool.name, { ...args, ...extra }, { simulate: async () => trace([0, 1], [0, 1]) });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    }
    for (const values of [[0], [0, NaN], [0, Infinity]]) {
      const response = await executeTool(tool.name, args, { simulate: async () => trace([0, 1], values) });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const currentRequest = { apiVersion: '1', input: { format: 'spice', source: '* current sweep\nI1 out 0 0\nR1 out 0 1k\n.dc I1 0 1m 0.5m\n.end' } };
    const response = await executeTool(tool.name, { ...args, request: currentRequest, sweptSource: 'I1', input: 'v(out)', currentSignal: 'i(I1)' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
});
