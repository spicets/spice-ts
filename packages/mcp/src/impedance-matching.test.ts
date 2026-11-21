import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { impedanceArgs, impedanceReport } from './impedance.js';
import { MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const valid = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_impedance')!.outputSchema!);
function report(r: number, x: number, referenceResistanceOhm = 50, includeMatchingMetrics = true) {
  return impedanceReport({ frequencyHz: [100], positive: [{ magnitude: r - x * Math.cos(Math.PI / 2), phaseDegrees: 0 }], negative: [{ magnitude: -x, phaseDegrees: 90 }] }, { port, referenceResistanceOhm, includeMatchingMetrics, spotFrequenciesHz: [100] });
}

describe('impedance matching metrics', () => {
  it.each([100, 25])('computes analytic mismatch for %s ohms', r => {
    const result = report(r, 0);
    expect(result.points[0].returnLossDb).toBeCloseTo(20 * Math.log10(3), 12);
    expect(result.points[0].vswr).toBeCloseTo(2, 12);
    expect(valid(result).valid).toBe(true);
  });
  it('distinguishes perfect, reactive, active and singular cases', () => {
    expect(report(50, 0).points[0]).toMatchObject({ returnLossDb: null, returnLossReason: 'infinite-perfect-match', vswr: 1 });
    expect(report(0, 50).points[0]).toMatchObject({ returnLossDb: 0, vswr: null, vswrReason: 'unbounded' });
    expect(report(-25, 0).points[0]).toMatchObject({ returnLossDb: expect.closeTo(-20 * Math.log10(3), 12), vswr: null, vswrReason: 'nonpassive' });
    expect(report(-50, 0).points[0]).toMatchObject({ reflection: null, returnLossDb: null, returnLossReason: 'undefined-reflection', vswr: null, vswrReason: 'undefined-reflection' });
    for (const r of [50, 0, -25, -50]) expect(valid(report(r, r === 0 ? 50 : 0)).valid).toBe(true);
  });
  it('matches an independent complex passive analytic calculation', () => {
    const gamma = Math.sqrt((30 - 50) ** 2 + 40 ** 2) / Math.sqrt((30 + 50) ** 2 + 40 ** 2);
    const point = report(30, 40).points[0];
    expect(point.returnLossDb).toBeCloseTo(-20 * Math.log10(gamma), 12);
    expect(point.vswr).toBeCloseTo((1 + gamma) / (1 - gamma), 12);
  });
  it('is scale invariant and does not invent perfect matches for extreme values', () => {
    for (const scale of [1e-200, 1, 1e200]) {
      const point = report(100 * scale, 0, 50 * scale).points[0];
      expect(point.returnLossDb).toBeCloseTo(20 * Math.log10(3), 10);
      expect(point.vswr).toBeCloseTo(2, 10);
    }
    const tiny = report(1e308, 1e-16, 1e308).points[0];
    expect(tiny.returnLossDb).not.toBeNull();
    expect(Number.isFinite(tiny.returnLossDb)).toBe(true);
    const nearUnity = report(-1, 0, 1e20).points[0];
    expect(nearUnity.returnLossDb!).toBeLessThan(0);
    expect(nearUnity.vswrReason).toBe('nonpassive');
    const extreme = report(1e300, 0, 1e-100).points[0];
    expect(extreme.vswr).toBeNull();
    expect(extreme.vswrReason).toBe('unrepresentable');
    expect(valid(report(1e300, 0, 1e-100)).valid).toBe(true);
  });
  it('leaves the old shape and spot queries unchanged when omitted or false', () => {
    const spectrum = { frequencyHz: [100], positive: [{ magnitude: 100, phaseDegrees: 0 }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
    const legacy = impedanceReport(spectrum, { port, referenceResistanceOhm: 50, spotFrequenciesHz: [100] });
    expect(report(100, 0, 50, false)).toEqual(legacy);
    expect(report(100, 0).spots).toEqual(legacy.spots);
    expect(legacy.points[0]).not.toHaveProperty('vswr');
  });
  it.each([{ includeMatchingMetrics: true }, { includeMatchingMetrics: 'true', referenceResistanceOhm: 50 }, ...[0, -1, Infinity, NaN, null, '50'].map(referenceResistanceOhm => ({ includeMatchingMetrics: true, referenceResistanceOhm }))])('rejects invalid arguments %#', input => {
    expect(() => impedanceArgs({ port, ...input })).toThrow();
  });
});
