import { describe, expect, it } from 'vitest';
import { executeTool } from './server.js';
import { measureResult } from './measure.js';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';

describe('AC scalar phase measurements', () => {
  it('returns the RC corner phase through the public tool', async () => {
    const corner = 1 / (2 * Math.PI * 0.001);
    const source = `* RC phase\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac lin 3 ${corner / 2} ${corner * 1.5}\n.end`;
    const response = await executeTool('spice_measure', {
      request: { apiVersion: '1', input: { format: 'spice', source } },
      measurements: [{ kind: 'at', signal: 'phase(v(out))', analysis: 0, at: corner }],
    });
    expect(response.isError).not.toBe(true);
    const result = response.structuredContent as { measurements: { value: number; unit: string }[] };
    expect(result.measurements[0].unit).toBe('deg');
    expect(Math.abs(result.measurements[0].value + 45)).toBeLessThan(1e-6);
    console.log(`RC corner expected -45 deg, actual ${result.measurements[0].value} deg, error ${Math.abs(result.measurements[0].value + 45)} deg`);
  });

  it('matches protocol current phase without changing the source sign', async () => {
    const source = '* RC current\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac lin 2 100 200\n.end';
    const request = { apiVersion: '1', input: { format: 'spice', source } };
    const sim = await executeTool('spice_simulate', { request });
    const analysis = (sim.structuredContent as unknown as SimulationResultV1).analyses[0];
    expect(analysis.type).toBe('ac');
    if (analysis.type !== 'ac') throw new Error('Expected AC');
    const current = Object.entries(analysis.currentPhasors).find(([key]) => key.toLowerCase() === 'v1')![1][0];
    const response = await executeTool('spice_measure', { request, measurements: [{ kind: 'at', signal: 'PhAsE(I(v1))', analysis: 0, at: 100, step: 0 }] });
    const measurement = (response.structuredContent as { measurements: { value: number; unit: string }[] }).measurements[0];
    expect(measurement.unit).toBe('deg');
    expect(measurement.value).toBeCloseTo(current.phaseDegrees, 10);
    expect(current.phaseDegrees).toBeLessThan(0);
    console.log(`source current protocol ${current.phaseDegrees} deg, measurement ${measurement.value} deg`);
  });

  it.each([false, true])('unwraps in frequency order before reducing (descending=%s)', descending => {
    const frequencyHz = descending ? [2, 1] : [1, 2];
    const phases = descending ? [-170, 170] : [170, -170];
    const analysis = { type: 'ac' as const, analysisIndex: 0, frequencyHz, currentPhasors: {}, voltagePhasors: { Out: phases.map(phaseDegrees => ({ magnitude: 1, phaseDegrees })) } };
    const result: SimulationResultV1 = { status: 'complete', analyses: [analysis] };
    const measurements = ['min', 'max', 'avg', 'at'].map(kind => ({ kind, signal: 'PHASE(V(out))', analysis: 0, ...(kind === 'at' ? { at: 1.5 } : {}) }));
    expect(measureResult(result, measurements).measurements).toEqual([170, 190, 180, 180].map(value => ({ value, unit: 'deg' })));
    expect(measureResult(result, [{ kind: 'at', signal: 'phase(v(out))', analysis: 0, at: 1 }]).measurements).toEqual([{ value: 170, unit: 'deg' }]);
  });

  it('selects zero-based steps and isolates malformed and non-AC projections', () => {
    const make = (index: number, phaseDegrees: number) => ({ type: 'ac' as const, analysisIndex: 0, step: { index, parameter: 'r', value: index + 1 }, frequencyHz: [1, 2], currentPhasors: {}, voltagePhasors: { OUT: [1, 2].map(() => ({ magnitude: 1, phaseDegrees })) } });
    const result: SimulationResultV1 = { status: 'complete', analyses: [make(0, -30), make(1, -60)] };
    const specs = [
      { kind: 'avg', signal: 'phase(v(out))', analysis: 0, step: 1 },
      { kind: 'max', signal: 'phase(mag(v(out)))', analysis: 0, step: 0 },
      { kind: 'max', signal: 'phase(v(out)', analysis: 0, step: 0 },
      { kind: 'max', signal: 'mag(v(out))', analysis: 0, step: 0 },
      { kind: 'avg', signal: 'phase(v(out))', analysis: 0, step: 2 },
    ];
    expect(measureResult(result, specs).measurements).toMatchObject([{ value: -60, unit: 'deg' }, { error: { code: 'UNKNOWN_SIGNAL' } }, { error: { code: 'UNKNOWN_SIGNAL' } }, { value: 1, unit: 'V' }, { error: { code: 'UNKNOWN_STEP' } }]);
    const dc: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'dc', analysisIndex: 0, axis: { name: 'V1', unit: 'V', values: [0, 1] }, voltagesV: { out: [0, 1] }, currentsA: {} }] };
    expect(measureResult(dc, [{ kind: 'max', signal: 'phase(v(out))', analysis: 0 }, { kind: 'max', signal: 'v(out)', analysis: 0 }]).measurements).toMatchObject([{ error: { code: 'UNKNOWN_SIGNAL' } }, { value: 1, unit: 'V' }]);
  });

  it.each([[0, 0], [Infinity, 0], [NaN, 0], [1, Infinity], [1, NaN]])('rejects undefined phase for magnitude %s and angle %s independently', (magnitude, phaseDegrees) => {
    const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: [1, 2], currentPhasors: {}, voltagePhasors: { bad: [{ magnitude, phaseDegrees }, { magnitude: 1, phaseDegrees: 0 }], good: [{ magnitude: 1, phaseDegrees: 45 }, { magnitude: 1, phaseDegrees: 45 }] } }] };
    expect(measureResult(result, [{ kind: 'avg', signal: 'phase(v(bad))', analysis: 0 }, { kind: 'avg', signal: 'phase(v(good))', analysis: 0 }]).measurements).toMatchObject([{ error: { code: 'NON_FINITE_RESULT' } }, { value: 45, unit: 'deg' }]);
  });
});
