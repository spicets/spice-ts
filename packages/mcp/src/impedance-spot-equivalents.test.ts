import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { impedanceReport, type ImpedanceSpectrum } from './impedance.js';

const port = { positive: 'in', negative: '0' };

describe('spot equivalents', () => {
  it('derives series and parallel components from interpolated impedance at the requested frequency', () => {
    const spectrum: ImpedanceSpectrum = { frequencyHz: [10, 100], positive: [{ magnitude: 10, phaseDegrees: -90 }, { magnitude: 20, phaseDegrees: -90 }], negative: [{ magnitude: 0, phaseDegrees: 0 }, { magnitude: 0, phaseDegrees: 0 }] };
    const report = impedanceReport(spectrum, { port, sweep: { type: 'ac', variation: 'lin', points: 2, startFreq: 10, stopFreq: 100 }, spotFrequenciesHz: [55], includeSeriesEquivalent: true, includeParallelEquivalent: true });
    const spot = report.spots![0] as Record<string, unknown>;
    expect(spot.seriesCapacitanceF as number).toBeCloseTo(1 / (2 * Math.PI * 55 * 15), 12);
    expect(spot.parallelCapacitanceF as number).toBeCloseTo(1 / (2 * Math.PI * 55 * 15), 12);
  });
  it.each(['lin', 'dec'] as const)('preserves grid values, interpolates complex impedance and order on %s spectra', variation => {
    for (const phase of [-90, 90, 0]) for (const [series, parallel] of [[true, false], [false, true], [true, true]] as const) {
      const spectrum: ImpedanceSpectrum = { frequencyHz: [10, 100], positive: [{ magnitude: 10, phaseDegrees: phase }, { magnitude: 20, phaseDegrees: phase }], negative: [{ magnitude: 0, phaseDegrees: 0 }, { magnitude: 0, phaseDegrees: 0 }] };
      const f = variation === 'lin' ? 55 : Math.sqrt(1000);
      const selectors = { port, sweep: { type: 'ac' as const, variation, points: 2, startFreq: 10, stopFreq: 100 }, spotFrequenciesHz: [100, f, 10, f, 1, 1000] };
      const legacy = impedanceReport(spectrum, selectors);
      expect(JSON.stringify(impedanceReport(spectrum, { ...selectors, includeSeriesEquivalent: false, includeParallelEquivalent: false }).spots)).toBe(JSON.stringify(legacy.spots));
      const result = impedanceReport(spectrum, { ...selectors, includeSeriesEquivalent: series, includeParallelEquivalent: parallel });
      const spots = result.spots! as Record<string, any>[];
      for (const [si, pi] of [[0, 1], [2, 0]]) for (const key of ['seriesCapacitanceF', 'seriesInductanceH', 'parallelCapacitanceF', 'parallelInductanceH', 'seriesEquivalentReason', 'parallelEquivalentReason']) {
        expect(spots[si][key]).toEqual((result.points[pi] as Record<string, unknown>)[key]);
      }
      expect(spots[1]).toEqual(spots[3]);
      expect(spots.slice(4)).toEqual(legacy.spots!.slice(4));
      const { resistanceOhm: r, reactanceOhm: x } = spots[1];
      if (series) {
        expect(spots[1].seriesCapacitanceF).toEqual(phase < 0 ? expect.closeTo(1 / (2 * Math.PI * f * -x), 12) : null);
        expect(spots[1].seriesInductanceH).toEqual(phase > 0 ? expect.closeTo(x / (2 * Math.PI * f), 12) : null);
      } else expect(spots[1]).not.toHaveProperty('seriesCapacitanceF');
      if (parallel) {
        const b = -x / (r * r + x * x);
        expect(spots[1].parallelCapacitanceF).toEqual(phase < 0 ? expect.closeTo(b / (2 * Math.PI * f), 12) : null);
        expect(spots[1].parallelInductanceH).toEqual(phase > 0 ? expect.closeTo(-1 / (b * 2 * Math.PI * f), 12) : null);
      } else expect(spots[1]).not.toHaveProperty('parallelCapacitanceF');
    }
  });

  it('retains zero and extreme representability reasons at exact spots', () => {
    for (const [magnitude, phase, reason] of [[0, 0, 'zero_impedance'], [1e-310, -90, 'unrepresentable']] as const) {
      const spectrum: ImpedanceSpectrum = { frequencyHz: [1], positive: [{ magnitude, phaseDegrees: phase }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
      const result = impedanceReport(spectrum, { port, spotFrequenciesHz: [1], includeParallelEquivalent: true, includeSeriesEquivalent: true });
      expect(result.spots![0]).toMatchObject({ parallelCapacitanceF: null, parallelInductanceH: null, parallelEquivalentReason: reason });
      if (magnitude) expect(result.spots![0]).toMatchObject({ seriesEquivalentReason: 'unrepresentable' });
      expect(() => impedanceReport(spectrum, { port, spotFrequenciesHz: [1], includeAdmittance: true, includeParallelEquivalent: true })).toThrow();
    }
    const spectrum: ImpedanceSpectrum = { frequencyHz: [1], positive: [{ magnitude: 1e308, phaseDegrees: 90 }], negative: [{ magnitude: 0, phaseDegrees: 0 }] };
    const report = impedanceReport(spectrum, { port, spotFrequenciesHz: [1], includeParallelEquivalent: true, includeSeriesEquivalent: true });
    const point = report.points[0] as Record<string, unknown>;
    expect(report.spots![0]).toMatchObject({ parallelInductanceH: point.parallelInductanceH, seriesInductanceH: point.seriesInductanceH });
  });

  it('validates a real RLC tool response and its interpolated spot', async () => {
    const request = { apiVersion: '1', input: { format: 'spice', source: 'R1 in mid 10\nL1 mid out 10m\nC1 out 0 1u\nRleak out 0 1g\n.ac lin 3 100 10000' } };
    const response = await executeTool('spice_impedance', { request, port, spotFrequenciesHz: [100, 200], includeSeriesEquivalent: true, includeParallelEquivalent: true });
    expect(response.isError).not.toBe(true);
    const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    const report = response.structuredContent as unknown as { points: Record<string, any>[]; spots: Record<string, any>[] };
    expect(report.spots[0].seriesCapacitanceF).toBe(report.points[0].seriesCapacitanceF);
    const spot = report.spots[1];
    expect(spot.seriesCapacitanceF).toBeCloseTo(-1 / (2 * Math.PI * 200 * spot.reactanceOhm), 12);
  });
});
