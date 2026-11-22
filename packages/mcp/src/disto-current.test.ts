import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { parseTitleless, simulate } from '@spice-ts/core';
import type { DistortionProduct } from '@spice-ts/core';
import { distoMetrics, distoOutput, type DistoSpectrum } from './disto-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const products: DistortionProduct[] = [2, 3, 'f1+f2', 'f1-f2', '2f1-f2'];
const spectrum: DistoSpectrum = {
  frequencies: [1000, 2000],
  voltageArrays: new Map(products.map(p => [p, new Map([
    ['a', [{ real: 3, imaginary: 4 }, { real: 0, imaginary: 0 }]],
    ['b', [{ real: 1, imaginary: -2 }, { real: 0, imaginary: 0 }]],
  ])])),
  currentArrays: new Map(products.map(p => [p, new Map([
    ['Vsource', [{ real: -3, imaginary: 4 }, { real: 0, imaginary: 0 }]],
  ])])),
};
const diode = `* nonlinear distortion
V1 in 0 DC 0.6 DISTOF1 0.01
D1 in out DM
R1 out 0 100
C1 out 0 1n
.model DM D IS=1e-14 TT=1n CJO=5p
.disto dec 5 1k 100k
.end`;
const validator = new AjvJsonSchemaValidator();
const tool = MCP_TOOLS.find(t => t.name === 'spice_disto_metrics')!;
const args = (output: string, source = diode) => ({ request: { apiVersion: '1', input: { format: 'spice', source } }, output });

describe('distortion branch current metrics', () => {
  it('returns known complex currents for all five products, preserving sign, units, and zero semantics', () => {
    expect(distoOutput(args('I(vSoUrCe)'))).toBe('I(vSoUrCe)');
    const result = distoMetrics(spectrum, 'I(vSoUrCe)');
    expect(result).toMatchObject({ output: 'I(vSoUrCe)', magnitudeUnit: 'A', decibelReference: '1 A' });
    expect(result.products.map(p => p.product)).toEqual(['HD2', 'HD3', 'SIM2', 'DIM2', 'DIM3']);
    for (const { points } of result.products) {
      expect(points[0]).toMatchObject({ real: -3, imaginary: 4, magnitude: 5 });
      expect(points[0].magnitudeDb).toBeCloseTo(20 * Math.log10(5), 12);
      expect(points[0].phaseDeg).toBeCloseTo(Math.atan2(4, -3) * 180 / Math.PI, 12);
      expect(points[1]).toMatchObject({ real: 0, imaginary: 0, magnitude: 0, magnitudeDb: null, phaseDeg: null });
    }
    expect(validator.getValidator(tool.outputSchema!)(result).valid).toBe(true);
  });
  it('preserves single and differential voltage results', () => {
    const single = distoMetrics(spectrum, 'v(a)');
    const differential = distoMetrics(spectrum, 'V(A,B)');
    expect(single).toMatchObject({ magnitudeUnit: 'V', decibelReference: '1 V' });
    expect(differential).toMatchObject({ magnitudeUnit: 'V', decibelReference: '1 V' });
    expect(single.products[0].points[0]).toMatchObject({ real: 3, imaginary: 4 });
    expect(differential.products[0].points[0]).toMatchObject({ real: 2, imaginary: 6 });
  });
  it.each(['i()', 'i(v1,v2)', 'i(v 1)', 'i((v1))', 'x(v1)', 'i(v1', 'i(v1) '])('rejects malformed selector %s in schema and runtime', output => {
    expect(validator.getValidator(tool.inputSchema)(args(output)).valid).toBe(false);
    expect(() => distoOutput(args(output))).toThrow();
  });
  it.each(['i(missing)', 'i(R1)', 'i(0)'])('rejects unavailable branch %s without substituting zero', output => {
    expect(() => distoMetrics(spectrum, output)).toThrow();
  });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite branch current %s', value => {
    const broken = structuredClone(spectrum);
    broken.currentArrays.get(2)!.get('Vsource')![0].real = value;
    expect(() => distoMetrics(broken, 'i(vsource)')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', phase: 'serialize' }));
  });
  it.each([false, true])('matches public MCP complex currents to core for diode deck (two-tone=%s)', async twoTone => {
    const source = twoTone ? diode.replace('DISTOF1 0.01', 'DISTOF1 0.01 30 DISTOF2 0.005 -20').replace('100k\n', '100k 0.9\n') : diode;
    const request = args('I(v1)', source);
    expect(validator.getValidator(tool.inputSchema)(request).valid).toBe(true);
    const core = (await simulate(parseTitleless(source))).distortion!;
    const response = await executeTool('spice_disto_metrics', request);
    expect(response.isError).not.toBe(true);
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const result = response.structuredContent as unknown as { magnitudeUnit: string; decibelReference: string; products: { product: string; points: { real: number; imaginary: number }[] }[] };
    expect(result).toMatchObject({ magnitudeUnit: 'A', decibelReference: '1 A' });
    expect(result.products.map(p => p.product)).toEqual(twoTone ? ['SIM2', 'DIM2', 'DIM3'] : ['HD2', 'HD3']);
    let maxAbsolute = 0;
    let maxRelative = 0;
    core.products.forEach((product, j) => core.current('V1', product).forEach((value, i) => {
      const point = result.products[j].points[i];
      const error = Math.hypot(point.real - value.real, point.imaginary - value.imaginary);
      const magnitude = Math.hypot(value.real, value.imaginary);
      maxAbsolute = Math.max(maxAbsolute, error);
      if (magnitude > 1e-15) {
        maxRelative = Math.max(maxRelative, error / magnitude);
        expect(error / magnitude).toBeLessThanOrEqual(1e-10);
      } else expect(error).toBeLessThanOrEqual(1e-15);
    }));
    // The public tool currently reproduces core exactly, stronger than the required tolerance.
    expect(maxAbsolute).toBe(0);
    expect(maxRelative).toBe(0);
  });
  it('returns a structured error for an unknown public branch', async () => {
    const response = await executeTool('spice_disto_metrics', args('i(missing)'));
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', retryable: false } } });
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  });
  it('rejects malformed current selectors through the public tool', async () => {
    expect(await executeTool('spice_disto_metrics', args('i(v1,v2)')))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
  it('retains result point limits for current selectors', async () => {
    const request = args('i(v1)');
    const response = await executeTool('spice_disto_metrics', { ...request, request: { ...request.request, options: { limits: { maxResultPoints: 2 } } } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });
});
