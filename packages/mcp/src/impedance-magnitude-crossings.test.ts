import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { impedanceArgs, impedanceReport } from './impedance.js';
import { executeTool, MCP_TOOLS } from './server.js';

const port = { positive: 'in', negative: '0' };
const spectrum = (frequencyHz: number[], magnitudes: number[]) => ({ frequencyHz, positive: magnitudes.map(magnitude => ({ magnitude, phaseDegrees: 0 })), negative: magnitudes.map(() => ({ magnitude: 0, phaseDegrees: 0 })) });
const run = (frequencies: number[], magnitudes: number[], levels: number[], variation: 'lin' | 'dec' | 'oct' = 'lin') => impedanceReport(spectrum(frequencies, magnitudes), impedanceArgs({ port, sweep: { variation, points: 2, startFreq: 1, stopFreq: 100 }, magnitudeLevelsOhm: levels }));

describe('sampled magnitude crossings', () => {
  it('reports first linear crossings, endpoints, missing levels, and duplicates', () => {
    expect(run([10, 20, 30, 40], [1, 5, 1, 5], [3, 4, 3, 6, 1, 5]).magnitudeCrossings).toEqual([
      { magnitudeOhm: 3, frequencyHz: 15 }, { magnitudeOhm: 4, frequencyHz: 17.5 }, { magnitudeOhm: 3, frequencyHz: 15 },
      { magnitudeOhm: 6, frequencyHz: null }, { magnitudeOhm: 1, frequencyHz: 10 }, { magnitudeOhm: 5, frequencyHz: 20 },
    ]);
  });

  it.each(['lin', 'dec', 'oct'] as const)('interpolates rising and falling levels in the %s coordinate', variation => {
    const expected = variation === 'lin' ? 32.5 : 10 * 10 ** 0.25;
    for (const magnitudes of [[1, 5], [5, 1]]) {
      const level = magnitudes[0] === 1 ? 2 : 4;
      const actual = run([10, 100], magnitudes, [level], variation).magnitudeCrossings![0].frequencyHz!;
      expect(Math.abs(actual / expected - 1)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('preserves a representable frequency contribution when the fraction underflows', () => {
    const crossing = run([1e-300, 1e300], [1e-300, 1e300], [2e-300]).magnitudeCrossings![0].frequencyHz!;
    expect(Math.abs(crossing / 2e-300 - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('preserves precision when the interpolation fraction is nonzero subnormal', () => {
    // Analytic linear interpolation: 1e-30 + (8e-224 - 1e-224) * 1e300 / 1e100.
    const crossing = run([1e-30, 1e300], [1e-224, 1e100], [8e-224]).magnitudeCrossings![0].frequencyHz!;
    expect(Math.abs(crossing / 7.000001e-24 - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('handles later exact hits, plateaus, single samples, and huge positive magnitudes', () => {
    expect(run([10, 20, 30], [2, 2, 4], [2, 4, 3]).magnitudeCrossings).toEqual([
      { magnitudeOhm: 2, frequencyHz: 10 }, { magnitudeOhm: 4, frequencyHz: 30 }, { magnitudeOhm: 3, frequencyHz: 25 },
    ]);
    expect(run([10], [2], [2, 1]).magnitudeCrossings).toEqual([{ magnitudeOhm: 2, frequencyHz: 10 }, { magnitudeOhm: 1, frequencyHz: null }]);
    const crossing = run([1e-300, 1e300], [1e307, 1.7e308], [9e307]).magnitudeCrossings![0].frequencyHz!;
    expect(Math.abs(crossing / 5e299 - 1)).toBeLessThanOrEqual(1e-12);
  });

  const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
  const rc = request('* series RC\nR1 in a 100\nC1 a 0 1u\n.ac lin 11 100 1100\n.end');
  const rlc = request('* series RLC\nR1 in a 10\nL1 a b 10m\nC1 b 0 1u\nRleak b 0 1g\n.ac dec 10 100 10000\n.end');
  const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
  const validate = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;

  it.each([null, [], [NaN], [Infinity], [-Infinity], [0], [-1], ['1'], new Array(129).fill(1), '1', {}])('rejects malformed levels %s with structured errors', async levels => {
    const response = await executeTool('spice_impedance', { request: rc, port, magnitudeLevelsOhm: levels });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } } });
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
  });

  it('accepts the maximum 128 levels in input order', async () => {
    const levels = new Array(128).fill(180);
    const response = await executeTool('spice_impedance', { request: rc, port, magnitudeLevelsOhm: levels });
    expect(response.isError).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    expect((response.structuredContent as { magnitudeCrossings: unknown[] }).magnitudeCrossings).toHaveLength(128);
  });

  it.each([{ name: 'RC', fixture: rc, level: 180, logarithmic: false }, { name: 'RLC', fixture: rlc, level: 30, logarithmic: true }])('matches independent $name sampled interpolation through the tool', async ({ name, fixture, level, logarithmic }) => {
    const args = { request: fixture, port, magnitudeLevelsOhm: [level, level] };
    expect(validate(tool.inputSchema, args)).toBe(true);
    expect(validate(tool.inputSchema, { ...args, magnitudeLevelsOhm: [] })).toBe(false);
    const response = await executeTool('spice_impedance', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(validate(tool.outputSchema!, response.structuredContent)).toBe(true);
    const report = response.structuredContent as { points: { frequencyHz: number; magnitudeOhm: number }[]; magnitudeCrossings: { magnitudeOhm: number; frequencyHz: number }[] };
    // Independent circuit equations: series R-C, or series R-L with C || Rleak.
    const analytic = (frequency: number) => {
      const omega = 2 * Math.PI * frequency;
      if (!logarithmic) return Math.hypot(100, -1 / (omega * 1e-6));
      const g = 1e-9; const susceptance = omega * 1e-6;
      const denominator = g * g + susceptance * susceptance;
      return Math.hypot(10 + g / denominator, omega * 0.01 - susceptance / denominator);
    };
    const reference = report.points.map((point, index) => {
      const frequencyHz = logarithmic ? 100 * 10 ** (index / 10) : 100 + 100 * index;
      const magnitudeOhm = analytic(frequencyHz);
      expect(Math.abs(point.frequencyHz / frequencyHz - 1)).toBeLessThanOrEqual(1e-10);
      expect(Math.abs(point.magnitudeOhm / magnitudeOhm - 1)).toBeLessThanOrEqual(1e-10);
      return { frequencyHz, magnitudeOhm };
    });
    const i = reference.findIndex((p, j) => j > 0 && (p.magnitudeOhm - level) * (reference[j - 1].magnitudeOhm - level) < 0);
    expect(i).toBeGreaterThan(0);
    const a = reference[i - 1]; const b = reference[i];
    const t = (level - a.magnitudeOhm) / (b.magnitudeOhm - a.magnitudeOhm);
    const expected = logarithmic ? a.frequencyHz * (b.frequencyHz / a.frequencyHz) ** t : a.frequencyHz + (b.frequencyHz - a.frequencyHz) * t;
    const error = Math.abs(report.magnitudeCrossings[0].frequencyHz / expected - 1);
    console.log(`${name} bracket ${a.frequencyHz}..${b.frequencyHz} Hz; expected ${expected} Hz; relative error ${error}`);
    expect(error).toBeLessThanOrEqual(1e-10);
    expect(report.magnitudeCrossings[1]).toEqual(report.magnitudeCrossings[0]);
  });

  it('preserves all existing output when the option is omitted', async () => {
    const args = { request: rlc, port, reactanceLevelsOhm: [0], includeQualityFactor: true, includeAdmittance: true, spotFrequenciesHz: [200] };
    const baseline = await executeTool('spice_impedance', args);
    const enabled = await executeTool('spice_impedance', { ...args, magnitudeLevelsOhm: [30] });
    expect(baseline.isError).not.toBe(true);
    expect(enabled.isError).not.toBe(true);
    expect(baseline.structuredContent).not.toHaveProperty('magnitudeCrossings');
    const { magnitudeCrossings, ...rest } = enabled.structuredContent as Record<string, unknown>;
    expect(magnitudeCrossings).toBeDefined();
    expect(rest).toEqual(baseline.structuredContent);
  });
});
