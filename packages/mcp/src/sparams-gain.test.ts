import { describe, expect, it } from 'vitest';
import { SParameterResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool } from './server.js';
import { sparamsArgs, sparamsInputSchema, sparamsOutputSchema, sparamsReport } from './sparams.js';

const matrix = (values: number[]) => new SParameterResult([100], ['V1', 'V2'], new Map(values.map((real, i) => [`S_${Math.floor(i / 2) + 1}_${i % 2 + 1}`, [{ real, imaginary: 0 }]])));
const gain = (values: number[]) => sparamsReport([matrix(values)], { netlist: 'x', includeGain: true }).points[0].gain!;
const pad = '* matched pad\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\nR1 in mid 16.666666666666668\nR2 mid out 16.666666666666668\nR3 mid 0 66.66666666666667\n.sp lin 3 100 1000 0\n.end';

describe('sampled two-port gain', () => {
  it.each([
    { values: [0, 0.5, 0.5, 0], expected: 0.25, kind: 'MAG' },
    { values: [0.2, 0.1, 2, 0.3], expected: 20 / (2.224 + Math.sqrt(2.224 ** 2 - 1)), kind: 'MAG' },
    { values: [0.5, 1, 1, 0.5], expected: 1, kind: 'MSG' },
    { values: [0, 1e-150, 1e-150, 0], expected: 1e-300, kind: 'MAG' },
    { values: [1e200, 1e200, 1e200, 1e200], expected: 1, kind: 'MSG' },
  ])('matches independent analytic $kind for $values', ({ values, expected, kind }) => {
    const result = gain(values);
    expect(result.kind).toBe(kind);
    expect(Math.abs(result.linear! / expected - 1)).toBeLessThan(1e-10);
    expect(Math.abs(result.db! - 10 * Math.log10(expected))).toBeLessThan(1e-10);
    if (kind === 'MSG') expect(result.reason).toContain('Potentially unstable');
    else expect(result.reason).toBeNull();
  });
  it.each([
    { values: [0, 1, 1, 0], reason: 'boundary' },
    { values: [0.6, 0.4, 0.4, 0.6], reason: 'boundary' },
    { values: [0, 2, 2, 0], reason: 'Delta' },
    { values: [0.2, 0, 2, 0.3], reason: 'undefined' },
    { values: [1, 1e-10, 1e-10, 1], reason: 'reliably' },
    { values: [0, 1e-200, 1e-200, 0], reason: 'representable' },
  ])('returns an explicit reason for undefined $values', ({ values, reason }) => {
    const result = gain(values);
    expect(result).toMatchObject({ kind: null, linear: null, db: null, reason: expect.stringContaining(reason) });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
  it('classifies samples clearly on either side of the stability boundary', () => {
    expect(gain([0.6, 0.4 - 1e-8, 0.4 - 1e-8, 0.6]).kind).toBe('MAG');
    expect(gain([0.6, 0.4 + 1e-8, 0.4 + 1e-8, 0.6]).kind).toBe('MSG');
  });
  it('rejects invalid options and incompatible references and vectors', () => {
    expect(() => sparamsArgs({ netlist: 'x', includeGain: 'true' })).toThrow();
    const invalid = [matrix([0, 1, 1, 0]), matrix([0, 1, 1, 0]), new SParameterResult([100], ['V1'], new Map()), matrix([0, 1, 1])];
    invalid[0].referenceImpedances[1] = 75;
    invalid[1].referenceImpedances.fill(0);
    for (const raw of invalid) expect(() => sparamsReport([raw], { netlist: 'x', includeGain: true })).toThrow();
  });
  it('leaves the response unchanged when omitted or false and composes with stability', () => {
    const raw = matrix([0, 0.5, 0.5, 0]);
    const baseline = sparamsReport([raw], { netlist: 'x' });
    expect(sparamsReport([raw], { netlist: 'x', includeGain: false })).toEqual(baseline);
    expect(baseline.points[0]).not.toHaveProperty('gain');
    const point = sparamsReport([raw], { netlist: 'x', includeStability: true, includeGain: true }).points[0];
    expect(point.stability!.rollettK).toBe(2.125);
    expect(point.gain!.linear).toBe(0.25);
  });
  it('runs a real resistive two-port through the tool and validates schemas', async () => {
    const validator = new AjvJsonSchemaValidator();
    expect(validator.getValidator(sparamsInputSchema)({ netlist: pad, includeGain: true }).valid).toBe(true);
    expect(validator.getValidator(sparamsInputSchema)({ netlist: pad, includeGain: 'yes' }).valid).toBe(false);
    const result = await executeTool('spice_sparams', { netlist: pad, includeStability: true, includeGain: true });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(validator.getValidator(sparamsOutputSchema)(result.structuredContent).valid).toBe(true);
    const report = result.structuredContent as unknown as ReturnType<typeof sparamsReport>;
    for (const point of report.points) expect(Math.abs(point.gain!.linear! / 0.25 - 1)).toBeLessThan(1e-10);
  });
});
