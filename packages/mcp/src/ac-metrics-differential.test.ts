import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { acMetrics } from './ac-metrics.js';
import { executeTool } from './server.js';

const p = (magnitude: number, phaseDegrees: number) => ({ magnitude, phaseDegrees });
const result: SimulationResultV1 = { status: 'complete', analyses: [{
  type: 'ac', analysisIndex: 0, frequencyHz: [1, 10], currentPhasors: {},
  voltagePhasors: {
    a: [p(2, 0), p(2, 0)], b: [p(1, 90), p(1, 90)],
    c: [p(1, 0), p(1, 0)], d: [p(1, 90), p(1, 90)],
  },
}] };

describe('differential AC metrics', () => {
  it('subtracts non-collinear output phasors in Cartesian space', () => {
    expect(acMetrics(result, { output: 'v(a,b)' }).dcGainDb).toBeCloseTo(20 * Math.log10(Math.sqrt(5)), 10);
  });

  it('accepts differential input and output', () => {
    expect(acMetrics(result, { output: 'v(a,b)', input: 'v(c,d)' }).dcGainDb).toBeCloseTo(20 * Math.log10(Math.sqrt(5 / 2)), 10);
  });
});

const polar = (x: number, y: number) => p(Math.hypot(x, y), Math.atan2(y, x) * 180 / Math.PI);
const trace = (analysisIndex: number, index: number, scale = 1) => {
  const pairs = [[4, -1], [2, -1], [0.5, -1], [0.1, -0.2]];
  return {
    type: 'ac' as const, analysisIndex, step: { index, parameter: 'R1', value: scale },
    frequencyHz: [1, 10, 100, 1000], currentPhasors: {},
    voltagePhasors: {
      Plus: pairs.map(([x, y]) => polar(scale * x + 2, scale * y + 3)),
      Minus: pairs.map(() => polar(2, 3)),
      Iplus: pairs.map(() => polar(3, 2)), Iminus: pairs.map(() => polar(2, 1.75)),
      reference: pairs.map(([x, y]) => polar(scale * x, scale * y)),
      inputReference: pairs.map(() => polar(1, 0.25)),
    },
  };
};
const synthetic: SimulationResultV1 = { status: 'complete', analyses: [trace(0, 0), trace(0, 1, 2), trace(1, 1, 3)] };

describe('differential AC selector contract', () => {
  it('works through the MCP tool on an actual AC circuit', async () => {
    const request = { apiVersion: '1', input: { format: 'spice', source: '* AC divider\nV1 in 0 AC 2\nR1 in out 1k\nR2 out 0 1k\n.ac dec 10 1 100\n.end' } };
    const response = await executeTool('spice_ac_metrics', { request, output: 'V(out,0)', input: 'v(in,0)' });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ dcGainDb: expect.closeTo(20 * Math.log10(0.5), 10) });
    const error = await executeTool('spice_ac_metrics', { request, output: 'v(out,missing)' });
    expect(error).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', details: { reason: 'UNKNOWN_NODE', node: 'missing' } } } });
  });
  it.each([undefined, 'V(IPLUS,iminus)'])('matches manually differenced metrics for input %s on selected analysis and step', input => {
    const selection = { analysis: 1, step: 1, groupDelayAtHz: 10 };
    const actual = acMetrics(synthetic, { ...selection, output: 'v(PLUS,minus)', input });
    const expected = acMetrics(synthetic, { ...selection, output: 'reference', input: input ? 'inputReference' : undefined });
    expect(expected.f3dbHz).not.toBeNull();
    expect(expected.unityGainHz).not.toBeNull();
    expect(expected.phaseMarginDeg).not.toBeNull();
    for (const key of ['dcGainDb', 'f3dbHz', 'unityGainHz', 'phaseMarginDeg', 'gainMarginDb', 'peakingDb', 'peakFrequencyHz', 'groupDelaySeconds'] as const) {
      if (expected[key] === null) expect(actual[key]).toBeNull();
      else expect(actual[key]).toBeCloseTo(expected[key]!, 9);
    }
    expect(actual.reasons).toEqual(expected.reasons);
  });

  it('recognizes ground and case-insensitive names on either side', () => {
    const options = { analysis: 0, step: 0 };
    expect(acMetrics(synthetic, { ...options, output: 'V(plus, 0)' }).dcGainDb)
      .toBeCloseTo(acMetrics(synthetic, { ...options, output: 'Plus' }).dcGainDb!, 12);
    expect(acMetrics(synthetic, { ...options, output: 'v(0,PLUS)' }).dcGainDb)
      .toBeCloseTo(acMetrics(synthetic, { ...options, output: 'Plus' }).dcGainDb!, 12);
  });

  it('cancels equal common-mode output and rejects zero differential input', () => {
    expect(acMetrics(result, { output: 'v(a,a)' })).toMatchObject({ dcGainDb: null, reasons: { dcGainDb: 'NON_FINITE_GAIN' } });
    expect(() => acMetrics(result, { output: 'a', input: 'v(b,b)' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', details: { reason: 'UNDEFINED_TRANSFER' } }));
  });

  it('does not suppress representable small differences', () => {
    const tiny: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: [1], currentPhasors: {}, voltagePhasors: { a: [p(1, 0)], b: [p(1 - Number.EPSILON, 0)] } }] };
    expect(acMetrics(tiny, { output: 'v(a,b)' }).dcGainDb).toBeCloseTo(20 * Math.log10(Number.EPSILON), 10);
  });

  it.each(['v(a,)', 'v(,a)', 'v(a,b,c)', 'v(a,b', 'v((a),b)', 'v(a b,c)', 'x(a,b)'])('rejects malformed selector %s', output => {
    expect(() => acMetrics(result, { output })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', phase: 'validation' }));
  });

  it('rejects missing and nonfinite operand phasors', () => {
    expect(() => acMetrics(result, { output: 'v(a,missing)' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', details: { reason: 'UNKNOWN_NODE', node: 'missing' } }));
    for (const bad of [p(NaN, 0), p(1, Infinity), p(-1, 0)]) {
      const broken: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0, frequencyHz: [1], currentPhasors: {}, voltagePhasors: { a: [p(1, 0)], b: [bad] } }] };
      expect(() => acMetrics(broken, { output: 'v(a,b)' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', details: { reason: 'UNDEFINED_TRANSFER' } }));
    }
  });
});
