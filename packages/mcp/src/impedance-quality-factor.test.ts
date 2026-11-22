import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { impedanceArgs, impedanceQualityFactor, impedanceReport } from './impedance.js';
import { executeTool, MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const request = { apiVersion: '1', input: { format: 'spice', source: '* series RC\nR1 in mid 1k\nC1 mid 0 1u\n.ac dec 1 10 1000\n.end' } };
const args = { request, port };
const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
const validate = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;

describe('series impedance quality factor', () => {
  it('computes RC and RL Q from sampled complex impedance at known frequencies', () => {
    const frequencyHz = [1, 10, 1, 10];
    const resistance = [1, 1, 1, 1];
    const reactance = [-1, -10, 1, 10];
    const positive = resistance.map((r, i) => ({ magnitude: Math.hypot(r, reactance[i]), phaseDegrees: Math.atan2(reactance[i], r) * 180 / Math.PI }));
    const negative = frequencyHz.map(() => ({ magnitude: 0, phaseDegrees: 0 }));
    const report = impedanceReport({ frequencyHz, positive, negative }, impedanceArgs({ port, includeQualityFactor: true }));
    report.points.forEach((point, i) => expect(point.qualityFactor).toBeCloseTo([1, 10, 1, 10][i], 12));
  });

  it('exposes and validates the actual MCP input and output schemas and analytic RC result', async () => {
    expect(validate(tool.inputSchema, { ...args, includeQualityFactor: true })).toBe(true);
    expect(validate(tool.inputSchema, { ...args, includeQualityFactor: 'true' })).toBe(false);
    const response = await executeTool('spice_impedance', { ...args, includeQualityFactor: true });
    expect(response.isError).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    const report = response.structuredContent as { points: { frequencyHz: number; qualityFactor: number }[] };
    for (const point of report.points) {
      const expected = 1 / (2 * Math.PI * point.frequencyHz * 1e-6 * 1000);
      expect(Math.abs(point.qualityFactor / expected - 1)).toBeLessThanOrEqual(1e-9);
    }
    expect((await executeTool('spice_impedance', { ...args, includeQualityFactor: 'true' })).isError).toBe(true);
  });

  it('preserves omitted and false output exactly', async () => {
    const omitted = await executeTool('spice_impedance', args);
    const disabled = await executeTool('spice_impedance', { ...args, includeQualityFactor: false });
    expect(disabled.structuredContent).toEqual(omitted.structuredContent);
    expect(JSON.stringify(omitted.structuredContent)).not.toContain('qualityFactor');
  });

  it('leaves spot queries unchanged and composes with other impedance options', async () => {
    const options = { ...args, spotFrequenciesHz: [10, 50, 10000], includeAdmittance: true,
      includeSeriesEquivalent: true, includeParallelEquivalent: true, referenceResistanceOhm: 50, includeMatchingMetrics: true };
    const baseline = await executeTool('spice_impedance', options);
    const enabled = await executeTool('spice_impedance', { ...options, includeQualityFactor: true });
    expect(enabled.isError, JSON.stringify(enabled.structuredContent)).not.toBe(true);
    expect(validate(tool.outputSchema!, enabled.structuredContent)).toBe(true);
    const before = baseline.structuredContent as { spots: unknown[] };
    const after = enabled.structuredContent as { spots: unknown[]; points: { qualityFactor: number }[] };
    expect(after.spots).toEqual(before.spots);
    expect(after.points.every(p => typeof p.qualityFactor === 'number')).toBe(true);
  });

  it.each([
    [10, 0, 0], [0, 10, null], [-1, 10, null], [0, 0, null],
    [1e-200, 1e100, 1e300], [1e100, 1e-200, 1e-300], [Number.MIN_VALUE, 1, null],
  ])('handles resistance %s and reactance %s', (resistance, reactance, expected) => {
    expect(impedanceQualityFactor(resistance!, reactance!)).toBe(expected);
  });

  it('reports zero, negative and ideal lossless differential impedances as null', () => {
    const report = impedanceReport({ frequencyHz: [1, 2, 3, 4],
      positive: [{ magnitude: 1, phaseDegrees: 0 }, { magnitude: 0, phaseDegrees: 0 }, { magnitude: 1, phaseDegrees: 90 }, { magnitude: 0, phaseDegrees: 0 }],
      negative: [{ magnitude: 0, phaseDegrees: 0 }, { magnitude: 1, phaseDegrees: 0 }, { magnitude: 1, phaseDegrees: -90 }, { magnitude: 0, phaseDegrees: 0 }],
    }, impedanceArgs({ port: { positive: 'a', negative: 'b' }, includeQualityFactor: true }));
    expect(report.points.map(p => p.qualityFactor)).toEqual([0, null, null, null]);
    expect(validate(tool.outputSchema!, report)).toBe(true);
  });

  it('measures Q at a two-terminal differential port', async () => {
    const source = '* differential RC\nVbias neg 0 DC 1\nR1 in mid 1k\nC1 mid neg 1u\n.ac lin 1 100 100\n.end';
    const response = await executeTool('spice_impedance', { request: { apiVersion: '1', input: { format: 'spice', source } }, port: { positive: 'in', negative: 'neg' }, includeQualityFactor: true });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    const report = response.structuredContent as { points: { qualityFactor: number }[] };
    expect(Math.abs(report.points[0].qualityFactor * 2 * Math.PI * 100 * 1e-6 * 1000 - 1)).toBeLessThanOrEqual(1e-9);
  });
});
