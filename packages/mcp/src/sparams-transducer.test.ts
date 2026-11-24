import { describe, expect, it } from 'vitest';
import { SParameterResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool } from './server.js';
import { sparamsArgs, sparamsInputSchema, sparamsOutputSchema, sparamsReport } from './sparams.js';

type C = { real: number; imaginary: number };
const c = (real: number, imaginary = 0): C => ({ real, imaginary });
const terminations = { source: c(0.3, -0.2), load: c(-0.2, 0.1) };
const matched = { source: c(0), load: c(0) };
const matrix = (values: C[], frequencies = [100]) => new SParameterResult(frequencies, ['V1', 'V2'], new Map(values.map((value, i) => [`S_${Math.floor(i / 2) + 1}_${i % 2 + 1}`, frequencies.map(() => ({ ...value }))])));
const report = (raw: SParameterResult, t = terminations) => sparamsReport([raw], { netlist: 'x', transducerGain: t });
const pad = '* matched pad\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\nR1 in mid 16.666666666666668\nR2 mid out 16.666666666666668\nR3 mid 0 66.66666666666667\n.sp lin 3 100 1000 0\n.end';

describe('sampled transducer gain', () => {
  it('accepts matched terminations and reports squared forward transmission', () => {
    const args = sparamsArgs({ netlist: 'x', transducerGain: matched });
    expect(sparamsReport([matrix([c(0), c(0.1), c(0.5), c(0)])], args).points[0]).toMatchObject({ transducerGain: { linear: 0.25, reason: null } });
  });
  it('preserves finite gain when transmission products overflow before matched terminations', () => {
    const value = report(matrix([c(0), c(1e200), c(1e150), c(0)]), matched).points[0].transducerGain!;
    expect(value.reason).toBeNull();
    expect(value.linear! / 1e300).toBeCloseTo(1, 12);
  });
  it('preserves finite bilateral products with tiny nonzero terminations', () => {
    const value = report(matrix([c(0), c(1e200), c(1e150), c(0)]), { source: c(5e-201), load: c(1e-150) }).points[0].transducerGain!;
    expect(value.reason).toBeNull();
    expect(value.linear! / 4e300).toBeCloseTo(1, 12);
  });
  it('preserves finite gain when the denominator product overflows', () => {
    // High-precision canonical formula: (0.19 * 0.19) / (0.9 * 17) ** 2.
    const value = report(matrix([c(1e308), c(0), c(1e308), c(20)]), { source: c(0.9), load: c(0.9) }).points[0].transducerGain!;
    expect(value.reason).toBeNull();
    expect(value.linear!).toBeCloseTo(0.00015421419112307232, 15);
  });
  it('preserves finite gain when the bilateral feedback overflows', () => {
    const value = report(matrix([c(0), c(10), c(1e308), c(0)]), { source: c(0.9), load: c(0.9) }).points[0].transducerGain!;
    expect(value.reason).toBeNull();
    expect(value.linear!).toBeCloseTo(0.0005502210028959, 15);
  });
  it('preserves complex overflowing feedback without losing its phase', () => {
    const value = report(matrix([c(0), c(0, 10), c(1e308), c(0)]), { source: c(0.9), load: c(0.9) }).points[0].transducerGain!;
    expect(value.reason).toBeNull();
    expect(value.linear!).toBeCloseTo(0.0005502210028959, 15);
  });
  it('applies mismatch before an otherwise overflowing gain square', () => {
    const source = 1 - Number.EPSILON / 2;
    const value = report(matrix([c(0), c(0), c(1e155), c(0)]), { source: c(source), load: c(0) }).points[0].transducerGain!;
    expect(value.reason).toBeNull();
    expect(value.linear! / (1e155 * Math.sqrt(1 - source ** 2)) ** 2).toBeCloseTo(1, 12);
  });
  // Independent Python complex arithmetic using the canonical formula.
  it.each([
    { reverse: c(0), expected: 1.762234739890222 },
    { reverse: c(0.15, -0.07), expected: 1.7818177468325076 },
  ])('matches unilateral and bilateral independent oracles', ({ reverse, expected }) => {
    const value = report(matrix([c(0.2, 0.1), reverse, c(1.3, -0.4), c(-0.1, 0.3)])).points[0].transducerGain!;
    expect(value.reason).toBeNull();
    const error = Math.abs(value.linear! - expected);
    expect(error).toBeLessThan(1e-12);
  });
  it('preserves sample order and leaves omitted reports unchanged', () => {
    const raw = matrix([c(0), c(0), c(0.5), c(0)], [1000, 100, 500]);
    const baseline = sparamsReport([raw], { netlist: 'x' });
    expect(baseline.points[0]).not.toHaveProperty('transducerGain');
    expect(report(raw, matched).points.map(p => p.frequencyHz)).toEqual([1000, 100, 500]);
    expect(report(raw, matched).points.map(p => p.parameters)).toEqual(baseline.points.map(p => p.parameters));
  });
  it('rejects malformed, incomplete, nonfinite and nonpassive coefficients', () => {
    for (const t of [null, {}, { source: c(0) }, { ...matched, extra: 1 }, { source: { real: 0 }, load: c(0) }, { source: c(NaN), load: c(0) }, { source: c(Infinity), load: c(0) }, { source: c(1), load: c(0) }, { source: c(0.8, 0.6), load: c(0) }, { source: c(0), load: c(0, -1) }]) {
      expect(() => sparamsArgs({ netlist: 'x', transducerGain: t })).toThrow();
    }
  });
  it('rejects invalid port count, references and incomplete vectors', () => {
    const unequal = matrix([c(0), c(0), c(1), c(0)]); unequal.referenceImpedances[1] = 75;
    const zero = matrix([c(0), c(0), c(1), c(0)]); zero.referenceImpedances.fill(0);
    for (const raw of [unequal, zero, new SParameterResult([100], ['V1'], new Map()), matrix([c(0), c(0), c(1)])]) expect(() => report(raw)).toThrow();
  });
  it('reports singular and nonrepresentable results without nonfinite numbers', () => {
    const singular = matrix([c(2), c(0), c(1), c(0)]);
    const overflow = matrix([c(1e200), c(1e200), c(1e200), c(1e200)]);
    for (const [raw, t] of [[singular, { source: c(0.5), load: c(0) }], [overflow, terminations]] as const) {
      const value = report(raw, t).points[0].transducerGain!;
      expect(value).toMatchObject({ linear: null, reason: expect.stringContaining('nonrepresentable') });
      expect(JSON.stringify(value)).not.toMatch(/NaN|Infinity/);
    }
    expect(report(matrix([c(0), c(0), c(0), c(0)]), matched).points[0].transducerGain).toEqual({ linear: 0, reason: null });
  });
  it('validates schemas and invokes the public MCP tool', async () => {
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(sparamsInputSchema);
    expect(input({ netlist: pad, transducerGain: matched }).valid).toBe(true);
    expect(input({ netlist: pad, transducerGain: { source: c(0) } }).valid).toBe(false);
    const result = await executeTool('spice_sparams', { netlist: pad, transducerGain: matched });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(validator.getValidator(sparamsOutputSchema)(result.structuredContent).valid).toBe(true);
    const output = result.structuredContent as unknown as ReturnType<typeof sparamsReport>;
    for (const point of output.points) expect(Math.abs(point.transducerGain!.linear! - 0.25)).toBeLessThan(1e-12);
    const invalid = await executeTool('spice_sparams', { netlist: pad, transducerGain: { source: c(1), load: c(0) } });
    expect(invalid.isError).toBe(true);
  });
});
