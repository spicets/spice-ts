import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';
import { measurementListSchema, measureResult } from './measure.js';

const request = (source: string): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice', source } });
const rcTran = '* Original MIT RC measurement probe\nV1 in 0 PULSE(0 1 0 1n 1n 10m 20m)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 5m\n.end\n';
const rcAc = '* Original MIT RC measurement probe\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 200 1 100k\n.end\n';

async function measure(source: string, measurements: unknown[]) {
  const response = await executeTool('spice_measure', { request: request(source), measurements });
  expect(response.isError).not.toBe(true);
  return response.structuredContent as { measurements: { value?: number; unit?: string; error?: { code: string } }[] };
}

describe('spice_measure', () => {
  const steppedRc = rcAc.replace('R1 in out 1k', 'r in out 1k').replace('.end', '.step param r 1k 3k 1k\n.end');
  const cutoff = { kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -10 * Math.log10(2), edge: 'falling' };

  it('measures each RC step identically to separate unstepped runs', async () => {
    const stepped = await measure(steppedRc, [0, 1, 2].map(step => ({ ...cutoff, step })));
    const separate: Awaited<ReturnType<typeof measure>>[] = [];
    for (const r of ['1k', '2k', '3k']) separate.push(await measure(rcAc.replace('R1 in out 1k', `R1 in out ${r}`), [cutoff]));
    const values = stepped.measurements.map((m, i) => {
      expect(m.error).toBeUndefined();
      expect(m.unit).toBe('Hz');
      expect(Math.abs(m.value! / separate[i].measurements[0].value! - 1)).toBeLessThanOrEqual(1e-12);
      return m.value;
    });
    expect(new Set(values).size).toBe(3);
  });

  it('reports step count for ambiguous selections and rejects unknown steps independently', async () => {
    const result = await measure(steppedRc, [cutoff, ...[3, 99].map(step => ({ ...cutoff, step }))]);
    expect(result.measurements).toMatchObject([
      { error: { code: 'AMBIGUOUS_ANALYSIS', message: expect.stringContaining('3 steps') } },
      { error: { code: 'UNKNOWN_STEP' } }, { error: { code: 'UNKNOWN_STEP' } },
    ]);
    const single = await measure(rcAc, [cutoff, { ...cutoff, step: 0 }, { ...cutoff, step: 1 }]);
    expect(single.measurements[1]).toEqual(single.measurements[0]);
    expect(single.measurements[2]).toMatchObject({ error: { code: 'UNKNOWN_STEP' } });
  });

  it('validates the optional step as a nonnegative integer', async () => {
    expect(measurementListSchema.items.properties).toMatchObject({ step: { type: 'integer', minimum: 0 } });
    const result = await measure(rcAc, [-1, 0.5, '0', null, NaN, Infinity].map(step => ({ ...cutoff, step })));
    expect(result.measurements).toMatchObject(Array(6).fill({ error: { code: 'INVALID_MEASUREMENT' } }));
  });

  it('selects step metadata rather than array position, including a single stepped result', () => {
    const analysis = { type: 'op' as const, analysisIndex: 0, voltagesV: { out: 2 }, currentsA: {}, step: { index: 1, parameter: 'r', value: 2000 } };
    const result = { status: 'complete' as const, analyses: [analysis, { ...analysis, voltagesV: { out: 1 }, step: { ...analysis.step, index: 0, value: 1000 } }] };
    const item = { kind: 'max', signal: 'v(out)', analysis: 0, step: 1 };
    expect(measureResult(result, [item]).measurements).toEqual([{ value: 2, unit: 'V' }]);
    expect(measureResult({ ...result, analyses: [analysis] }, [item, { ...item, step: 0 }]).measurements).toMatchObject([
      { value: 2, unit: 'V' }, { error: { code: 'UNKNOWN_STEP' } },
    ]);
  });

  it('measures RC tau without returning vectors and isolates unknown signals and missing crossings', async () => {
    const result = await measure(rcTran, [
      { kind: 'cross', signal: 'v(out)', analysis: 0, value: 1 - Math.exp(-1), edge: 'rising' },
      { kind: 'max', signal: 'v(missing)', analysis: 0 },
      { kind: 'when', signal: 'v(out)', analysis: 0, value: 2 },
    ]);
    expect(Math.abs(result.measurements[0].value! / 0.001 - 1)).toBeLessThan(0.005);
    // ngspice-47 ASCII raw, same deck, linear crossing of v(out).
    expect(Math.abs(result.measurements[0].value! / 0.0010000004399795483 - 1)).toBeLessThan(1e-6);
    expect(result.measurements[0].unit).toBe('s');
    expect(result.measurements[1].error?.code).toBe('UNKNOWN_SIGNAL');
    expect(result.measurements[2].error?.code).toBe('NO_CROSSING');
    expect(JSON.stringify(result).length).toBeLessThan(600);
    expect(JSON.stringify(result)).not.toMatch(/timeS|voltagesV|frequencyHz/);
  });

  it('measures the RC AC -3dB frequency within 0.5% of analytic cutoff', async () => {
    const result = await measure(rcAc, [{ kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -10 * Math.log10(2), edge: 'falling' }]);
    expect(result.measurements[0].unit).toBe('Hz');
    expect(Math.abs(result.measurements[0].value! / (1 / (2 * Math.PI * 0.001)) - 1)).toBeLessThan(0.005);
    // ngspice-47 ASCII raw, same deck, linear crossing of 20*log10(|v(out)|).
    expect(Math.abs(result.measurements[0].value! / 159.15494564859017 - 1)).toBeLessThan(1e-6);
  });

  it('advertises the tool', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tools: expect.arrayContaining(['spice_measure']) });
  });

  it('reduces and interpolates DC data with clipped windows and typed errors', async () => {
    const result = await measure('V1 out 0 0\nR1 out 0 1k\n.dc V1 0 2 1', [
      ...['min', 'max', 'avg', 'rms', 'pp'].map(kind => ({ kind, signal: 'v(out)', analysis: 0, from: 0.5, to: 1.5 })),
      { kind: 'at', signal: 'i(V1)', analysis: 0, at: 0.5 },
      { kind: 'at', signal: 'v(out)', analysis: 0, at: 3 },
      { kind: 'max', signal: 'v(out)', analysis: 8 },
      { kind: 'at', signal: 'v(out)', analysis: 0 },
    ]);
    expect(result.measurements.slice(0, 5).map(m => m.value)).toEqual([0.5, 1.5, 1, Math.sqrt(13 / 12), 1]);
    expect(result.measurements[5]).toMatchObject({ value: -0.0005, unit: 'A' });
    expect(result.measurements.slice(6).map(m => m.error?.code)).toEqual(['OUT_OF_RANGE', 'UNKNOWN_ANALYSIS', 'INVALID_MEASUREMENT']);
  });

  it('rejects unbounded measurement lists before solving', async () => {
    expect(await executeTool('spice_measure', { request: request(rcAc), measurements: Array(129).fill({}) })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('weights uneven samples, handles descending axes and isolates malformed items', () => {
    const result = { status: 'complete' as const, analyses: [{ type: 'dc' as const, analysisIndex: 0, axis: { name: 'V1', unit: 'V' as const, values: [3, 1, 0] }, voltagesV: { out: [3, 1, 0] }, currentsA: {} }] };
    expect(measureResult(result, [
      { kind: 'avg', signal: 'v(out)', analysis: 0 },
      { kind: 'rms', signal: 'v(out)', analysis: 0 },
      { kind: 'when', signal: 'v(out)', analysis: 0, value: 1, edge: 'rising' },
      { kind: 'when', signal: 'v(out)', analysis: 0, value: 1, edge: 'falling' },
      null,
    ]).measurements).toMatchObject([
      { value: 1.5, unit: 'V' }, { value: Math.sqrt(3), unit: 'V' },
      { value: 1, unit: 'V' }, { error: { code: 'NO_CROSSING' } },
      { error: { code: 'INVALID_MEASUREMENT' } },
    ]);
    expect(measureResult({ ...result, analyses: [...result.analyses, ...result.analyses] }, [{ kind: 'max', signal: 'v(out)', analysis: 0 }]).measurements).toMatchObject([{ error: { code: 'AMBIGUOUS_ANALYSIS' } }]);
  });

  it('honors measurement payload and simulation resource limits', async () => {
    const measurements = [{ kind: 'max', signal: 'v(out)', analysis: 0 }];
    expect(await executeTool('spice_measure', { request: { ...request(rcAc), options: { limits: { maxResultPoints: 0 } } }, measurements })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    expect(await executeTool('spice_measure', { request: request(rcAc), measurements: [{ padding: 'x'.repeat(262145) }] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });
});
