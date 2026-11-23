import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { distoMetrics, type DistoSpectrum } from './disto-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const spectrum: DistoSpectrum = {
  frequencies: [1, 10],
  voltageArrays: new Map([[2, new Map([['out', [{ real: -1, imaginary: 1 }, { real: -1, imaginary: -1 }]]])]]),
  currentArrays: new Map(),
};
const diode = `* diode distortion
V1 in 0 DC 0.6 DISTOF1 0.01
D1 in out DM
R1 out 0 100
C1 out 0 1n
.model DM D IS=1e-14 TT=1n CJO=5p
.disto dec 5 1k 100k
.end`;
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
const tool = MCP_TOOLS.find(t => t.name === 'spice_disto_metrics')!;
const validator = new AjvJsonSchemaValidator();
type Value = { real: number; imaginary: number; magnitude: number; magnitudeDb: number | null; phaseDeg: number | null };
type Product = { product: string; points: (Value & { frequencyHz: number })[]; spots: { frequencyHz: number; value: Value | null }[] };

describe('distortion spot frequencies', () => {
  it.each(['dec', 'oct'] as const)('interpolates rectangular values in %s log frequency across phase wrap', variation => {
    const result = distoMetrics(spectrum, 'v(out)', [Math.sqrt(10)], variation);
    expect(result.products[0].spots?.[0]).toMatchObject({ frequencyHz: Math.sqrt(10), value: { real: -1, imaginary: 0, magnitude: 1, magnitudeDb: 0, phaseDeg: 180 } });
  });
  it('uses linear frequency, exact hits, duplicates and explicit out-of-range nulls', () => {
    const spots = distoMetrics(spectrum, 'v(out)', [10, 5.5, 1, 0.1, 11, 5.5], 'lin').products[0].spots!;
    expect(spots.map(s => s.frequencyHz)).toEqual([10, 5.5, 1, 0.1, 11, 5.5]);
    expect(spots.map(s => s.value?.imaginary ?? null)).toEqual([-1, 0, 1, null, null, 0]);
    expect(spots[1].value?.phaseDeg).toBe(180);
  });
  it('uses null dB and phase for interpolated exact zero', () => {
    const zero: DistoSpectrum = { ...spectrum, voltageArrays: new Map([[2, new Map([['out', [{ real: 1, imaginary: 0 }, { real: -1, imaginary: 0 }]]])]]) };
    expect(distoMetrics(zero, 'v(out)', [5.5], 'lin').products[0].spots?.[0].value)
      .toEqual({ real: 0, imaginary: 0, magnitude: 0, magnitudeDb: null, phaseDeg: null });
  });
  it('measures analytic rectangular interpolation error over both coordinate systems', () => {
    for (const variation of ['lin', 'dec', 'oct'] as const) {
      const fractions = Array.from({ length: 101 }, (_, i) => i / 100);
      const frequencies = fractions.map(t => variation === 'lin' ? 1 + 9 * t : Math.pow(10, t));
      const spots = distoMetrics(spectrum, 'v(out)', frequencies, variation).products[0].spots!;
      let maximumError = 0;
      spots.forEach(({ value }, i) => {
        maximumError = Math.max(maximumError, Math.abs(value!.real + 1), Math.abs(value!.imaginary - (1 - 2 * fractions[i])));
      });
      console.log(`analytic ${variation} maximum component error: ${maximumError}`);
      expect(maximumError).toBeLessThan(1e-14);
    }
  });
  it.each([false, true])('queries one existing spectrum for all selectors (two-tone=%s)', async twoTone => {
    const source = twoTone ? diode.replace('DISTOF1 0.01', 'DISTOF1 0.01 DISTOF2 0.005').replace('100k\n', '100k 0.9\n') : diode;
    for (const output of ['v(out)', 'v(out,in)', 'i(V1)']) {
      const args = { request: request(source), output };
      const baseline = await executeTool('spice_disto_metrics', args);
      const queried = await executeTool('spice_disto_metrics', { ...args, spotFrequenciesHz: [1000, Math.sqrt(1000 * 1000 * Math.pow(10, 0.2)), 200000, 1000] });
      expect(queried.isError).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(queried.structuredContent).valid).toBe(true);
      const a = baseline.structuredContent as unknown as { products: Product[] };
      const b = queried.structuredContent as unknown as { products: Product[] };
      expect(b.products).toHaveLength(twoTone ? 3 : 2);
      for (let i = 0; i < b.products.length; i++) {
        const { spots, ...rest } = b.products[i];
        expect(rest).toEqual(a.products[i]);
        const { frequencyHz: _frequency, ...firstValue } = a.products[i].points[0];
        expect(spots[0].value).toEqual(firstValue);
        expect(spots[2].value).toBeNull();
        expect(spots[3]).toEqual(spots[0]);
        const [p, q] = a.products[i].points;
        expect(spots[1].value!.real).toBeCloseTo((p.real + q.real) / 2, 15);
        expect(spots[1].value!.imaginary).toBeCloseTo((p.imaginary + q.imaginary) / 2, 15);
      }
    }
  });
  it.each([null, [], Array(129).fill(1), Array(1), [0], [-1], [NaN], [Infinity], ['1'], 1, {}].map(value => [value]))('rejects invalid option %j', async spotFrequenciesHz => {
    const response = await executeTool('spice_disto_metrics', { request: request(diode), output: 'v(out)', spotFrequenciesHz });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  });
  it('advertises bounds and accepts the 128-element boundary', async () => {
    const validate = validator.getValidator(tool.inputSchema);
    const args = { request: request(diode), output: 'v(out)', spotFrequenciesHz: Array(128).fill(1000) };
    expect(validate(args).valid).toBe(true);
    expect(validate({ ...args, spotFrequenciesHz: [] }).valid).toBe(false);
    expect(validate({ ...args, spotFrequenciesHz: Array(129).fill(1) }).valid).toBe(false);
    expect((await executeTool('spice_disto_metrics', args)).isError).not.toBe(true);
  });
});
