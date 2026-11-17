import { expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { parseTitleless } from '@spice-ts/core';
import type { DistortionProduct } from '@spice-ts/core';
import { distoMetrics, type DistoSpectrum } from './disto-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const diode = `* diode
V1 in 0 DC 0.6 DISTOF1 0.01
D1 in out DM
R1 out 0 100
C1 out 0 1n
.model DM D IS=1e-14 TT=1n CJO=5p
.disto dec 5 1k 100k
.end`;
const tool = MCP_TOOLS.find(t => t.name === 'spice_disto_metrics')!;
const validator = new AjvJsonSchemaValidator();
type Point = { real: number; imaginary: number; magnitude: number };
type Metrics = { products: { product: string; points: Point[] }[] };

it('accepts a differential output selector', async () => {
  const response = await executeTool('spice_disto_metrics', { request: { apiVersion: '1', input: { format: 'spice', source: diode } }, output: 'v(out,in)' });
  expect(response.isError).not.toBe(true);
});

it('subtracts complex phasors before derived metrics for all five products', () => {
  const products: DistortionProduct[] = [2, 3, 'f1+f2', 'f1-f2', '2f1-f2'];
  const spectrum: DistoSpectrum = { frequencies: [1000], currentArrays: new Map(),
    voltageArrays: new Map(products.map(product => [product, new Map([
      ['a', [{ real: 3, imaginary: 4 }]], ['b', [{ real: 1, imaginary: -2 }]],
    ])])) };
  const result = distoMetrics(spectrum, 'V(A,B)');
  expect(result.products.map(p => p.product)).toEqual(['HD2', 'HD3', 'SIM2', 'DIM2', 'DIM3']);
  for (const { points: [p] } of result.products) {
    expect(p.real).toBe(2);
    expect(p.imaginary).toBe(6);
    expect(p.magnitude).toBeCloseTo(Math.sqrt(40), 12);
    expect(p.magnitudeDb!).toBeCloseTo(20 * Math.log10(Math.sqrt(40)), 12);
    expect(p.phaseDeg!).toBeCloseTo(Math.atan2(6, 2) * 180 / Math.PI, 12);
  }
  expect(distoMetrics(spectrum, 'v(A,0)').products).toEqual(distoMetrics(spectrum, 'v(a)').products);
  const inverse = distoMetrics(spectrum, 'v(0,A)').products[0].points[0];
  expect([inverse.real, inverse.imaginary]).toEqual([-3, -4]);
  for (const { points: [p] } of distoMetrics(spectrum, 'v(a,A)').products) {
    expect(p).toMatchObject({ real: 0, imaginary: 0, magnitude: 0, magnitudeDb: null, phaseDeg: null });
  }
});

it.each([false, true])('matches single-ended SPICE and native diode outputs (two-tone=%s)', async twoTone => {
  const source = twoTone ? diode.replace('DISTOF1 0.01', 'DISTOF1 0.01 DISTOF2 0.005').replace('100k\n', '100k 0.9\n') : diode;
  const ir = parseTitleless(source).toIR();
  const document = {
    format: 'spice-ts', schemaVersion: '1.0',
    circuit: { ...ir, components: ir.components.map(({ displayValue: _displayValue, ...component }) => component) },
    models: [{ name: 'DM', type: 'D', params: { IS: 1e-14, TT: 1e-9, CJO: 5e-12 } }], subcircuits: [],
    analyses: [{ type: 'disto', variation: 'dec', points: 5, startFreq: 1e3, stopFreq: 1e5, ...(twoTone ? { f2OverF1: 0.9 } : {}) }],
  };
  Object.assign(document.circuit.components[0].params, { distortionF1: { magnitude: 0.01 }, ...(twoTone ? { distortionF2: { magnitude: 0.005 } } : {}) });
  for (const input of [{ format: 'spice', source }, { format: 'spice-ts', document }]) {
    const request = { apiVersion: '1', input };
    const run = async (output: string) => {
      const args = { request, output };
      expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(true);
      const response = await executeTool('spice_disto_metrics', args);
      expect(response.isError).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      return response.structuredContent as unknown as Metrics;
    };
    const a = await run('v(out)');
    const b = await run('v(in)');
    const diff = await run('V(OUT,IN)');
    expect(diff.products.map(p => p.product)).toEqual(twoTone ? ['SIM2', 'DIM2', 'DIM3'] : ['HD2', 'HD3']);
    diff.products.forEach((product, j) => product.points.forEach((point, i) => {
      const real = a.products[j].points[i].real - b.products[j].points[i].real;
      const imaginary = a.products[j].points[i].imaginary - b.products[j].points[i].imaginary;
      expect(point.real).toBeCloseTo(real, 12);
      expect(point.imaginary).toBeCloseTo(imaginary, 12);
      expect(point.magnitude).toBeCloseTo(Math.hypot(real, imaginary), 12);
    }));
  }
});

it.each(['v(out,)', 'v(,out)', 'v(out,in,x)', 'v(out, in)', 'v()', 'v(out,missing)', 'v(missing,out)'])('returns structured errors for %s', async output => {
  const args = { request: { apiVersion: '1', input: { format: 'spice', source: diode } }, output };
  const response = await executeTool('spice_disto_metrics', args);
  expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', retryable: false } } });
  expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  if (!output.includes('missing')) expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(false);
});
