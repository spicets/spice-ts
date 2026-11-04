import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end' } };
const ramp: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 0.3, 1.2, 2], voltagesV: { out: [0, 0.3, 1.2, 2] }, currentsA: {} }] };
const call = (extra: Record<string, unknown>, data = ramp) => executeTool('spice_tran_metrics', { request, signal: 'v(out)', settlingBandPercent: 20, ...extra }, { simulate: async () => data });

describe('time-weighted transient signal statistics', () => {
  it('integrates a nonuniform linear ramp and interpolated clipped edges', async () => {
    for (const [extra, rms, peakToPeak] of [[{}, Math.sqrt(4 / 3), 2], [{ timeRangeS: [0.5, 1.5] }, Math.sqrt(13 / 12), 1]] as const) {
      const response = await call({ ...extra, includeSignalStatistics: true });
      expect(response.isError).not.toBe(true);
      const s = (response.structuredContent as { signalStatistics: { mean: number; rms: number; peakToPeak: number; unit: string } }).signalStatistics;
      expect(s.mean).toBeCloseTo(1, 12);
      expect(s.rms).toBeCloseTo(rms, 12);
      expect(s.peakToPeak).toBeCloseTo(peakToPeak, 12);
      expect(s.unit).toBe('V');
    }
  });

  it('selects the requested step, differential voltage and current, including bipolar values', async () => {
    const trace = (index: number, multiplier: number) => ({ type: 'tran' as const, analysisIndex: 2, step: { index, parameter: 'R', value: index }, timeS: [0, 0.3, 1.2, 2], voltagesV: { a: [-1, -0.7, 0.2, 1].map(v => v * multiplier + 5), b: [5, 5, 5, 5] }, currentsA: { V1: [-1, -0.7, 0.2, 1].map(v => v * multiplier) } });
    const data: SimulationResultV1 = { status: 'complete', analyses: [trace(0, 3), trace(1, 1)] };
    const before = structuredClone(data);
    for (const [signal, unit] of [['v(a,b)', 'V'], ['i(V1)', 'A']] as const) {
      const response = await call({ signal, analysis: 2, step: 1, includeSignalStatistics: true }, data);
      expect(response.isError).not.toBe(true);
      const s = (response.structuredContent as { signalStatistics: { mean: number; rms: number; peakToPeak: number; unit: string } }).signalStatistics;
      expect(s.mean).toBeCloseTo(0, 12); expect(s.rms).toBeCloseTo(Math.sqrt(1 / 3), 12);
      expect(s.peakToPeak).toBeCloseTo(2, 12); expect(s.unit).toBe(unit);
    }
    expect(data).toEqual(before);
  });

  it.each([1e-200, 1e200, -1e-200, -1e200])('retains representable statistics for amplitude %s', async amplitude => {
    const data: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 0.3, 1.2, 2], voltagesV: { out: [0, 0.15, 0.6, 1].map(v => amplitude * v) }, currentsA: {} }] };
    const response = await call({ includeSignalStatistics: true }, data);
    expect(response.isError).not.toBe(true);
    const s = (response.structuredContent as { signalStatistics: { mean: number; rms: number; peakToPeak: number } }).signalStatistics;
    expect(s.mean / amplitude).toBeCloseTo(0.5, 12);
    expect(s.rms / Math.abs(amplitude)).toBeCloseTo(Math.sqrt(1 / 3), 12);
    expect(s.peakToPeak / Math.abs(amplitude)).toBeCloseTo(1, 12);
  });

  it('retains RMS from a pulse whose duration fraction underflows', async () => {
    const data: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 1e-150, 2e-150, 1e200, 2e200], voltagesV: { out: [0, 1e150, 0, 1e-100, 1e-100] }, currentsA: {} }] };
    const response = await call({ includeSignalStatistics: true }, data);
    expect(response.isError).not.toBe(true);
    const s = (response.structuredContent as { signalStatistics: { mean: number; rms: number } }).signalStatistics;
    expect(s.rms / (1e-25 / Math.sqrt(3))).toBeCloseTo(1, 12);
    expect(s.mean / 7.5e-101).toBeCloseTo(1, 12);
  });

  it('keeps old results and transition errors unchanged when absent or false', async () => {
    const omitted = await call({}); const disabled = await call({ includeSignalStatistics: false });
    expect(disabled).toEqual(omitted);
    expect(omitted.isError).not.toBe(true);
    expect(omitted.structuredContent).not.toHaveProperty('signalStatistics');
    const flat: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 1, 2], voltagesV: { out: [1, 1, 1] }, currentsA: {} }] };
    expect((await call({ includeSignalStatistics: true }, flat)).structuredContent).toEqual((await call({}, flat)).structuredContent);
    const unsettled = await call({ settlingBandPercent: 2, includeSignalStatistics: true });
    expect(unsettled.structuredContent).toMatchObject({ error: { code: 'NOT_SETTLED' } });
  });

  it('rejects invalid options and advertises strict input and output schemas', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_tran_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    expect(tool.inputSchema.properties).toMatchObject({ includeSignalStatistics: { type: 'boolean', default: false } });
    const input = validator.getValidator(tool.inputSchema);
    expect(input({ request, signal: 'v(out)', includeSignalStatistics: true }).valid).toBe(true);
    expect(input({ request, signal: 'v(out)', includeSignalStatistics: 'true' }).valid).toBe(false);
    for (const extra of [{ includeSignalStatistics: 'true' }, { includeSignalStatistics: null }, { includeSignalStatistics: 1 }, { includeSignalStatistics: NaN }, { initialValue: Infinity }, { extra: true }]) {
      expect(await call(extra)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    const success = await call({ includeSignalStatistics: true });
    const output = validator.getValidator(tool.outputSchema!);
    expect(output(success.structuredContent).valid).toBe(true);
    const malformed = structuredClone(success.structuredContent) as { signalStatistics: Record<string, unknown> };
    delete malformed.signalStatistics.unit;
    expect(output(malformed).valid).toBe(false);
  });

  it('runs a real ramp-driven resistor through the public executor', async () => {
    const real = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 PWL(0 0 1m 1 2m 1)\nR1 out 0 1k\n.tran 10u 2m\n.end' } };
    const omitted = await executeTool('spice_tran_metrics', { request: real, signal: 'v(out)' });
    const disabled = await executeTool('spice_tran_metrics', { request: real, signal: 'v(out)', includeSignalStatistics: false });
    const enabled = await executeTool('spice_tran_metrics', { request: real, signal: 'v(out)', includeSignalStatistics: true });
    expect(omitted.isError).not.toBe(true); expect(disabled).toEqual(omitted); expect(enabled.isError).not.toBe(true);
    const { signalStatistics, ...old } = enabled.structuredContent as Record<string, unknown>;
    expect(old).toEqual(omitted.structuredContent);
    expect(signalStatistics).toMatchObject({ mean: expect.closeTo(0.75, 3), rms: expect.closeTo(Math.sqrt(2 / 3), 3), peakToPeak: expect.closeTo(1, 6), unit: 'V' });
  });
});
