import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { impedanceReport, type ImpedanceSpectrum } from './impedance.js';

const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
const validate = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const port = { positive: 'in', negative: '0' };
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source: `${source}\n.ac lin 1 1000 1000` } });
type Point = { frequencyHz: number; conductanceS: number; susceptanceS: number };
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, Math.abs(expected) * 1e-9));

describe('opt-in impedance admittance', () => {
  it.each([
    ['resistor', 'R1 in 0 1k', port, 0.001, 0],
    ['capacitor', 'C1 in 0 1u', port, 0, 2 * Math.PI * 1000 * 1e-6],
    ['series RC', 'R1 in mid 1k\nC1 mid 0 1u', port, 1000 / (1e6 + (1 / (2 * Math.PI * 1000 * 1e-6)) ** 2), (1 / (2 * Math.PI * 1000 * 1e-6)) / (1e6 + (1 / (2 * Math.PI * 1000 * 1e-6)) ** 2)],
    ['floating', 'V1 neg 0 2\nR1 in neg 2k', { positive: 'in', negative: 'neg' }, 0.0005, 0],
    ['reversed', 'V1 neg 0 2\nR1 in neg 2k', { positive: 'neg', negative: 'in' }, 0.0005, 0],
  ])('%s analytic admittance', async (_name, source, terminals, g, b) => {
    const args = { request: request(source), port: terminals, includeAdmittance: true };
    expect(validate(tool.inputSchema, args)).toBe(true);
    const response = await executeTool('spice_impedance', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    const point = (response.structuredContent as unknown as { points: Point[] }).points[0];
    close(point.conductanceS, g); close(point.susceptanceS, b);
  });
  it('preserves the default shape, validates modes and rejects nonboolean', async () => {
    const args = { request: request('R1 in 0 1k'), port };
    const omitted = await executeTool('spice_impedance', args);
    const disabled = await executeTool('spice_impedance', { ...args, includeAdmittance: false });
    const enabled = await executeTool('spice_impedance', { ...args, includeAdmittance: true });
    expect(disabled.structuredContent).toEqual(omitted.structuredContent);
    expect(validate(tool.inputSchema, { ...args, includeAdmittance: false })).toBe(true);
    expect(validate(tool.outputSchema!, omitted.structuredContent)).toBe(true);
    const oldReport = omitted.structuredContent as unknown as { points: Record<string, number>[]; [key: string]: unknown };
    const newReport = enabled.structuredContent as unknown as { points: Record<string, number>[]; [key: string]: unknown };
    const { conductanceS, susceptanceS, ...rest } = newReport.points[0];
    expect(rest).toEqual(oldReport.points[0]);
    expect({ ...newReport, points: [rest] }).toEqual(oldReport);
    expect(Number.isFinite(conductanceS) && Number.isFinite(susceptanceS)).toBe(true);
    expect(validate(tool.inputSchema, { ...args, includeAdmittance: 'true' })).toBe(false);
    expect(await executeTool('spice_impedance', { ...args, includeAdmittance: 'true' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
  it.each([1e200, 1e-200])('computes scale-safe complex reciprocal for Z components around %s', magnitude => {
    const spectrum: ImpedanceSpectrum = { frequencyHz: [1], positive: [{ magnitude, phaseDegrees: 45 }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
    const point = impedanceReport(spectrum, { port, includeAdmittance: true }).points[0];
    if (!('conductanceS' in point)) throw new Error('missing admittance');
    expect(point.conductanceS / (Math.SQRT1_2 / magnitude)).toBeCloseTo(1, 12);
    expect(point.susceptanceS / (-Math.SQRT1_2 / magnitude)).toBeCloseTo(1, 12);
  });
  it('rejects zero and unrepresentable reciprocals only when enabled', () => {
    for (const magnitude of [0, Number.MIN_VALUE]) {
      const spectrum: ImpedanceSpectrum = { frequencyHz: [1], positive: [{ magnitude, phaseDegrees: 0 }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
      try { impedanceReport(spectrum, { port, includeAdmittance: true }); expect.fail('expected INVALID_REQUEST'); } catch (error) { expect(error).toMatchObject({ code: 'INVALID_REQUEST' }); }
      expect(impedanceReport(spectrum, { port }).points[0]).not.toHaveProperty('conductanceS');
    }
  });
  it('rejects a nonzero impedance component whose reciprocal underflows', () => {
    const spectrum: ImpedanceSpectrum = { frequencyHz: [1], positive: [{ magnitude: 1e300, phaseDegrees: 1e-310 }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
    expect(impedanceReport(spectrum, { port }).points[0].reactanceOhm).not.toBe(0);
    try { impedanceReport(spectrum, { port, includeAdmittance: true }); expect.fail('expected INVALID_REQUEST'); } catch (error) { expect(error).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', retryable: false }); }
  });
  it('returns a structured public error for zero impedance', async () => {
    const args = { request: request('V1 in 0 0'), port };
    expect((await executeTool('spice_impedance', args)).isError).not.toBe(true);
    expect(await executeTool('spice_impedance', { ...args, includeAdmittance: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
});
