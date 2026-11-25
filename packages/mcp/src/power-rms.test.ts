import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const netlist = 'V1 in 0 10\nR1 in 0 1k\n.tran 10u 1m';

function waveform(times: number[], voltage: number[], current: number[], window?: [number, number], windows?: [number, number][]) {
  const plan = powerPlan({ netlist, elements: ['V1'], includePowerRms: true, includePowerFactor: true, window, windows });
  if ('error' in plan) throw new Error('Expected transient plan');
  return powerMetrics({ status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0,
    timeS: times, voltagesV: { in: voltage }, currentsA: { V1: current } }] }, plan);
}

describe('instantaneous power RMS', () => {
  it('accepts the public opt-in and reports constant power RMS', async () => {
    const response = await executeTool('spice_power_metrics', { netlist, elements: ['R1'], includePowerRms: true });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect((response.structuredContent as { elements: { rmsPowerW: number }[] }).elements[0].rmsPowerW).toBeCloseTo(0.1, 10);
  });

  it('integrates linear ramps and the interior maximum of quadratic power', () => {
    const ramp = waveform([0, 1], [0, 1], [0, 1]).elements[0];
    expect(ramp.rmsPowerW).toBeCloseTo(Math.sqrt(1 / 5), 14);
    expect(ramp.apparentPowerVA).toBeCloseTo(1 / 3, 14);
    expect(ramp.rmsPowerW).not.toBeCloseTo(ramp.apparentPowerVA!, 4);
    const vertex = waveform([0, 1], [0, 1], [1, 0]).elements[0];
    // Integral of t²(1-t)² is 1/30.
    expect(vertex.rmsPowerW).toBeCloseTo(Math.sqrt(1 / 30), 14);
    expect(vertex.peakPowerW).toBeCloseTo(0.25, 14);
  });

  it('reports nonzero RMS for zero-mean bidirectional power and zero for a zero trace', () => {
    const result = waveform([0, 1], [1, 1], [-1, 1]).elements[0];
    expect(result.averagePowerW).toBeCloseTo(0, 14);
    expect(result.rmsPowerW).toBeCloseTo(Math.sqrt(1 / 3), 14);
    expect(waveform([0, 1], [0, 0], [1, 1]).elements[0].rmsPowerW).toBe(0);
  });

  it('preserves clipped nonuniform and multiple windows under collinear refinement', () => {
    const times = [0, 0.125, 0.625, 1];
    const windows: [number, number][] = [[0.25, 0.75], [0.5, 1]];
    const measure = (t: number[]) => waveform(t, t, t.map(x => 1 - x), [0.25, 0.75], windows);
    const report = measure(times);
    const refined = measure([0, 0.125, 0.5, 0.625, 1]);
    // Integral of (t(1-t))² is t³/3 - t⁴/2 + t⁵/5.
    const integral = (t: number) => t ** 3 / 3 - t ** 4 / 2 + t ** 5 / 5;
    for (const [index, [a, b]] of windows.entries()) {
      const expected = Math.sqrt((integral(b) - integral(a)) / (b - a));
      expect(report.windowResults![index].elements[0].rmsPowerW).toBeCloseTo(expected, 14);
      expect(refined.windowResults![index].elements[0].rmsPowerW).toBeCloseTo(expected, 14);
    }
    expect(report.elements[0].rmsPowerW).toBeCloseTo(report.windowResults![0].elements[0].rmsPowerW!, 14);
  });

  it.each([[1e150, 1e-150], [1e-150, 1e150], [1e200, 1e200]])('returns finite values or a structured error at scales %s and %s', (v, i) => {
    try {
      const rms = waveform([0, 1], [v, v], [i, i]).elements[0].rmsPowerW!;
      expect(Number.isFinite(rms)).toBe(true);
      if (v * i === 1) expect(rms).toBeCloseTo(1, 12);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_REQUEST', message: 'Non-finite power metrics' });
    }
  });

  it('enforces request resource limits with RMS enabled', async () => {
    const request = { apiVersion: '1', input: { format: 'spice', source: netlist }, options: { limits: { maxSourceBytes: 10 } } };
    expect(await executeTool('spice_power_metrics', { request, includePowerRms: true })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('preserves the default byte-for-byte, validates schemas and selects elements', async () => {
    const args = { netlist, elements: ['R1'], windows: [[0, 0.0005]] };
    const tool = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const omitted = await executeTool(tool.name, args);
    const disabled = await executeTool(tool.name, { ...args, includePowerRms: false });
    const enabled = await executeTool(tool.name, { ...args, includePowerRms: true });
    expect(JSON.stringify(disabled.structuredContent)).toBe(JSON.stringify(omitted.structuredContent));
    expect(input({ ...args, includePowerRms: true }).valid).toBe(true);
    expect(input({ ...args, includePowerRms: 'true' }).valid).toBe(false);
    expect(output(enabled.structuredContent).valid).toBe(true);
    const report = enabled.structuredContent as { elements: { name: string; rmsPowerW: number }[]; windowResults: { elements: { rmsPowerW: number }[] }[] };
    expect(report.elements.map(e => e.name)).toEqual(['R1']);
    expect(report.elements[0].rmsPowerW).toBeCloseTo(0.1, 10);
    expect(report.windowResults[0].elements[0].rmsPowerW).toBeCloseTo(0.1, 10);
    const strip = (r: typeof report) => ({ ...r, elements: r.elements.map(({ rmsPowerW: _rms, ...e }) => e), windowResults: r.windowResults.map(w => ({ ...w, elements: w.elements.map(({ rmsPowerW: _rms, ...e }) => e) })) });
    expect(JSON.stringify(strip(report))).toBe(JSON.stringify(omitted.structuredContent));
    expect(await executeTool(tool.name, { ...args, includePowerRms: 'true' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    expect(await executeTool(tool.name, { ...args, elements: ['missing'], includePowerRms: true })).toMatchObject({ isError: true });
  });
});
