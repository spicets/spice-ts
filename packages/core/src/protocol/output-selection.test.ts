import { describe, expect, it } from 'vitest';
import { executeProtocolV1, operatingPointReportProtocolV1, simulateNoiseProtocolV1, simulatePoleZeroProtocolV1, simulateProtocolV1, validateProtocolV1 } from '../index.js';
import type { AnalysisResultV1, SimulationRequestV1 } from './types.js';

const circuit = 'V1 in 0 DC 2 AC 1\nR1 in out 1k\nR2 out 0 1k\nC1 out 0 1u\n';
const request = (analysis: string, outputs?: string[]): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source: circuit + analysis }, ...(outputs === undefined ? {} : { outputs }),
});

describe('protocol output selection', () => {
  it('returns only the requested voltage and source current', async () => {
    const result = await simulateProtocolV1(request('.op', ['v(out)', 'i(V1)']));
    expect(result.analyses).toEqual([{ type: 'op', analysisIndex: 0, voltagesV: { out: 1 }, currentsA: { V1: -0.001 } }]);
  });

  it.each([
    ['op', '.op'],
    ['dc', '.dc V1 0 2 1'],
    ['tran', '.tran 0.0001 0.001'],
    ['ac', '.ac lin 3 100 300'],
    ['step', '.step param R2 list 1k 2k\n.op'],
  ])('preserves every other field and selected values for %s', async (_label, analysis) => {
    const full = await simulateProtocolV1(request(analysis));
    const callbacks: AnalysisResultV1[] = [];
    const filtered = await simulateProtocolV1(request(analysis, ['V(OUT)', 'I(v1)']), { onAnalysisComplete: value => callbacks.push(value) });
    const expected = full.analyses.map(item => {
      if (item.type === 'tf') throw new Error('unexpected tf');
      if (item.type === 'ac') return { ...item, voltagePhasors: { out: item.voltagePhasors.out }, currentPhasors: { V1: item.currentPhasors.V1 } };
      return { ...item, voltagesV: { out: item.voltagesV.out }, currentsA: { V1: item.currentsA.V1 } };
    });
    expect(filtered.analyses).toEqual(expected);
    expect(callbacks).toEqual(expected);
    expect(full.analyses.length).toBeGreaterThan(0);
  });

  it.each([
    [[], '/outputs'],
    [Array(65).fill('v(out)'), '/outputs'],
    [[''], '/outputs/0'],
    [['v(out)\n'], '/outputs/0'],
    [['v(out, in)'], '/outputs/0'],
    [['v(' + 'a'.repeat(254) + ')'], '/outputs/0'],
    [['v(missing)'], '/outputs/0'],
    [['i(missing)'], '/outputs/0'],
    [['v(out)', 'i(R1)'], '/outputs/1'],
    [null, '/outputs'],
    [['v(out)', 7], '/outputs/1'],
  ])('rejects invalid selections with a source path', async (outputs, path) => {
    const input = { ...request('.op'), outputs } as unknown as SimulationRequestV1;
    const result = await executeProtocolV1(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', details: { path } });
    await expect(validateProtocolV1(input)).rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', details: { path } } });
  });

  it('accepts the 64-selector limit and rejects sparse runtime arrays', async () => {
    const selected = await simulateProtocolV1(request('.op', Array(64).fill('v(out)')));
    expect(selected.analyses[0]).toMatchObject({ voltagesV: { out: 1 }, currentsA: {} });
    await expect(validateProtocolV1(request('.op', Array(1)))).rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', details: { path: '/outputs/0' } } });
  });

  it('rejects selectors for specialized analyses', async () => {
    const result = await executeProtocolV1(request('.tf v(out) V1', ['v(out)']));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatchObject({ code: 'INVALID_REQUEST', details: { path: '/outputs' } });
  });

  it('rejects selectors for noise instead of ignoring them', async () => {
    const input = request('.noise v(out) V1 dec 1 10 100', ['v(out)']);
    const result = await executeProtocolV1(input);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: '/outputs' } } });
    await expect(simulateNoiseProtocolV1(input)).rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', details: { path: '/outputs' } } });
  });

  it('rejects selectors in other specialized entrypoints', async () => {
    const input = request('.op', ['v(out)']);
    for (const execute of [operatingPointReportProtocolV1, simulatePoleZeroProtocolV1]) {
      await expect(execute(input)).rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', details: { path: '/outputs' } } });
    }
  });

  it('preserves native measurements even when their vector is not selected', async () => {
    const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
    const input: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: {
      format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
      circuit: { nets: ['in', 'out'], components: [
        component('V', 'V1', ['in', '0'], { dc: 2 }),
        component('R', 'R1', ['in', 'out'], { resistance: 1000 }),
        component('R', 'R2', ['out', '0'], { resistance: 1000 }),
      ] },
      analyses: [{ type: 'dc', source: 'V1', start: 0, stop: 2, step: 1,
        measurements: [{ name: 'peak', kind: 'max', vector: 'v(out)' }] }],
    } } };
    const full = await simulateProtocolV1(input);
    const selected = await executeProtocolV1({ ...input, outputs: ['i(v1)'] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error('expected success');
    const before = full.analyses[0];
    const after = selected.data.analyses[0];
    if (before?.type !== 'dc' || after?.type !== 'dc') throw new Error('expected DC');
    expect(before.measurements).toEqual([{ name: 'peak', value: 1 }]);
    expect(after.measurements).toEqual(before.measurements);
    expect(after.voltagesV).toEqual({});
    expect(after.axis).toEqual(before.axis);
  });

  it('does not bypass the unfiltered serialized result limit', async () => {
    const base = request('.op');
    const full = await simulateProtocolV1(base);
    const size = new TextEncoder().encode(JSON.stringify(full)).length;
    const selected = { ...base, outputs: ['v(out)'], options: { limits: { maxSerializedResultBytes: size - 1 } } };
    const result = await executeProtocolV1(selected);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatchObject({ code: 'RESOURCE_LIMIT', phase: 'serialize' });
  });
});
