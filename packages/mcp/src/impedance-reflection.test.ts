import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { impedanceReport } from './impedance.js';
import { executeTool, MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
const validator = new AjvJsonSchemaValidator();
const validInput = validator.getValidator(tool.inputSchema);
const validOutput = validator.getValidator(tool.outputSchema!);
const args = (source: string) => ({ request: { apiVersion: '1', input: { format: 'spice', source } }, port });
const resistor = args('R1 in 0 50\n.ac lin 1 100 100');

function report(r: number, x: number, referenceResistanceOhm?: number) {
  return impedanceReport({ frequencyHz: [100], positive: [{ magnitude: r, phaseDegrees: 0 }], negative: [{ magnitude: -x, phaseDegrees: 90 }] }, { port, referenceResistanceOhm });
}
function oracle(r: number, x: number, r0: number) {
  const denominator = (r + r0) ** 2 + x ** 2;
  const real = (r * r - r0 * r0 + x * x) / denominator;
  const imaginary = 2 * r0 * x / denominator;
  return { real, imaginary, magnitude: Math.hypot(real, imaginary) };
}
function close(actual: number, expected: number, tolerance = 1e-12) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(expected)));
}

describe('impedance reflection', () => {
  it.each([[50, 0, 0, 0], [100, 0, 1 / 3, 0], [0, 0, -1, 0], [0, 50, 0, 1]])('computes canonical impedance (%s, %s)', (r, x, real, imaginary) => {
    const result = report(r, x, 50);
    const reflection = result.points[0].reflection!;
    close(reflection.real, real); close(reflection.imaginary, imaginary); close(reflection.magnitude, Math.hypot(real, imaginary));
    expect(result.points[0]).not.toHaveProperty('reflectionReason');
    expect(validOutput(result).valid).toBe(true);
  });
  it.each([[30, 40], [-25, 20], [80, -75], [-100, 0]])('matches independent complex division at (%s, %s)', (r, x) => {
    const point = report(r, x, 50).points[0];
    const expected = oracle(point.resistanceOhm, point.reactanceOhm, 50);
    close(point.reflection!.real, expected.real); close(point.reflection!.imaginary, expected.imaginary); close(point.reflection!.magnitude, expected.magnitude);
    if (r < 0) expect(point.reflection!.magnitude).toBeGreaterThan(1);
  });
  it('handles singular and unrepresentable results', () => {
    const singular = report(-50, 0, 50);
    expect(singular.points[0]).toMatchObject({ reflection: null, reflectionReason: 'zero-denominator' });
    expect(validOutput(singular).valid).toBe(true);
    const huge = report(-1e308, 1e-10, 1e308);
    expect(huge.points[0]).toMatchObject({ reflection: null, reflectionReason: 'unrepresentable' });
    expect(validOutput(huge).valid).toBe(true);
  });
  it.each([[1e308, 0, 1e308, 0], [1e-300, 0, 2e-300, -1 / 3], [1e308, 0, 5e307, 1 / 3], [1, 0, 1 + 1e-12, -4.999889391396893e-13]])('handles finite scale (%s, %s, %s)', (r, x, r0, expected) => {
    const reflection = report(r, x, r0).points[0].reflection!;
    close(reflection.real, expected, 1e-15);
    if (expected !== 0) expect(reflection.real).not.toBe(0);
  });
  it('preserves tiny representable imaginary coefficients', () => {
    const a = report(1, 1e-200, 1).points[0].reflection!;
    expect(a.imaginary / 5e-201).toBeCloseTo(1, 12);
    const b = report(0, 2, Number.MIN_VALUE).points[0].reflection!;
    expect(b.imaginary).toBe(Number.MIN_VALUE);
  });
  it('advertises null and reason as a pair', () => {
    const base = report(50, 0, 50);
    const point = base.points[0];
    expect(validOutput({ ...base, points: [{ ...point, reflectionReason: 'unrepresentable' }] }).valid).toBe(false);
    expect(validOutput({ ...base, points: [{ ...point, reflection: null }] }).valid).toBe(false);
    expect(validOutput({ ...base, points: [{ ...point, reflection: { real: Infinity, imaginary: 0, magnitude: Infinity } }] }).valid).toBe(false);
  });
  it('omits all reflection data by default and leaves spot queries unchanged', () => {
    const spectrum = { frequencyHz: [100], positive: [{ magnitude: 100, phaseDegrees: 0 }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
    const legacy = impedanceReport(spectrum, { port, spotFrequenciesHz: [100] });
    const withReflection = impedanceReport(spectrum, { port, spotFrequenciesHz: [100], referenceResistanceOhm: 50 });
    expect(legacy.points[0]).not.toHaveProperty('reflection');
    expect(legacy.points[0]).not.toHaveProperty('reflectionReason');
    expect(withReflection.spots).toEqual(legacy.spots);
    const { reflection: _reflection, ...rest } = withReflection.points[0];
    expect(rest).toEqual(legacy.points[0]);
  });
  it.each([0, -1, Infinity, -Infinity, NaN, '50', null, {}, []])('rejects invalid reference %s', async value => {
    const input = { ...resistor, referenceResistanceOhm: value };
    expect(validInput(input).valid).toBe(false);
    const response = await executeTool('spice_impedance', input);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
  it.each([
    ['R1 in 0 50\n.ac lin 1 100 100', 50, 0],
    ['R1 in mid 100\nC1 mid 0 1u\n.ac lin 1 100 100', 100, -1 / (2 * Math.PI * 100 * 1e-6)],
  ])('exercises real MCP port analysis', async (source, r, x) => {
    const input = { ...args(source), referenceResistanceOhm: 50 };
    expect(validInput(input).valid).toBe(true);
    const response = await executeTool('spice_impedance', input);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validOutput(response.structuredContent).valid).toBe(true);
    const point = (response.structuredContent as unknown as { points: { reflection: { real: number; imaginary: number; magnitude: number } }[] }).points[0];
    const expected = oracle(r, x, 50);
    close(point.reflection.real, expected.real, 1e-6); close(point.reflection.imaginary, expected.imaginary, 1e-6); close(point.reflection.magnitude, expected.magnitude, 1e-6);
  });
});
