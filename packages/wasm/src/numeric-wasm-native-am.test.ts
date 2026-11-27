import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

type Params = Record<string, unknown>;
const component = (type: string, name: string, a: string, b: string, params: Params) => ({ type, name, id: name, ports: [{ name: '0', net: a }, { name: '1', net: b }], params });
function native(kind: 'V' | 'I', params: Params): SimulationRequestV1 {
  const source = component(kind, `${kind}1`, kind === 'V' ? 'in' : '0', kind === 'V' ? '0' : 'in', { waveform: 'am', ...params });
  const components = kind === 'V' ? [source, component('R', 'R1', 'in', 'out', { resistance: 1000 }), component('C', 'C1', 'out', '0', { capacitance: 1e-7 })]
    : [source, component('V', 'Vprobe', 'in', 'out', { dc: 0 }), component('R', 'R1', 'out', 'mid', { resistance: 100 }), component('L', 'L1', 'mid', '0', { inductance: 0.01 })];
  return { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out', 'mid'], components }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.002 }] } } } as SimulationRequestV1;
}
function text(kind: 'V' | 'I', args: string, dc = ''): SimulationRequestV1 {
  const deck = kind === 'V' ? `V1 in 0 ${dc} AM(${args})\nR1 in out 1000\nC1 out 0 1e-7` : `I1 0 in ${dc} AM(${args})\nVprobe in out 0\nR1 out mid 100\nL1 mid 0 0.01`;
  return { apiVersion: '1', input: { format: 'spice', source: `${deck}\n.tran 1e-5 0.002` } };
}
const cases = [
  { name: 'modulated', params: { offset: 0.2, carrierAmplitude: 1, modulationAmplitude: 0.5, modulationFrequency: 100, carrierFrequency: 1000 }, args: '0.2 1 0.5 100 1000' },
  { name: 'zero modulation', params: { offset: 0.2, carrierAmplitude: 1, modulationAmplitude: 0, modulationFrequency: 100, carrierFrequency: 1000 }, args: '0.2 1 0 100 1000' },
  { name: 'defaults', params: { offset: 0.2, carrierAmplitude: 1 }, args: '0.2 1' },
  { name: 'delay and phases', params: { offset: 0.2, carrierAmplitude: 1, modulationAmplitude: 0.5, modulationFrequency: 100, carrierFrequency: 1000, delay: 0.0002, modulationPhase: 30, carrierPhase: 45 }, args: '0.2 1 0.5 100 1000 0.0002 30 45', dc: '' },
];

it.each(cases.flatMap(c => (['V', 'I'] as const).map(kind => ({ ...c, kind }))))('$kind $name matches WASM text, core and source formula', async ({ kind, params, args, dc }) => {
  const request = native(kind, params);
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(engine.capabilities.numericWasm?.fallback).toBe('reject');
    const result = await engine.simulate(request, { requestId: 'native' });
    const reference = await engine.simulate(text(kind, args, dc), { requestId: 'text' });
    const core = await simulateProtocolV1(request);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if (!reference.ok) throw new Error(JSON.stringify(reference.error));
    expect(result.metadata.backend).toBe('spice-ts-wasm');
    const a = result.data.analyses[0], b = reference.data.analyses[0], c = core.analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran' || c?.type !== 'tran') throw new Error('transient required');
    expect(a.timeS.length).toBeGreaterThan(10);
    expect(a.timeS.every(Number.isFinite)).toBe(true);
    for (const [label, ref] of [['text', b], ['core', c]] as const) {
      const pairs = a.timeS.map((t, i) => {
        const j = ref.timeS.reduce((best, x, k) => Math.abs(x - t) < Math.abs(ref.timeS[best]! - t) ? k : best, 0);
        return [i, j] as const;
      }).filter(([i, j]) => Math.abs(a.timeS[i]! - ref.timeS[j]!) <= 1e-13);
      expect(pairs.length).toBeGreaterThan(10);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(ref[field]).sort());
        for (const [name, values] of Object.entries(a[field])) {
          const expected = ref[field][name]!;
          expect(values.length).toBe(a.timeS.length);
          expect(values.every(Number.isFinite)).toBe(true);
          const scale = Math.max(...pairs.map(([, j]) => Math.abs(expected[j]!)), 1e-30);
          const errors = pairs.map(([i, j]) => Math.abs(values[i]! - expected[j]!) / scale);
          const max = Math.max(...errors), rms = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
          process.stdout.write(`AM ${kind} ${args} ${label} ${field}.${name} n=${errors.length} max=${max} rms=${rms}\n`);
          if (max > 0.01) { const k = errors.indexOf(max); const [i, j] = pairs[k]!; process.stdout.write(`MISMATCH t=${a.timeS[i]} rt=${ref.timeS[j]} actual=${values[i]} expected=${expected[j]}\n`); }
          expect(max).toBeLessThanOrEqual(0.01);
        }
      }
    }
    const p = params as { offset: number; carrierAmplitude: number; modulationAmplitude?: number; modulationFrequency?: number; carrierFrequency?: number; delay?: number; modulationPhase?: number; carrierPhase?: number };
    const carrier = p.carrierFrequency ?? 500 / 0.002, signal = p.modulationFrequency ?? 5 / 0.002;
    const source = kind === 'V' ? a.voltagesV.in! : a.currentsA.Vprobe!;
    for (let i = 1; i < a.timeS.length; i++) {
      const t = a.timeS[i]! - (p.delay ?? 0);
      const value = t <= 0 ? 0 : p.offset + (p.carrierAmplitude + (p.modulationAmplitude ?? 1) * Math.sin(2 * Math.PI * signal * t + (p.modulationPhase ?? 0) * Math.PI / 180)) * Math.sin(2 * Math.PI * carrier * t + (p.carrierPhase ?? 0) * Math.PI / 180);
      expect(source[i]!, `formula at ${a.timeS[i]}`).toBeCloseTo(value, 7);
    }
  } finally { await engine.close(); }
}, 30000);

