import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { impedanceReport, type ImpedanceSpectrum } from './impedance.js';

const port = { positive: 'in', negative: '0' };
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source: `${source}\n.ac lin 3 100 10000` } });
const validate = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
type Point = { frequencyHz: number; reactanceOhm: number; seriesCapacitanceF: number | null; seriesInductanceH: number | null; seriesEquivalentReason?: string };

 describe('series equivalent impedance', () => {
  it('reports a series RC capacitance through the public tool', async () => {
    const response = await executeTool('spice_impedance', { request: request('R1 in mid 1k\nC1 mid 0 1u'), port, includeSeriesEquivalent: true });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    const points = (response.structuredContent as unknown as { points: Point[] }).points;
    for (const p of points) {
      expect(Math.abs(p.seriesCapacitanceF! / 1e-6 - 1)).toBeLessThan(1e-6);
      expect(p.seriesInductanceH).toBeNull();
    }
  });

  it('recovers an RL inductance and switches sides of RLC resonance', async () => {
    for (const [source, expected] of [['R1 in mid 1k\nL1 mid 0 10m', 0.01], ['R1 in mid 10\nL1 mid out 10m\nC1 out 0 1u\nRleak out 0 1g', null]] as const) {
      const response = await executeTool('spice_impedance', { request: request(source), port, includeSeriesEquivalent: true });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      const points = (response.structuredContent as unknown as { points: Point[] }).points;
      if (expected !== null) for (const p of points) {
        expect(Math.abs(p.seriesInductanceH! / expected - 1)).toBeLessThan(1e-6);
        expect(p.seriesCapacitanceF).toBeNull();
      }
      else {
        expect(points[0].seriesCapacitanceF).toBeGreaterThan(0);
        expect(points[0].seriesInductanceH).toBeNull();
        expect(points[2].seriesInductanceH).toBeGreaterThan(0);
        expect(points[2].seriesCapacitanceF).toBeNull();
      }
    }
  });

  it('preserves default and spot shapes, including with admittance, and rejects invalid flags', async () => {
    const args = { request: request('R1 in 0 1k'), port, includeAdmittance: true, spotFrequenciesHz: [100, 300] };
    const omitted = await executeTool('spice_impedance', args);
    const disabled = await executeTool('spice_impedance', { ...args, includeSeriesEquivalent: false });
    const enabled = await executeTool('spice_impedance', { ...args, includeSeriesEquivalent: true });
    expect(disabled.structuredContent).toEqual(omitted.structuredContent);
    expect(validate(tool.inputSchema, { ...args, includeSeriesEquivalent: true })).toBe(true);
    expect(validate(tool.outputSchema!, enabled.structuredContent)).toBe(true);
    const old = omitted.structuredContent as unknown as { points: Record<string, unknown>[]; spots: unknown[] };
    const result = enabled.structuredContent as unknown as { points: Record<string, unknown>[]; spots: unknown[] };
    expect(result.spots).toEqual(old.spots);
    result.points.forEach((p, i) => {
      const { seriesCapacitanceF, seriesInductanceH, ...rest } = p;
      expect(seriesCapacitanceF).toBeNull(); expect(seriesInductanceH).toBeNull();
      expect(rest).toEqual(old.points[i]);
    });
    expect(validate(tool.inputSchema, { ...args, includeSeriesEquivalent: 'true' })).toBe(false);
    expect(await executeTool('spice_impedance', { ...args, includeSeriesEquivalent: 'true' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('handles exact zero and finite extremes without nonfinite equivalents', () => {
    const point = (frequencyHz: number, magnitude: number, phaseDegrees: number) => {
      const spectrum: ImpedanceSpectrum = { frequencyHz: [frequencyHz], positive: [{ magnitude, phaseDegrees }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
      return impedanceReport(spectrum, { port, includeSeriesEquivalent: true }).points[0] as unknown as Point;
    };
    expect(point(1, 2, 0)).toMatchObject({ seriesCapacitanceF: null, seriesInductanceH: null });
    expect(point(1e-300, 1e300, 90)).toMatchObject({ seriesCapacitanceF: null, seriesInductanceH: null, seriesEquivalentReason: 'unrepresentable' });
    expect(point(1e300, 1e-300, 90)).toMatchObject({ seriesCapacitanceF: null, seriesInductanceH: null, seriesEquivalentReason: 'unrepresentable' });
    expect(point(1e-300, 1e-300, -90)).toMatchObject({ seriesCapacitanceF: null, seriesInductanceH: null, seriesEquivalentReason: 'unrepresentable' });
    const recovered = point(1e300, 1e-310, -90);
    expect(recovered.seriesCapacitanceF! / (1e10 / (2 * Math.PI))).toBeCloseTo(1, 10);
    const tinyPhase = point(1, 1, 1e-12);
    expect(tinyPhase.seriesInductanceH).toBeGreaterThan(0);
    expect(tinyPhase.seriesCapacitanceF).toBeNull();
    const safe = point(1e200, 1e200, 90);
    expect(safe.seriesInductanceH! / (1 / (2 * Math.PI))).toBeCloseTo(1, 12);
    expect(JSON.stringify([recovered, safe])).not.toMatch(/Infinity|NaN/);
  });
});
