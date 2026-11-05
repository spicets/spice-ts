import { describe, expect, it } from 'vitest';
import { executeTool, MCP_TOOLS } from './server.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { impedanceReport, type ImpedanceSpectrum } from './impedance.js';

const port = { positive: 'in', negative: '0' };
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source: `${source}\n.ac lin 3 100 10000` } });

describe('parallel impedance equivalents', () => {
  it('recovers the capacitance of a parallel RC at multiple frequencies', async () => {
    const response = await executeTool('spice_impedance', { request: request('R1 in 0 1k\nC1 in 0 1u'), port, includeParallelEquivalent: true });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const points = (response.structuredContent as unknown as { points: { parallelCapacitanceF: number; parallelInductanceH: number | null }[] }).points;
    expect(points).toHaveLength(3);
    for (const point of points) {
      expect(Math.abs(point.parallelCapacitanceF / 1e-6 - 1)).toBeLessThan(1e-6);
      expect(point.parallelInductanceH).toBeNull();
    }
  });
});

const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
const validate = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
type Point = { frequencyHz: number; parallelCapacitanceF: number | null; parallelInductanceH: number | null; parallelEquivalentReason?: string };
const component = (type: string, value: number) => ({ type, id: `${type}1`, name: `${type}1`, ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { [{ R: 'resistance', C: 'capacitance', L: 'inductance' }[type]!]: value } });
const native = (parts: { type: string; value: number }[]) => ({ apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', circuit: { components: parts.map(p => component(p.type, p.value)), nets: ['in'] }, analyses: [], models: [], subcircuits: [] } } });
const sweep = { variation: 'lin', points: 3, startFreq: 100, stopFreq: 10000 };

describe('parallel equivalents contracts', () => {
  it.each([
    ['R', 'R1 in 0 1k', [{ type: 'R', value: 1000 }], null, null],
    ['C', 'C1 in 0 1u\nRleak in 0 1t', [{ type: 'C', value: 1e-6 }, { type: 'R', value: 1e12 }], 1e-6, null],
    ['L', 'L1 in 0 10m', [{ type: 'L', value: 0.01 }], null, 0.01],
    ['RC', 'R1 in 0 1k\nC1 in 0 1u', [{ type: 'R', value: 1000 }, { type: 'C', value: 1e-6 }], 1e-6, null],
    ['RL', 'R1 in 0 1k\nL1 in 0 10m', [{ type: 'R', value: 1000 }, { type: 'L', value: 0.01 }], null, 0.01],
  ])('matches analytic %s for SPICE and native JSON at three frequencies', async (_name, source, parts, cap, ind) => {
    for (const input of [request(source), native(parts)]) {
      const result = await executeTool('spice_impedance', { request: input, port, sweep, includeParallelEquivalent: true });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      expect(validate(tool.outputSchema!, result.structuredContent)).toBe(true);
      const points = (result.structuredContent as unknown as { points: Point[] }).points;
      expect(points).toHaveLength(3);
      for (const p of points) {
        if (cap === null) expect(p.parallelCapacitanceF).toBeNull();
        else expect(Math.abs(p.parallelCapacitanceF! / cap - 1)).toBeLessThan(1e-6);
        if (ind === null) expect(p.parallelInductanceH).toBeNull();
        else expect(Math.abs(p.parallelInductanceH! / ind - 1)).toBeLessThan(1e-6);
      }
    }
  });

  it('validates the registered schema, preserves shape and combines independently', async () => {
    const args = { request: request('R1 in 0 1k\nC1 in 0 1u'), port, spotFrequenciesHz: [100, 300] };
    const baseline = await executeTool('spice_impedance', args);
    const disabled = await executeTool('spice_impedance', { ...args, includeParallelEquivalent: false });
    expect(disabled.structuredContent).toEqual(baseline.structuredContent);
    expect(validate(tool.inputSchema, { ...args, includeParallelEquivalent: true })).toBe(true);
    for (const bad of ['true', 0, null, {}]) {
      expect(validate(tool.inputSchema, { ...args, includeParallelEquivalent: bad })).toBe(false);
      expect(await executeTool('spice_impedance', { ...args, includeParallelEquivalent: bad })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const includeAdmittance of [false, true]) for (const includeSeriesEquivalent of [false, true]) {
      const rest = { ...args, includeAdmittance, includeSeriesEquivalent };
      const original = (await executeTool('spice_impedance', rest)).structuredContent as unknown as { points: Record<string, unknown>[]; spots: unknown[] };
      const result = await executeTool('spice_impedance', { ...rest, includeParallelEquivalent: true });
      expect(result.isError).not.toBe(true);
      expect(validate(tool.outputSchema!, result.structuredContent)).toBe(true);
      const enabled = result.structuredContent as unknown as { points: Record<string, unknown>[]; spots: unknown[] };
      expect(enabled.spots).toEqual(original.spots);
      enabled.points.forEach((p, i) => {
        const { parallelCapacitanceF, parallelInductanceH, ...other } = p;
        expect(parallelCapacitanceF).toEqual(expect.any(Number));
        expect(parallelInductanceH).toBeNull();
        expect(other).toEqual(original.points[i]);
      });
    }
  });

  it('handles zero, representable extremes and unrepresentable reciprocal or equivalent', () => {
    const spectrum = (frequencyHz: number, magnitude: number, phaseDegrees: number): ImpedanceSpectrum => ({ frequencyHz: [frequencyHz], positive: [{ magnitude, phaseDegrees }], negative: [{ magnitude: 0, phaseDegrees: 0 }] });
    const point = (frequencyHz: number, magnitude: number, phaseDegrees: number) => impedanceReport(spectrum(frequencyHz, magnitude, phaseDegrees), { port, includeParallelEquivalent: true }).points[0] as unknown as Point;
    expect(point(1, 0, 0)).toMatchObject({ parallelCapacitanceF: null, parallelInductanceH: null, parallelEquivalentReason: 'zero_impedance' });
    expect(() => impedanceReport(spectrum(1, 0, 0), { port, includeParallelEquivalent: true, includeAdmittance: true })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', message: 'Cannot compute admittance of zero impedance' }));
    expect(point(1, 1e-310, -90)).toMatchObject({ parallelCapacitanceF: null, parallelInductanceH: null, parallelEquivalentReason: 'unrepresentable' });
    expect(() => impedanceReport(spectrum(1, 1e-310, -90), { port, includeParallelEquivalent: true, includeAdmittance: true })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', message: 'Admittance is not representable' }));
    expect(point(1e300, 1e300, -90)).toMatchObject({ parallelCapacitanceF: null, parallelInductanceH: null, parallelEquivalentReason: 'unrepresentable' });
    expect(point(1e-300, 1e300, 90)).toMatchObject({ parallelCapacitanceF: null, parallelInductanceH: null, parallelEquivalentReason: 'unrepresentable' });
    const tiny = point(1, 1e300, -90);
    expect(Math.abs(tiny.parallelCapacitanceF! / (1e-300 / (2 * Math.PI)) - 1)).toBeLessThan(1e-12);
    const recovered = point(1e300, 1e300, 90);
    expect(Math.abs(recovered.parallelInductanceH! / (1 / (2 * Math.PI)) - 1)).toBeLessThan(1e-12);
    expect(JSON.stringify([tiny, recovered])).not.toMatch(/NaN|Infinity/);
    for (const f of [0, -1, Infinity, NaN]) expect(() => point(f, 1, 0)).toThrow();
  });
});