it.each(['V', 'I'] as const)('matches core with explicit AM DC for %s', async kind => {
  const request = native(kind, { offset: 0.2, carrierAmplitude: 1, dc: 0.3 });
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const result = await engine.simulate(request, { requestId: 'dc' });
    const core = await simulateProtocolV1(request);
    if (!result.ok || result.data.analyses[0]?.type !== 'tran' || core.analyses[0]?.type !== 'tran') throw new Error('transient required');
    const a = result.data.analyses[0], b = core.analyses[0];
    const actual = kind === 'V' ? a.voltagesV.in![0]! : a.currentsA.Vprobe![0]!;
    const expected = kind === 'V' ? b.voltagesV.in![0]! : b.currentsA.Vprobe![0]!;
    process.stdout.write(`AM ${kind} explicit dc initial actual=${actual} core=${expected}\n`);
    expect(actual).toBeCloseTo(expected, 7);
  } finally { await engine.close(); }
}, 30000);

it.each(['V', 'I'] as const)('rejects malformed %s AM inputs with structured errors', async kind => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const run = async (params: Params, ports?: Array<{ name: string; net: string }>) => {
      const request = native(kind, params);
      if (request.input.format !== 'spice-ts') throw new Error('native required');
      if (ports) request.input.document.circuit.components[0]!.ports = ports;
      return engine.simulate(request, { requestId: 'invalid' });
    };
    for (const field of ['offset', 'carrierAmplitude', 'modulationAmplitude', 'modulationFrequency', 'carrierFrequency', 'delay', 'modulationPhase', 'carrierPhase', 'dc']) {
      for (const value of ['bad', NaN, Infinity, -Infinity]) {
        expect(await run({ offset: 0, carrierAmplitude: 1, [field]: value }), `${field}=${value}`).toMatchObject({ ok: false, error: { code: typeof value === 'number' ? 'INVALID_REQUEST' : 'INVALID_CIRCUIT', phase: 'validation' } });
      }
    }
    for (const params of [{ carrierAmplitude: 1 }, { offset: 0 }]) expect(await run(params)).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
    for (const ports of [[{ name: '0', net: 'in' }], [{ name: '0', net: 'in' }, { name: '0', net: '0' }], [{ name: '0', net: 'missing' }, { name: '1', net: '0' }]]) {
      expect(await run({ offset: 0, carrierAmplitude: 1 }, ports)).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
    }
    for (const field of ['v1', 'rise', 'frequency', 'phase', 'damping', 'amplitude', 'modulationIndex', 'signalFrequency', 'signalPhase', 'points', 'repeat', 'td1', 'tau1']) {
      expect(await run({ offset: 0, carrierAmplitude: 1, [field]: 1 }), field).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation' } });
    }
    const mixed = native(kind, { offset: 0, carrierAmplitude: 1, carrierFrequency: 1000 });
    if (mixed.input.format !== 'spice-ts') throw new Error('native required');
    mixed.input.document.circuit.components[0]!.params.waveform = 'sin';
    expect(await engine.simulate(mixed, { requestId: 'mixed' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
  } finally { await engine.close(); }
}, 30000);
