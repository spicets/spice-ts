import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
function request(): SimulationRequestV1 {
  return { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out'], components: [component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('C', 'C1', ['out', '0'], { capacitance: 100e-9 })] }, analyses: [{ type: 'ac', variation: 'dec', points: 20, startFreq: 10, stopFreq: 100000, measurements: [{ name: 'gain', kind: 'find', vector: 'vm(out)', at: 1000 }] }] } } };
}

type Measurement = { name: string; kind: string; vector?: string; at?: number; [key: string]: unknown };
function configure(input: SimulationRequestV1, entries: Measurement[], variation = 'dec') {
  if (input.input.format !== 'spice-ts') throw new Error('native input required');
  Object.assign(input.input.document.analyses[0]!, { measurements: entries, variation });
}
const find = (name: string, vector: string, at: number): Measurement => ({ name, kind: 'find', vector, at });

it.each(['dec', 'lin', 'oct'])('matches core FIND semantics on %s grid, including an off-grid frequency', async variation => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request();
    configure(input, ['vm', 'vdb', 'vp'].map(v => find(v, `${v}(out)`, 1000)).concat([find('offgrid', 'vm(out)', 1234)]), variation);
    const actual = await engine.simulate(input, { requestId: 'find' });
    expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    if (!actual.ok) throw new Error(actual.error.message);
    const a = actual.data.analyses[0];
    const b = (await simulateProtocolV1(input)).analyses[0];
    if (a?.type !== 'ac' || b?.type !== 'ac' || !a.measurements || !b.measurements) throw new Error('expected AC measurements');
    expect(a.frequencyHz).toEqual(b.frequencyHz);
    for (const [i, value] of a.measurements.entries()) {
      expect(value.name).toBe(b.measurements[i]!.name);
      const reference = b.measurements[i]!;
      if (!('value' in value) || !('value' in reference)) throw new Error('expected finite scalar');
      expect(Number.isFinite(value.value)).toBe(true);
      expect(Math.abs(value.value - reference.value)).toBeLessThanOrEqual(1e-9);
    }
    const upper = a.frequencyHz.findIndex(frequency => frequency > 1234);
    expect(upper).toBeGreaterThan(0);
    const lo = upper - 1;
    const samples = a.voltagePhasors.out!;
    const interpolated = samples[lo]!.magnitude + (samples[upper]!.magnitude - samples[lo]!.magnitude) * (1234 - a.frequencyHz[lo]!) / (a.frequencyHz[upper]! - a.frequencyHz[lo]!);
    const offgrid = a.measurements[3]!;
    if (!('value' in offgrid)) throw new Error('expected off-grid scalar');
    expect(Math.abs(offgrid.value - interpolated)).toBeLessThanOrEqual(1e-9);
    if (variation === 'dec') {
      const expected = 1 / Math.sqrt(1 + (2 * Math.PI * 1000 * 1000 * 100e-9) ** 2);
      const magnitude = a.measurements[0]!;
      if (!('value' in magnitude)) throw new Error('expected magnitude');
      expect(Math.abs(magnitude.value - expected)).toBeLessThanOrEqual(1e-9);
      process.stdout.write(`RC scalar evidence ${JSON.stringify({ expected, wasm: a.measurements, core: b.measurements })}\n`);
    }
  } finally { await engine.close(); }
});

it('reports missing nodes and out-of-grid queries as measurement diagnostics', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request(); configure(input, [find('missing', 'vm(absent)', 1000), find('outside', 'vm(out)', 1e9)]);
    const result = await engine.simulate(input, { requestId: 'diagnostics' });
    expect(result).toMatchObject({ ok: true, data: { analyses: [{ measurements: [{ name: 'missing', diagnostic: { code: 'MEASUREMENT_FAILED' } }, { name: 'outside', diagnostic: { code: 'MEASUREMENT_FAILED' } }] }] } });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  } finally { await engine.close(); }
});

it('handles zero magnitude and nonfinite dB without leaking nonfinite values', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('expected native');
    input.input.document.circuit.components[0]!.params.magnitude = 0;
    configure(input, [find('zero', 'vm(out)', 1000), find('db', 'vdb(out)', 1000)]);
    const result = await engine.simulate(input, { requestId: 'zero' });
    const core = await simulateProtocolV1(input);
    if (!result.ok || result.data.analyses[0]?.type !== 'ac' || core.analyses[0]?.type !== 'ac') throw new Error('expected AC');
    process.stdout.write(`zero evidence ${JSON.stringify({ wasm: result.data.analyses[0].measurements, core: core.analyses[0].measurements })}\n`);
    expect(result.data.analyses[0].measurements?.[0]).toEqual({ name: 'zero', value: 0 });
    expect(result.data.analyses[0].measurements?.[1]).toMatchObject({ name: 'db', diagnostic: { code: 'MEASUREMENT_FAILED' } });
    expect(result).toMatchObject({ ok: true, data: { analyses: [{ measurements: core.analyses[0]!.type === 'ac' ? core.analyses[0].measurements : [] }] } });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  } finally { await engine.close(); }
});

it('rejects invalid measurements at validation and simulation boundaries', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const valid = find('x', 'vm(out)', 1000);
    const cases: [Measurement[], string][] = [
      [[valid, { ...valid, name: 'X' }], '/1/name'],
      ...[-1, NaN, Infinity].map(at => [[{ ...valid, at }], '/0/at'] as [Measurement[], string]),
      [[{ ...valid, extra: 1 }], '/0/extra'],
      [[{ ...valid, when: { vector: 'vm(out)', value: 0.5 } }], '/0'],
      [[{ ...valid, vector: 'v(out)' }], '/0/vector'],
      [[{ name: 'x', kind: 'find', vector: 'vm(out)' }], '/0'],
    ];
    for (const [entries, suffix] of cases) for (const execute of [engine.validate.bind(engine), engine.simulate.bind(engine)]) {
      const input = request(); configure(input, entries);
      const result = await execute(input, { requestId: 'invalid' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
      if (!result.ok && result.error.details?.path) expect(result.error.details.path).toBe(`/input/document/analyses/0/measurements${suffix}`);
    }
  } finally { await engine.close(); }
});

it('explicitly rejects unsupported aggregate and WHEN measurements', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const entry of [{ name: 'avg', kind: 'avg', vector: 'vm(out)' }, { name: 'crossing', kind: 'find', vector: 'vm(out)', when: { vector: 'vm(out)', value: 0.5 } }]) {
      const input = request(); configure(input, [entry]);
      for (const execute of [engine.validate.bind(engine), engine.simulate.bind(engine)]) expect(await execute(input, { requestId: 'unsupported' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
    }
  } finally { await engine.close(); }
});
