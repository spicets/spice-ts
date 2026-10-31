import { describe, expect, it } from 'vitest';
import { measureResult } from './measure.js';
import { executeTool } from './server.js';

const ramp = { status: 'complete' as const, analyses: [{ type: 'tran' as const, analysisIndex: 0, timeS: [0, 1, 2], voltagesV: { Out: [1, 3, 5], Ref: [1, 2, 3] }, currentsA: {} }] };

describe('differential voltage measurements', () => {
  it('reduces a differential ramp and finds crossings and delays', () => {
    const specs = [
      ...['min', 'max', 'avg', 'rms', 'pp', 'integ'].map(kind => ({ kind, analysis: 0, signal: 'v(oUt,rEf)' })),
      { kind: 'cross', analysis: 0, signal: 'v(out,ref)', value: 1.5 },
      { kind: 'when', analysis: 0, signal: 'v(out,ref)', value: 0.5 },
      { kind: 'delay', analysis: 0, trigger: { signal: 'v(out,ref)', threshold: 0.5 }, target: { signal: 'v(out,ref)', threshold: 1.5 } },
      { kind: 'avg', analysis: 0, signal: 'v(ref,out)' },
      { kind: 'avg', analysis: 0, signal: 'v(out,0)' },
      { kind: 'avg', analysis: 0, signal: 'v(out,missing)' },
    ];
    const results = measureResult(ramp, specs).measurements;
    const expected = [0, 2, 1, Math.sqrt(4 / 3), 2, 2, 1.5, 0.5, 1, -1, 3];
    expected.forEach((value, i) => expect(results[i]).toMatchObject({ value: expect.closeTo(value, 10) }));
    expect(results[11]).toMatchObject({ error: { code: 'UNKNOWN_SIGNAL', message: expect.stringContaining('missing') } });
    const invalid = ['v(out,)', 'v(out,ref,0)', 'i(out,ref)', 'v(out)+v(ref)'].map(signal => ({ kind: 'avg', analysis: 0, signal }));
    expect(measureResult(ramp, invalid).measurements).toMatchObject(invalid.map(() => ({ error: { code: 'UNKNOWN_SIGNAL' } })));
  });

  it('subtracts complex AC phasors before projection', () => {
    const p = (magnitude: number, phaseDegrees: number) => ({ magnitude, phaseDegrees });
    const result = { status: 'complete' as const, analyses: [{ type: 'ac' as const, analysisIndex: 0, frequencyHz: [1, 2], currentPhasors: {}, voltagePhasors: { out: [p(1, 0), p(1, 0)], opposite: [p(1, 180), p(1, 180)], same: [p(1, 0), p(1, 0)], quadrature: [p(1, 90), p(1, 90)] } }] };
    const specs = ['mag(v(out,opposite))', 'db(v(out,opposite))', 'mag(v(out,same))', 'phase(v(out,quadrature))', 'phase(v(quadrature,out))', 'phase(v(out,same))'].map(signal => ({ kind: 'avg', analysis: 0, signal }));
    const values = measureResult(result, specs).measurements;
    [2, 20 * Math.log10(2), 0, -45, 135].forEach((value, i) => expect(values[i]).toMatchObject({ value: expect.closeTo(value, 9) }));
    expect(values[5]).toMatchObject({ error: { code: 'NON_FINITE_RESULT' } });
  });

  it('measures AC differential voltages through the registered tool', async () => {
    const source = '* AC differential\nV1 out 0 DC 0 AC 1 0\nV2 ref 0 DC 0 AC 1 180\n.ac lin 2 1 2\n.end';
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source } }, measurements: ['mag(v(out,ref))', 'db(v(out,ref))', 'phase(v(out,ref))'].map(signal => ({ kind: 'avg', analysis: 0, signal })) });
    expect(response.structuredContent).toMatchObject({ measurements: [{ value: expect.closeTo(2, 8), unit: 'V' }, { value: expect.closeTo(20 * Math.log10(2), 8), unit: 'dB' }, { value: expect.closeTo(0, 8), unit: 'deg' }] });
  });

  it('works through the registered tool for OP and DC', async () => {
    const source = '* differential\nV1 out 0 4\nV2 ref 0 1\n.op\n.dc V1 2 4 1\n.end';
    const response = await executeTool('spice_measure', { request: { apiVersion: '1', input: { format: 'spice', source } }, measurements: [{ kind: 'avg', analysis: 0, signal: 'v(out,ref)' }, { kind: 'avg', analysis: 1, signal: 'v(out,ref)' }] });
    expect(response.structuredContent).toMatchObject({ measurements: [{ value: expect.closeTo(3, 8), unit: 'V' }, { value: expect.closeTo(2, 8), unit: 'V' }] });
  });
});
