import { describe, expect, it } from 'vitest';
import { executeTool, MCP_TOOLS } from './server.js';
import { acMetrics, acMetricsArgs } from './ac-metrics.js';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

function sweep(frequencyHz: number[], magnitudes: number[]): SimulationResultV1 {
  return { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz, currentPhasors: {}, voltagePhasors: {
    out: magnitudes.map(magnitude => ({ magnitude, phaseDegrees: 0 })),
  } }] };
}

describe('AC bandpass metrics', () => {
  it('matches the analytic series RLC half-power frequencies and Q', async () => {
    const source = '* series RLC bandpass\nV1 in 0 AC 1\nL1 in n 10m\nC1 n out 1u\nR1 out 0 100\n.ac dec 300 100 100k\n.end';
    const response = await executeTool('spice_ac_metrics', {
      request: { apiVersion: '1', input: { format: 'spice', source } }, output: 'out', input: 'in', includeBandpass: true,
    });
    expect(response.isError).not.toBe(true);
    const band = (response.structuredContent as { bandpass: Record<string, number> }).bandpass;
    const L = 0.01, C = 1e-6, R = 100;
    const root = Math.sqrt((R / L) ** 2 + 4 / (L * C));
    const expected = { peakFrequencyHz: 1 / (2 * Math.PI * Math.sqrt(L * C)), lowerHalfPowerHz: (root - R / L) / (4 * Math.PI), upperHalfPowerHz: (root + R / L) / (4 * Math.PI), qualityFactor: Math.sqrt(L / C) / R };
    for (const [key, value] of Object.entries(expected)) expect(Math.abs(band[key] / value - 1), key).toBeLessThan(0.01);
  });

  it('uses the nearest crossings of the global peak on an irregular grid', () => {
    const result = sweep([1, 4, 10, 40, 100, 900, 10000], [0.1, 0.9, 0.5, 1, 0.5, 0.9, 0.1]);
    const band = acMetrics(result, { output: 'out', includeBandpass: true }).bandpass!;
    // 0.5 is -6.0206 dB, so the -3.0103 dB crossing is halfway in log Hz.
    expect(band.lowerHalfPowerHz).toBeCloseTo(20, 10);
    expect(band.upperHalfPowerHz).toBeCloseTo(Math.sqrt(4000), 10);
    expect(band.peakFrequencyHz).toBe(40);
    expect(band.bandwidthHz).toBeCloseTo(Math.sqrt(4000) - 20, 10);
    expect(band.qualityFactor).toBeCloseTo(40 / (Math.sqrt(4000) - 20), 10);
    expect(band.reasons).toEqual({});
  });

  it('reports missing crossings and chooses the first point of a peak plateau', () => {
    const flat = acMetrics(sweep([1, 2, 4, 8], [1, 1, 1, 1]), { output: 'out', includeBandpass: true }).bandpass!;
    expect(flat).toMatchObject({ peakFrequencyHz: 1, lowerHalfPowerHz: null, upperHalfPowerHz: null, bandwidthHz: null, qualityFactor: null, reasons: { lowerHalfPowerHz: 'NO_LOWER_HALF_POWER_CROSSING', upperHalfPowerHz: 'NO_UPPER_HALF_POWER_CROSSING' } });
    const rising = acMetrics(sweep([1, 2, 4], [0.1, 0.5, 1]), { output: 'out', includeBandpass: true }).bandpass!;
    expect(rising.lowerHalfPowerHz).not.toBeNull();
    expect(rising).toMatchObject({ upperHalfPowerHz: null, bandwidthHz: null, qualityFactor: null, reasons: { upperHalfPowerHz: 'NO_UPPER_HALF_POWER_CROSSING', bandwidthHz: 'NO_UPPER_HALF_POWER_CROSSING', qualityFactor: 'NO_UPPER_HALF_POWER_CROSSING' } });
    const falling = acMetrics(sweep([1, 2, 4], [1, 0.5, 0.1]), { output: 'out', includeBandpass: true }).bandpass!;
    expect(falling.upperHalfPowerHz).not.toBeNull();
    expect(falling.reasons.bandwidthHz).toBe('NO_LOWER_HALF_POWER_CROSSING');
    const plateau = acMetrics(sweep([1, 2, 4, 8], [0.5, 1, 1, 0.5]), { output: 'out', includeBandpass: true }).bandpass!;
    expect(plateau.peakFrequencyHz).toBe(2);
    expect(plateau.upperHalfPowerHz).toBeCloseTo(Math.sqrt(32), 10);
  });

  it('preserves the old response unless opted in and validates schemas', async () => {
    const result = sweep([1, 10, 100], [0.5, 1, 0.5]);
    expect(acMetrics(result, { output: 'out' })).toEqual(acMetrics(result, { output: 'out', includeBandpass: false }));
    expect(() => acMetricsArgs({ output: 'out', includeBandpass: 'true' })).toThrow();
    const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const args = { request: { apiVersion: '1', input: { format: 'spice', source: '* test\nV1 out 0 AC 1\n.ac dec 10 1 100\n.end' } }, output: 'out', includeBandpass: true };
    expect(input(args).valid).toBe(true);
    expect(input({ ...args, includeBandpass: 'true' }).valid).toBe(false);
    const response = await executeTool('spice_ac_metrics', args);
    expect(response.isError).not.toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    expect(output({ ...response.structuredContent, bandpass: { ...((response.structuredContent as { bandpass: object }).bandpass), qualityFactor: 'bad' } }).valid).toBe(false);
  });

  it('combines differential selectors, stepped selection and group delay', async () => {
    const source = '* stepped series RLC\nV1 in 0 AC 1\nL1 in n 10m\nC1 n out 1u\nR1 out 0 100\n.ac dec 100 100 100k\n.step param R1 list 100 200\n.end';
    const request = { apiVersion: '1', input: { format: 'spice', source } };
    for (const step of [0, 1]) {
      const args = { request, output: 'out', input: 'in', step, groupDelayAtHz: 1000, includeBandpass: true };
      const direct = await executeTool('spice_ac_metrics', args);
      const differential = await executeTool('spice_ac_metrics', { ...args, output: 'v(out,0)', input: 'v(in,0)' });
      expect(direct.isError).not.toBe(true);
      expect(differential.structuredContent).toEqual(direct.structuredContent);
      expect(direct.structuredContent).toHaveProperty('bandpass.qualityFactor');
      expect(direct.structuredContent).toHaveProperty('groupDelaySeconds');
    }
  });

  it('handles zero, non-finite and overflowed gains without non-finite output', () => {
    for (const magnitudes of [[0, 0, 0], [1e308, 1e308, 1e308]]) {
      const result = sweep([1, 2, 4], magnitudes);
      if (magnitudes[0] > 1) {
        const analysis = result.analyses[0];
        if (analysis.type !== 'ac') throw new Error('expected AC');
        analysis.voltagePhasors.in = magnitudes.map(() => ({ magnitude: 1e-308, phaseDegrees: 0 }));
      }
      const band = acMetrics(result, { output: 'out', ...(magnitudes[0] > 1 ? { input: 'in' } : {}), includeBandpass: true }).bandpass!;
      expect(band).toMatchObject({ peakFrequencyHz: null, bandwidthHz: null, qualityFactor: null, reasons: { peakFrequencyHz: 'NON_FINITE_GAIN' } });
    }
    expect(() => acMetrics(sweep([1], [NaN]), { output: 'out', includeBandpass: true })).toThrow();
  });
});
