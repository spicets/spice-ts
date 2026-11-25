import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';
import { acMetrics, acMetricsArgs } from './ac-metrics.js';

const sweep = (gains: number[]): SimulationResultV1 => ({ status: 'complete', analyses: [{
  type: 'ac', analysisIndex: 0, frequencyHz: gains.map((_, i) => 10 ** (i + 1)), currentPhasors: {},
  voltagePhasors: { out: gains.map(db => ({ magnitude: 10 ** (db / 20), phaseDegrees: 0 })) },
}] });
const request = { apiVersion: '1', input: { format: 'spice', source: '* synthetic\nV1 out 0 AC 1\n.ac dec 1 10 1000\n.end' } };

describe('directional AC gain crossings', () => {
  it('interpolates an ascending edge while default remains descending', async () => {
    const args = { request, output: 'out', gainCrossingsDb: [-10] };
    const simulate = async () => sweep([-20, 0, 10]);
    const rising = await executeTool('spice_ac_metrics', { ...args, gainCrossingDirection: 'ascending' }, { simulate });
    expect(rising.isError).not.toBe(true);
    expect((rising.structuredContent as { gainCrossings: { frequencyHz: number }[] }).gainCrossings[0].frequencyHz).toBeCloseTo(Math.sqrt(1000), 10);
    const legacy = await executeTool('spice_ac_metrics', args, { simulate });
    expect((legacy.structuredContent as { gainCrossings: { frequencyHz: number | null }[] }).gainCrossings[0].frequencyHz).toBeNull();
  });

  it('selects the lower and upper band-pass edges in sweep order', () => {
    const trace = sweep([-20, 0, -20]);
    const query = (gainCrossingDirection: 'ascending' | 'descending' | 'either') => acMetrics(trace, { output: 'out', gainCrossingsDb: [-10], gainCrossingDirection }).gainCrossings![0].frequencyHz!;
    expect(query('ascending')).toBeCloseTo(10 ** 1.5, 10);
    expect(query('descending')).toBeCloseTo(10 ** 2.5, 10);
    expect(query('either')).toBeCloseTo(query('ascending'), 10);
    expect(acMetrics(trace, { output: 'out', gainCrossingsDb: [-10] }).gainCrossings![0].frequencyHz).toBe(query('descending'));
  });

  it('counts non-flat exact endpoints, not flat plateaus, and preserves target order', () => {
    const trace = sweep([-20, 0, 0, -20]);
    const targets = [0, -20, 10, 0];
    const asc = acMetrics(trace, { output: 'out', gainCrossingsDb: targets, gainCrossingDirection: 'ascending' }).gainCrossings!;
    expect(asc.map(c => c.targetDb)).toEqual(targets);
    expect(asc.map(c => c.frequencyHz)).toEqual([expect.closeTo(100), expect.closeTo(10), null, expect.closeTo(100)]);
    expect(acMetrics(sweep([0, 0]), { output: 'out', gainCrossingsDb: [0], gainCrossingDirection: 'either' }).gainCrossings![0].frequencyHz).toBeNull();
    expect(acMetrics(trace, { output: 'out', gainCrossingsDb: [0], gainCrossingDirection: 'descending' }).gainCrossings![0].frequencyHz).toBeCloseTo(1000);
  });

  it('does not interpolate across zero and rejects undefined phasors', () => {
    const trace = sweep([-20, 0, 0]);
    const a = trace.analyses[0];
    if (a.type !== 'ac') throw new Error('expected AC');
    a.voltagePhasors.out[1].magnitude = 0;
    expect(acMetrics(trace, { output: 'out', gainCrossingsDb: [-10], gainCrossingDirection: 'either' }).gainCrossings![0].frequencyHz).toBeNull();
    expect(acMetrics(trace, { output: 'out', gainCrossingsDb: [0], gainCrossingDirection: 'ascending' }).gainCrossings![0].frequencyHz).toBe(1000);
    a.voltagePhasors.out[1].magnitude = NaN;
    expect(() => acMetrics(trace, { output: 'out', gainCrossingsDb: [-10], gainCrossingDirection: 'ascending' })).toThrow();
    a.voltagePhasors.out[1].magnitude = 1;
    a.voltagePhasors.in = [1, 0, 1].map(magnitude => ({ magnitude, phaseDegrees: 0 }));
    expect(() => acMetrics(trace, { output: 'out', input: 'in', gainCrossingsDb: [-10], gainCrossingDirection: 'ascending' })).toThrow();
  });

  it('leaves unrelated outputs and descending phase queries unchanged', () => {
    const trace = sweep([-20, 0, -20]);
    const a = trace.analyses[0];
    if (a.type !== 'ac') throw new Error('expected AC');
    a.voltagePhasors.out.forEach((p, i) => { p.phaseDegrees = [0, -90, -180][i]; });
    const args = { output: 'out', phaseCrossingsDeg: [-45] };
    expect(acMetrics(trace, { ...args, gainCrossingDirection: 'ascending' })).toEqual(acMetrics(trace, args));
    expect(() => acMetricsArgs({ output: 'out', gainCrossingDirection: 'up' })).toThrow();
    expect(() => acMetricsArgs({ output: 'out', gainCrossingsDb: Array(33).fill(0), gainCrossingDirection: 'ascending' })).toThrow();
    expect(acMetricsArgs({ output: 'out', gainCrossingsDb: Array(32).fill(0), gainCrossingDirection: 'ascending' }).gainCrossingsDb).toHaveLength(32);
  });

  it('interpolates finite phasors even when their ratios underflow or overflow', () => {
    const trace = sweep([0, 0]);
    const a = trace.analyses[0];
    if (a.type !== 'ac') throw new Error('expected AC');
    a.voltagePhasors.out = [1e-300, 1e300].map(magnitude => ({ magnitude, phaseDegrees: 0 }));
    a.voltagePhasors.in = [1e-100, 1e-100].map(magnitude => ({ magnitude, phaseDegrees: 0 }));
    const frequency = acMetrics(trace, { output: 'out', input: 'in', gainCrossingsDb: [0], gainCrossingDirection: 'ascending' }).gainCrossings![0].frequencyHz!;
    expect(frequency).toBeCloseTo(10 ** (1 + 1 / 3), 10);
  });
});
