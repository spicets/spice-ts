import { describe, expect, it } from 'vitest';
import { SParameterResult } from '@spice-ts/core';
import { sparamsArgs, sparamsReport } from './sparams.js';
import { sparamsInputSchema, sparamsOutputSchema } from './sparams.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool } from './server.js';

const matrix = (values: number[]) => new SParameterResult([100], ['V1', 'V2'], new Map(values.map((real, i) => [`S_${Math.floor(i / 2) + 1}_${i % 2 + 1}`, [{ real, imaginary: 0 }]])));
const metric = (values: number[]) => sparamsReport([matrix(values)], { netlist: 'x', includeStability: true }).points[0].stability!;
const near = (actual: number | null, expected: number) => expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expected)));
const pad = '* matched pad\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\nR1 in mid 16.666666666666668\nR2 mid out 16.666666666666668\nR3 mid 0 66.66666666666667\n.sp lin 3 100 1000 0\n.end';

describe('sampled stability', () => {
  it('reports the analytic matched attenuator', () => {
    const report = sparamsReport([matrix([0, 0.5, 0.5, 0])], sparamsArgs({ netlist: 'x', includeStability: true }));
    expect(report.points[0]).toMatchObject({ stability: { delta: { real: -0.25, imaginary: 0 }, deltaMagnitude: 0.25, rollettK: 2.125 } });
  });
  it.each([
    { values: [0.5, 1, 1, 0.5], delta: -0.75, k: 0.53125 },
    { values: [0.2, 0.1, 2, 0.3], delta: -0.14, k: 2.224 },
  ])('computes analytic matrix $values', ({ values, delta, k }) => {
    const result = metric(values);
    near(result.delta!.real, delta); near(result.delta!.imaginary, 0);
    near(result.deltaMagnitude, Math.abs(delta)); near(result.rollettK, k);
    expect(result.reason).toBeNull();
  });
  it('computes complex delta', () => {
    const raw = matrix([0, 0, 0, 0]);
    const values = [{ real: 0.2, imaginary: 0.3 }, { real: 0.1, imaginary: -0.2 }, { real: 0.4, imaginary: 0.1 }, { real: 0.3, imaginary: -0.1 }];
    [...raw.vectors.values()].forEach((vector, i) => { vector[0] = values[i]; });
    const result = sparamsReport([raw], { netlist: 'x', includeStability: true }).points[0].stability!;
    near(result.delta!.real, 0.03); near(result.delta!.imaginary, 0.14);
    near(result.deltaMagnitude, Math.hypot(0.03, 0.14));
  });
  it('reports unilateral K as undefined without a verdict', () => {
    expect(metric([0.2, 0, 2, 0.3])).toMatchObject({ rollettK: null, reason: expect.stringContaining('undefined') });
  });
  it('handles extreme finite and nonrepresentable values', () => {
    near(metric([0, 1e-150, 1e-150, 0]).rollettK, 5e299);
    const cancellation = metric([1e200, 1e200, 1e200, 1e200]);
    near(cancellation.delta!.real, 0); near(cancellation.rollettK, -1);
    expect(metric([0, 1e-200, 1e-200, 0])).toMatchObject({ rollettK: null, reason: expect.stringContaining('representable') });
    expect(metric([0, 1e200, 1e200, 0])).toMatchObject({ delta: null, rollettK: null, reason: expect.stringContaining('Delta') });
  });
  it('rejects malformed options and incompatible matrices', () => {
    try { sparamsArgs({ netlist: 'x', includeStability: 'true' }); throw new Error('accepted'); } catch (error) { expect(error).toMatchObject({ code: 'INVALID_REQUEST' }); }
    const unequal = matrix([0, 1, 1, 0]); unequal.referenceImpedances[1] = 75;
    const zero = matrix([0, 1, 1, 0]); zero.referenceImpedances.fill(0);
    for (const raw of [unequal, zero, new SParameterResult([100], ['V1'], new Map()), matrix([0, 1, 1])]) {
      try { sparamsReport([raw], { netlist: 'x', includeStability: true }); throw new Error('accepted'); } catch (error) { expect(error).toMatchObject({ code: 'INVALID_REQUEST' }); }
    }
  });
  it('preserves output for absent and false options', () => {
    const raw = matrix([0, 0.5, 0.5, 0]);
    const baseline = sparamsReport([raw], { netlist: 'x' });
    expect(sparamsReport([raw], { netlist: 'x', includeStability: false })).toEqual(baseline);
    expect(baseline.points[0]).not.toHaveProperty('stability');
  });
  it('runs a real resistive two-port and validates exported schemas', async () => {
    const validator = new AjvJsonSchemaValidator();
    expect(validator.getValidator(sparamsInputSchema)({ netlist: pad, includeStability: true }).valid).toBe(true);
    expect(validator.getValidator(sparamsInputSchema)({ netlist: pad, includeStability: 'yes' }).valid).toBe(false);
    const result = await executeTool('spice_sparams', { netlist: pad, includeStability: true });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(validator.getValidator(sparamsOutputSchema)(result.structuredContent).valid).toBe(true);
    const report = result.structuredContent as unknown as ReturnType<typeof sparamsReport>;
    for (const point of report.points) { near(point.stability!.delta!.real, -0.25); near(point.stability!.rollettK, 2.125); }
    const bad = await executeTool('spice_sparams', { netlist: pad, includeStability: 1 });
    expect(bad.structuredContent).toMatchObject({ error: { code: 'INVALID_REQUEST', phase: 'validation' } });
  });
});
