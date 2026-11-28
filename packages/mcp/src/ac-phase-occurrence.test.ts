import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { acMetrics, acMetricsArgs } from './ac-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

type Direction = 'ascending' | 'descending' | 'either';
const sweep = (phases: number[], magnitudes = phases.map(() => 1), inputPhase = 0): SimulationResultV1 => ({
  status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: phases.map((_, i) => 10 ** i), currentPhasors: {}, voltagePhasors: {
    out: phases.map((phaseDegrees, i) => ({ magnitude: magnitudes[i], phaseDegrees: phaseDegrees + inputPhase })),
    in: phases.map(() => ({ magnitude: 2, phaseDegrees: inputPhase })),
  } }],
});
const query = (trace: SimulationResultV1, occurrence: number, direction: Direction = 'either', targets = [0]) =>
  acMetrics(trace, { output: 'out', input: 'in', phaseCrossingsDeg: targets, phaseCrossingDirection: direction, phaseCrossingOccurrence: occurrence }).phaseCrossings!;
const close = (actual: number | null, expected: number) => expect(Math.abs(actual! / expected - 1)).toBeLessThan(1e-12);
const missing = (targetDeg: number) => ({ targetDeg, frequencyHz: null, reason: 'NO_PHASE_CROSSING' });
const rc = '* RC phase regression\nV1 in 0 DC 0 AC 2\nR1 in out 1k\nC1 out 0 1u\n.ac dec 100 0.1 100k\n.end';
const base = { request: { apiVersion: '1', input: { format: 'spice', source: rc } }, output: 'out', input: 'in' };

describe('AC phase crossing occurrence', () => {
  it('accepts a second occurrence with phase targets', () => {
    expect(acMetricsArgs({ output: 'out', phaseCrossingsDeg: [-45], phaseCrossingOccurrence: 2 })).toMatchObject({ phaseCrossingOccurrence: 2 });
  });
  it('selects independent log-frequency occurrences and counts direction per target', () => {
    const trace = sweep([-60, 60, -60, 60, -60, 60, -60], undefined, 37);
    for (const occurrence of [1, 2, 3]) {
      for (const [direction, exponent] of [['ascending', 2 * occurrence - 1.5], ['descending', 2 * occurrence - 0.5], ['either', occurrence - 0.5]] as const) {
        const [zero, thirty] = query(trace, occurrence, direction, [0, 30]);
        close(zero.frequencyHz, 10 ** exponent);
        close(thirty.frequencyHz, 10 ** (exponent + (direction === 'descending' ? -0.25 : 0.25) * (direction === 'either' && occurrence === 2 ? -1 : 1)));
      }
    }
    expect(query(trace, 4, 'ascending')[0]).toEqual(missing(0));
    const defaults = acMetrics(trace, { output: 'out', input: 'in', phaseCrossingsDeg: [0] });
    expect(acMetrics(trace, { output: 'out', input: 'in', phaseCrossingsDeg: [0], phaseCrossingOccurrence: 1 })).toEqual(defaults);
  });
  it('deduplicates a shared exact endpoint and retains non-flat plateau policy', () => {
    const endpoint = sweep([-45, 0, -45, 45]);
    close(query(endpoint, 1)[0].frequencyHz, 10);
    close(query(endpoint, 2)[0].frequencyHz, 10 ** 2.5);
    expect(query(endpoint, 3)[0]).toEqual(missing(0));
    const plateau = sweep([-45, 0, 0, 45]);
    close(query(plateau, 1)[0].frequencyHz, 10);
    close(query(plateau, 2)[0].frequencyHz, 100);
    expect(query(sweep([0, 0, 0]), 1)[0]).toEqual(missing(0));
  });
  it('unwraps across ±180 and restarts after zero magnitude', () => {
    const wrapped = sweep([135, -135, 135, -135]);
    for (const n of [1, 2, 3]) close(query(wrapped, n, 'either', [180])[0].frequencyHz, 10 ** (n - 0.5));
    const broken = sweep([-45, 45, 0, -45, 45], [1, 1, 0, 1, 1]);
    close(query(broken, 1, 'ascending')[0].frequencyHz, 10 ** 0.5);
    close(query(broken, 2, 'ascending')[0].frequencyHz, 10 ** 3.5);
    expect(query(broken, 3, 'either')[0]).toEqual(missing(0));
    expect(query(sweep([-45, 0, 45], [1, 0, 1]), 1)[0]).toEqual(missing(0));
  });
  it('validates malformed selectors and returns schema-consistent errors', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
    const ajv = new AjvJsonSchemaValidator();
    const input = ajv.getValidator(tool.inputSchema);
    const output = ajv.getValidator(tool.outputSchema!);
    expect(input({ ...base, phaseCrossingsDeg: [-45], phaseCrossingOccurrence: 1000 }).valid).toBe(true);
    for (const value of [0, -1, 1001, 1.5, NaN, Infinity, '2', null]) {
      expect(input({ ...base, phaseCrossingsDeg: [-45], phaseCrossingOccurrence: value }).valid).toBe(false);
      const bad = await executeTool(tool.name, { ...base, phaseCrossingsDeg: [-45], phaseCrossingOccurrence: value });
      expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', details: { reason: 'INVALID_PHASE_CROSSING_OCCURRENCE' } } } });
      expect(output(bad.structuredContent).valid).toBe(true);
    }
    const missingTargets = await executeTool(tool.name, { ...base, phaseCrossingOccurrence: 1 });
    expect(missingTargets).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', details: { reason: 'INVALID_PHASE_CROSSING_OCCURRENCE' } } } });
    expect(output(missingTargets.structuredContent).valid).toBe(true);
    expect(() => acMetrics(sweep([0, 1]), { output: 'out', phaseCrossingOccurrence: 2 })).toThrow();
  });
  it('preserves first crossing on a real RC circuit and never extrapolates later ones', async () => {
    const queryCircuit = (extra: object) => executeTool('spice_ac_metrics', { ...base, phaseCrossingsDeg: [-45], ...extra });
    const first = await queryCircuit({});
    const explicit = await queryCircuit({ phaseCrossingOccurrence: 1 });
    expect(first.isError).not.toBe(true);
    expect(explicit.structuredContent).toEqual(first.structuredContent);
    const later = await queryCircuit({ phaseCrossingOccurrence: 2 });
    expect(later.structuredContent).toMatchObject({ phaseCrossings: [missing(-45)] });
  });
});
