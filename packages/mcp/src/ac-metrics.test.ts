import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { acMetrics } from './ac-metrics.js';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

const rc = '* Original MIT analytic RC probe\nV1 in 0 DC 0 AC 2\nR1 in out 1k\nC1 out 0 1u\n.ac dec 100 0.1 100k\n.end';
const loop = '* Original MIT buffered two-pole loop\nV1 in 0 DC 0 AC 1\nR1 in p1 1k\nC1 p1 0 1u\nE1 b 0 p1 0 10\nR2 b out 1k\nC2 out 0 1u\n.ac dec 100 0.1 100k\n.end';
const args = (source = rc) => ({ request: { apiVersion: '1', input: { format: 'spice', source } }, output: 'out', input: 'in' });
const validator = new AjvJsonSchemaValidator();
async function metrics(source = rc) {
  const response = await executeTool('spice_ac_metrics', args(source));
  expect(response.isError).not.toBe(true);
  return response.structuredContent as { dcGainDb: number; f3dbHz: number; unityGainHz: number | null; phaseMarginDeg: number | null; gainMarginDb: number | null; reasons: Record<string, string> };
}

describe('spice_ac_metrics', () => {
  it.each([
    { magnitudes: [1, 0.1], phases: [-90, -135], unity: 1, margin: 90, gainMargin: null },
    { magnitudes: [10, 1], phases: [-90, -135], unity: 10, margin: 45, gainMargin: null },
    { magnitudes: [0.1, 0.01], phases: [-180, -225], unity: null, margin: null, gainMargin: 20 },
    { magnitudes: [0.1, 0.01], phases: [-135, -180], unity: null, margin: null, gainMargin: 40 },
  ])('includes descending crossings at sweep endpoints: %j', ({ magnitudes, phases, unity, margin, gainMargin }) => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{
      type: 'ac', analysisIndex: 0, frequencyHz: [1, 10], currentPhasors: {},
      voltagePhasors: { out: magnitudes.map((magnitude, i) => ({ magnitude, phaseDegrees: phases[i] })) },
    }] };
    const m = acMetrics(result, { output: 'out' });
    if (unity === null) expect(m.unityGainHz).toBeNull();
    else expect(m.unityGainHz).toBeCloseTo(unity, 10);
    expect(m.phaseMarginDeg).toBe(margin);
    expect(m.gainMarginDb).toBe(gainMargin);
  });

  it.each([[1, 1], [1, 10], [0.1, 1]])('does not treat flat or rising gain as a descending crossing: %j', (...magnitudes) => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{
      type: 'ac', analysisIndex: 0, frequencyHz: [1, 10], currentPhasors: {},
      voltagePhasors: { out: magnitudes.map(magnitude => ({ magnitude, phaseDegrees: -90 })) },
    }] };
    expect(acMetrics(result, { output: 'out' })).toMatchObject({
      unityGainHz: null, phaseMarginDeg: null, reasons: { unityGainHz: expect.any(String) },
    });
  });

  it('interpolates in log-frequency, unwraps phase and selects the first descending crossings', () => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{
      type: 'ac', analysisIndex: 2, frequencyHz: [1, 100, 10000], currentPhasors: {},
      voltagePhasors: { Out: [
        { magnitude: 10, phaseDegrees: -120 },
        { magnitude: 0.1, phaseDegrees: 120 },
        { magnitude: 0.01, phaseDegrees: 60 },
      ] },
    }] };
    const m = acMetrics(result, { output: 'OUT', analysis: 2 });
    expect(m.unityGainHz).toBeCloseTo(10, 10);
    expect(m.phaseMarginDeg).toBeCloseTo(0, 10);
    expect(m.gainMarginDb).toBeCloseTo(0, 10);
    expect(m.reasons).toEqual({});
    expect(() => acMetrics(result, { output: 'out', analysis: 0 })).toThrow();
    expect(() => acMetrics({ ...result, analyses: [...result.analyses, ...result.analyses] }, { output: 'out' })).toThrow();
  });

  it('returns null with reasons for zero output and rejects undefined input ratios', () => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{
      type: 'ac', analysisIndex: 0, frequencyHz: [1, 10], currentPhasors: {},
      voltagePhasors: { out: Array.from({ length: 2 }, () => ({ magnitude: 0, phaseDegrees: 0 })) },
    }] };
    expect(acMetrics(result, { output: 'out' })).toMatchObject({ dcGainDb: null, f3dbHz: null, unityGainHz: null, phaseMarginDeg: null, gainMarginDb: null, reasons: { dcGainDb: expect.any(String) } });
    expect(() => acMetrics(result, { output: 'out', input: 'out' })).toThrow();
  });

  it('matches analytic RC cutoff and reports absent crossings without extrapolation', async () => {
    const m = await metrics();
    expect(Math.abs(m.dcGainDb)).toBeLessThan(0.01);
    expect(Math.abs(m.f3dbHz / (1 / (2 * Math.PI * 0.001)) - 1)).toBeLessThan(0.005);
    expect(m.unityGainHz).toBeNull();
    expect(m.phaseMarginDeg).toBeNull();
    expect(m.gainMarginDb).toBeNull();
    expect(m.reasons.unityGainHz).toMatch(/crossing/i);
    expect(m.reasons.phaseMarginDeg).toMatch(/unity/i);
    expect(m.reasons.gainMarginDb).toMatch(/crossing/i);
  });

  it('matches the analytic two-pole loop phase margin within 0.5 degrees', async () => {
    const m = await metrics(loop);
    const unity = 3 / (2 * Math.PI * 0.001);
    const margin = 180 - 2 * Math.atan(3) * 180 / Math.PI;
    expect(Math.abs(m.unityGainHz! / unity - 1)).toBeLessThan(0.005);
    expect(Math.abs(m.phaseMarginDeg! - margin)).toBeLessThan(0.5);
  });

  it('supports absolute output gain and enforces the existing simulation limits', async () => {
    const { input: _input, ...absolute } = args();
    const response = await executeTool('spice_ac_metrics', absolute);
    expect(response.structuredContent).toMatchObject({ dcGainDb: expect.closeTo(20 * Math.log10(2), 4) });
    const limited = { ...args(), request: { ...args().request, options: { limits: { maxResultPoints: 0 } } } };
    expect(await executeTool('spice_ac_metrics', limited)).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('advertises and validates input, success and error schemas', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics');
    expect(tool).toBeDefined();
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_ac_metrics']) });
    const input = validator.getValidator(tool!.inputSchema);
    expect(input(args()).valid).toBe(true);
    expect(input({ ...args(), output: 3 }).valid).toBe(false);
    const output = validator.getValidator(tool!.outputSchema!);
    expect(output((await executeTool('spice_ac_metrics', args())).structuredContent).valid).toBe(true);
    const bad = await executeTool('spice_ac_metrics', { ...args(), output: 'missing' });
    expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', details: { reason: 'UNKNOWN_NODE', node: 'missing' } } } });
    expect(output(bad.structuredContent).valid).toBe(true);
    expect(output({ dcGainDb: 0 }).valid).toBe(false);
  });

  it('rejects malformed selectors and non-AC or ambiguous analyses', async () => {
    for (const extra of [{ output: '' }, { analysis: -1 }, { unexpected: true }]) {
      expect(await executeTool('spice_ac_metrics', { ...args(), ...extra })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    expect(await executeTool('spice_ac_metrics', args(rc.replace('.ac dec 100 0.1 100k', '.op')))).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    expect(await executeTool('spice_ac_metrics', { ...args(), input: 'missing' })).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'UNKNOWN_NODE' } } } });
    expect(await executeTool('spice_ac_metrics', args(rc.replace('.end', '.ac dec 10 1 1k\n.end')))).toMatchObject({ isError: true });
  });
});
