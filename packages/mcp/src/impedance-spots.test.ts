import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { impedanceReport } from './impedance.js';
import { DEFAULT_MCP_LIMITS, executeTool, MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
type Point = { frequencyHz: number; resistanceOhm: number; reactanceOhm: number; magnitudeOhm: number; phaseDeg: number };
type Report = { points: Point[]; spots: (Point & { outOfRange: boolean })[] };
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(1e-10);

describe('impedance spot frequencies', () => {
  it('returns exact resistor sweep knots as spots without changing default output', async () => {
    const args = { request: request('R1 in 0 1k\n.ac lin 3 10 100'), port };
    const baseline = await executeTool('spice_impedance', args);
    expect(baseline.structuredContent).not.toHaveProperty('spots');
    const points = (baseline.structuredContent as unknown as Report).points;
    const result = await executeTool('spice_impedance', { ...args, spotFrequenciesHz: points.map(p => p.frequencyHz) });
    expect(result.structuredContent).toMatchObject({ spots: points.map(p => ({ ...p, outOfRange: false })) });
  });

  it.each(['lin', 'dec', 'oct'] as const)('interpolates real and imaginary components across phase wrap for %s', variation => {
    const spectrum = { frequencyHz: [10, 100], positive: [{ magnitude: 10, phaseDegrees: 170 }, { magnitude: 20, phaseDegrees: -170 }], negative: [{ magnitude: 0, phaseDegrees: 0 }, { magnitude: 0, phaseDegrees: 0 }] };
    const frequencyHz = variation === 'lin' ? 55 : Math.sqrt(1000);
    const sweep = { type: 'ac' as const, variation, points: 2, startFreq: 10, stopFreq: 100 };
    const report = impedanceReport(spectrum, { port, sweep, spotFrequenciesHz: [frequencyHz] });
    const spot = report.spots![0];
    const re = (10 * Math.cos(170 * Math.PI / 180) + 20 * Math.cos(-170 * Math.PI / 180)) / 2;
    const im = (10 * Math.sin(170 * Math.PI / 180) + 20 * Math.sin(-170 * Math.PI / 180)) / 2;
    close(spot.resistanceOhm!, re); close(spot.reactanceOhm!, im);
    close(spot.magnitudeOhm!, Math.hypot(re, im)); close(spot.phaseDeg!, Math.atan2(im, re) * 180 / Math.PI);
    expect(Math.abs(spot.phaseDeg!)).toBeGreaterThan(170);
  });

  it.each(['lin', 'dec'] as const)('uses effective %s sweep for real RC knots and interpolation', async variation => {
    const args = { request: request(`R1 in mid 1k\nC1 mid 0 1u\n.ac ${variation} 3 10 100`), port };
    const baseline = await executeTool('spice_impedance', args);
    const points = (baseline.structuredContent as unknown as Report).points;
    const [a, b] = points;
    const frequencyHz = variation === 'lin' ? (a.frequencyHz + b.frequencyHz) / 2 : Math.sqrt(a.frequencyHz * b.frequencyHz);
    const result = await executeTool('spice_impedance', { ...args, spotFrequenciesHz: [a.frequencyHz, frequencyHz, b.frequencyHz, 1, 1000] });
    expect(result.isError).not.toBe(true);
    const report = result.structuredContent as unknown as Report;
    expect(report.spots[0]).toEqual({ ...a, outOfRange: false });
    expect(report.spots[2]).toEqual({ ...b, outOfRange: false });
    const re = (a.resistanceOhm + b.resistanceOhm) / 2, im = (a.reactanceOhm + b.reactanceOhm) / 2;
    close(report.spots[1].resistanceOhm, re); close(report.spots[1].reactanceOhm, im);
    close(report.spots[1].magnitudeOhm, Math.hypot(re, im)); close(report.spots[1].phaseDeg, Math.atan2(im, re) * 180 / Math.PI);
    expect(report.spots.slice(3)).toEqual([1, 1000].map(frequencyHz => ({ frequencyHz, resistanceOhm: null, reactanceOhm: null, magnitudeOhm: null, phaseDeg: null, outOfRange: true })));
  });

  it('publishes valid discovery schemas and enforces the serialized byte limit', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
    const args = { request: request('R1 in 0 1k\n.ac lin 2 10 100'), port, spotFrequenciesHz: Array(128).fill(10) };
    const validator = new AjvJsonSchemaValidator();
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_impedance', args);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    expect((response.structuredContent as unknown as Report).spots).toHaveLength(128);
    const bytes = Buffer.byteLength(JSON.stringify(response.structuredContent));
    expect((await executeTool('spice_impedance', args, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: bytes - 1 } })).structuredContent).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    const empty = await executeTool('spice_impedance', { ...args, spotFrequenciesHz: [] });
    expect(empty.structuredContent).toMatchObject({ spots: [] });
  });

  it('supports spots together with admittance', async () => {
    const args = { request: request('R1 in 0 1k\n.ac lin 3 10 100'), port, includeAdmittance: true, spotFrequenciesHz: [10, 20] };
    const response = await executeTool('spice_impedance', args);
    expect(response.isError).not.toBe(true);
    const report = response.structuredContent as unknown as Report;
    expect(report.points[0]).toHaveProperty('conductanceS');
    expect(report.spots[0]).not.toHaveProperty('conductanceS');
    const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  });

  it.each([null, 1, [0], [-1], [Infinity], [-Infinity], [NaN], ['10'], Array(129).fill(10)])('rejects invalid selector %j with structured error', async spotFrequenciesHz => {
    const response = await executeTool('spice_impedance', { request: request('R1 in 0 1k\n.ac lin 2 10 100'), port, spotFrequenciesHz });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } } });
  });
});
