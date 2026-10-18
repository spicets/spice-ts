import { describe, expect, it } from 'vitest';
import { createToolExecutor, executeTool } from './server.js';

const set = (x = [0, 1, 2], y = [0, 1, 2]) => ({ x, signals: { out: y } });
const compare = (reference: unknown, actual: unknown, extra = {}) => executeTool('spice_compare', { reference, actual, signals: ['out'], ...extra });

describe('spice_compare', () => {
  it('advertises comparison and returns exact zeros for identical sets', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_compare']) });
    expect(await compare(set(), set())).toMatchObject({ structuredContent: { pass: true, comparisons: [{ signal: 'out', maxAbsError: 0, maxRelError: 0, xAtWorstError: 0, firstExceededX: null, pass: true }] } });
  });
  it('reports a known offset, peak-relative error and first failing union sample', async () => {
    expect(await compare(set(), set([0, 0.5, 2], [0, 1.5, 3]), { absTolerance: 0.25 })).toMatchObject({ structuredContent: { pass: false, comparisons: [{ maxAbsError: 1, maxRelError: 0.5, xAtWorstError: 0.5, firstExceededX: 0.5, pass: false }] } });
  });
  it('interpolates on the union restricted to overlap without extrapolation', async () => {
    expect(await compare(set([0, 2], [0, 2]), set([1, 1.5, 3], [1, 1.5, 3]))).toMatchObject({ structuredContent: { pass: true, overlap: [1, 2], pointsCompared: 3 } });
  });
  it.each([
    ['AXIS_MISMATCH', set(), set([0, 1], [0])],
    ['AXIS_MISMATCH', { ...set(), axisUnit: 's' }, { ...set(), axisUnit: 'Hz' }],
    ['UNKNOWN_SIGNAL', set(), { x: [0, 1], signals: { other: [0, 1] } }],
    ['NON_MONOTONIC_AXIS', set(), set([0, 0, 1])],
    ['NON_MONOTONIC_AXIS', set(), set([0, 2, 1])],
    ['EMPTY_OVERLAP', set(), set([3, 4, 5])],
    ['EMPTY_OVERLAP', set(), set([], [])],
  ])('returns structured %s', async (code, reference, actual) => {
    expect(await compare(reference, actual)).toMatchObject({ isError: true, structuredContent: { error: { code, phase: 'validation', retryable: false } } });
  });
  it('uses additive absolute and reference-peak relative tolerance including a zero peak', async () => {
    expect(await compare(set(), set([0, 1, 2], [0.2, 1.2, 2.2]), { absTolerance: 0.11, relTolerance: 0.05 })).toMatchObject({ structuredContent: { pass: true } });
    expect(await compare(set([0], [0]), set([0], [1]))).toMatchObject({ structuredContent: { comparisons: [{ maxRelError: null, pass: false }] } });
  });
  it('compares complex AC magnitude and shortest wrapped phase in degrees', async () => {
    const reference = { x: [1, 2], signals: { out: [{ magnitude: 2, phaseDegrees: 179 }, { magnitude: 2, phaseDegrees: 179 }] } };
    const actual = { x: [1, 2], signals: { out: [{ magnitude: 3, phaseDegrees: -179 }, { magnitude: 3, phaseDegrees: -179 }] } };
    expect(await compare(reference, actual, { absTolerance: 1, phaseToleranceDegrees: 2 })).toMatchObject({ structuredContent: { pass: true, comparisons: [{ maxAbsError: 1, maxRelError: 0.5, phase: { maxAbsError: 2, pass: true } }] } });
    expect(await compare(reference, actual, { absTolerance: 1 })).toMatchObject({ structuredContent: { pass: false } });
  });
  it('rejects malformed values, mixed complex/real signals and invalid tolerances', async () => {
    for (const extra of [{ absTolerance: -1 }, { relTolerance: NaN }, { signals: [] }, { extra: 1 }]) {
      expect(await compare(set(), set(), extra)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    expect(await compare(set(), set([0, 1, 2], [0, NaN, 2]))).toMatchObject({ isError: true });
    expect(await compare(set([0], [0]), { x: [0], signals: { out: [{ magnitude: 1, phaseDegrees: 0 }] } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'AXIS_MISMATCH' } } });
  });
  it('accepts a protocol-v1 result reference and selects its analysis', async () => {
    const result = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS: [0, 1, 2], voltagesV: { out: [0, 1, 2] }, currentsA: {} }] };
    expect(await executeTool('spice_compare', { reference: { result, analysis: 0 }, actual: { x: [0, 1, 2], signals: { 'v(out)': [0, 1, 2] } }, signals: ['v(out)'] })).toMatchObject({ structuredContent: { pass: true } });
  });
  it('unwraps AC phases before interpolation across the branch cut', async () => {
    const reference = { x: [1, 3], signals: { out: [{ magnitude: 1, phaseDegrees: 170 }, { magnitude: 3, phaseDegrees: -170 }] } };
    const actual = { x: [2], signals: { out: [{ magnitude: 2, phaseDegrees: 180 }] } };
    expect(await compare(reference, actual)).toMatchObject({ structuredContent: { pass: true, pointsCompared: 1, comparisons: [{ maxAbsError: 0, phase: { maxAbsError: 0 } }] } });
  });
  it('accepts completed job references without consuming their events', async () => {
    const execute = createToolExecutor();
    const started = await execute('spice_simulation_start', { request: { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 1\nR1 out 0 1k\n.op' } } });
    expect(started.isError).not.toBe(true);
    const { jobId, cursor } = started.structuredContent as { jobId: string; cursor: string };
    let next = cursor;
    await expect.poll(async () => {
      const read = await execute('spice_simulation_read', { jobId, cursor: next });
      const data = read.structuredContent as { status: string; nextCursor?: string };
      if (data.nextCursor) next = data.nextCursor;
      return data.status;
    }).toBe('complete');
    const args = { reference: { jobId, analysis: 0 }, actual: { x: [0], signals: { 'v(out)': [1] } }, signals: ['v(out)'] };
    expect(await execute('spice_compare', args)).toMatchObject({ structuredContent: { pass: true } });
    expect(await execute('spice_compare', args)).toMatchObject({ structuredContent: { pass: true } });
  });
  it('rejects missing and ambiguous analyses and bounds output and point counts', async () => {
    const analysis = { type: 'op', analysisIndex: 0, voltagesV: { out: 1 }, currentsA: {} };
    for (const [analyses, code] of [[[], 'UNKNOWN_ANALYSIS'], [[analysis, analysis], 'AMBIGUOUS_ANALYSIS']] as const) {
      expect(await compare({ result: { status: 'complete', analyses }, analysis: 0 }, set())).toMatchObject({ isError: true, structuredContent: { error: { code } } });
    }
    for (const limits of [{ maxResultPoints: 1 }, { maxSerializedResultBytes: 1 }]) {
      const execute = createToolExecutor({ limits: { maxDocumentBytes: 262144, maxAnalyses: 8, maxResultPoints: 100, maxSerializedResultBytes: 10000, maxWallTimeMs: 1000, ...limits } });
      expect(await execute('spice_compare', { reference: set(), actual: set(), signals: ['out'] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    }
  });
  it('bounds input and output bytes and honors cancellation', async () => {
    const execute = createToolExecutor({ limits: { maxDocumentBytes: 20, maxAnalyses: 8, maxResultPoints: 100, maxSerializedResultBytes: 100, maxWallTimeMs: 1000 } });
    expect(await execute('spice_compare', { reference: set(), actual: set(), signals: ['out'] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect(await executeTool('spice_compare', { reference: set(), actual: set(), signals: ['out'] }, { signal: AbortSignal.abort() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
  });
});
