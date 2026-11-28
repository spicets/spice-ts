import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number | string>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: (type === 'G' ? ['outP', 'outN', 'ctrlP', 'ctrlN'] : ['p', 'n'])[i]!, net })), params,
});
const waves = [
  ['dc', { dc: 3 }, 'DC 3'],
  ['pulse', { waveform: 'pulse', v1: 0, v2: 3, delay: 0, rise: 0.0001, fall: 0.0001, width: 0.0003, period: 0.0008 }, 'PULSE(0 3 0 100u 100u 300u 800u)'],
  ['sin', { waveform: 'sin', offset: 1, amplitude: 2, frequency: 1000 }, 'SIN(1 2 1000)'],
] as const;
function request(params: Record<string, number | string> = { dc: 3 }, gm = 0.001, reversed = false, rc = true): SimulationRequestV1 {
  const doc: SpiceTsCircuitDocumentV1 = { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'ref', 'out', 'other'], components: [
    component('V', 'V1', ['in', '0'], params), component('V', 'V2', ['ref', '0'], { dc: 1 }),
    component('G', 'G1', reversed ? ['other', 'out', 'in', 'ref'] : ['out', 'other', 'in', 'ref'], { gm }),
    component('R', 'R1', ['out', '0'], { resistance: 1000 }), component('R', 'R2', ['other', '0'], { resistance: 2000 }),
    ...(rc ? [component('C', 'C1', ['out', '0'], { capacitance: 1e-6 })] : []),
  ] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001, maxTimestep: 1e-5 }] };
  return { apiVersion: '1', input: { format: 'spice-ts', document: doc } };
}
const deck = (source: string, gm: number, reversed: boolean, rc: boolean) => `V1 in 0 ${source}\nV2 ref 0 DC 1\nG1 ${reversed ? 'other out' : 'out other'} in ref ${gm}\nR1 out 0 1000\nR2 other 0 2000\n${rc ? 'C1 out 0 1u\n' : ''}.tran 10u 1m 0 10u`;

it.each(waves.flatMap(([wave, params, source]) => [0.001, -0.001, 0].flatMap(gm => [false, true].map(reversed => ({ wave, params, source, gm, reversed })))))('matches complete text WASM and core traces: $wave gm=$gm reversed=$reversed', async ({ wave, params, source, gm, reversed }) => {
  const input = request(params, gm, reversed);
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(engine.capabilities.numericWasm?.fallback).toBe('reject');
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: deck(source, gm, reversed, true) } }, { requestId: 'text' });
    expect(text, JSON.stringify(text)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    const core = await simulateProtocolV1(input);
    const native = await engine.simulate(input, { requestId: 'native' });
    expect(native, JSON.stringify(native)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    if (!native.ok || !text.ok) throw new Error('simulation failed');
    const actual = native.data.analyses[0];
    if (actual?.type !== 'tran') throw new Error('transient required');
    for (const [index, reference] of [text.data.analyses[0], core.analyses[0]].entries()) {
      if (reference?.type !== 'tran') throw new Error('reference transient required');
      for (const field of ['voltagesV', 'currentsA'] as const) expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
      let matched = 0, max = 0, count = 0, squared = 0;
      for (const [i, time] of actual.timeS.entries()) {
        const j = reference.timeS.findIndex(t => Math.abs(t - time) < 1e-14);
        if (j < 0) continue;
        matched++;
        for (const field of ['voltagesV', 'currentsA'] as const) for (const [name, values] of Object.entries(actual[field])) {
          const x = values[i]!, y = reference[field][name]![j]!;
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          const error = Math.abs(x - y) / Math.max(Math.abs(y), 1e-9);
          max = Math.max(max, error); squared += error * error; count++;
          expect(error, `${field}.${name} at ${time}`).toBeLessThanOrEqual(0.01);
        }
      }
      expect(matched).toBeGreaterThan(10);
      expect(matched).toBe(actual.timeS.length);
      expect(matched).toBe(reference.timeS.length);
      process.stdout.write(`VCCS parity ${JSON.stringify({ wave, gm, reversed, reference: index ? 'core' : 'text', matched, count, max, rms: Math.sqrt(squared / count) })}\n`);
    }
  } finally { await engine.close(); }
}, 30000);


it.each([0.001, -0.001, 0])('matches the resistive DC analytic control at gm=%s without maxTimestep', async gm => {
  const input = request({ dc: 3 }, gm, false, false);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  const analysis = input.input.document.analyses[0]!;
  if (analysis.type !== 'tran') throw new Error('transient required');
  delete analysis.maxTimestep;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(await engine.validate(input, { requestId: 'validate' })).toMatchObject({ ok: true });
    const result = await engine.simulate(input, { requestId: 'analytic' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    if (!result.ok || result.data.analyses[0]?.type !== 'tran') throw new Error('transient required');
    const actual = result.data.analyses[0];
    for (const value of actual.voltagesV.out!) expect(Math.abs(value - (-2 * gm * 1000)) / Math.max(1, Math.abs(2 * gm * 1000))).toBeLessThanOrEqual(1e-9);
    for (const value of actual.voltagesV.other!) expect(Math.abs(value - (2 * gm * 2000)) / Math.max(1, Math.abs(2 * gm * 2000))).toBeLessThanOrEqual(1e-9);
    process.stdout.write(`VCCS analytic ${JSON.stringify({ gm, out: actual.voltagesV.out![0], other: actual.voltagesV.other![0], v1Current: actual.currentsA.V1![0], v2Current: actual.currentsA.V2![0], gCurrent: gm * 2 })}\n`);
  } finally { await engine.close(); }
});

it('rejects malformed G and unsupported transient combinations with structured errors', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const variant of ['missing-port', 'extra-port', 'duplicate-port', 'mixed-port', 'missing-net', 'empty-net', 'missing-gm', 'nan', 'infinity', 'extra-param', 'model', 'H'] as const) {
      const input = request();
      if (input.input.format !== 'spice-ts') throw new Error('native required');
      const g = input.input.document.circuit.components[2]!;
      if (variant === 'missing-port') g.ports.pop();
      else if (variant === 'extra-port') g.ports.push({ name: 'extra', net: '0' });
      else if (variant === 'duplicate-port') g.ports[2]!.name = 'outP';
      else if (variant === 'mixed-port') g.ports[2]!.name = 'other';
      else if (variant === 'missing-net') g.ports[2]!.net = 'missing';
      else if (variant === 'empty-net') g.ports[2]!.net = '';
      else if (variant === 'missing-gm') delete g.params.gm;
      else if (variant === 'nan') g.params.gm = NaN;
      else if (variant === 'infinity') g.params.gm = Infinity;
      else if (variant === 'extra-param') g.params.extra = 1;
      else if (variant === 'model') g.model = 'unknown';
      else g.type = variant;
      const code = ['nan', 'infinity'].includes(variant) ? 'INVALID_REQUEST' : ['extra-param', 'model', 'H'].includes(variant) ? 'UNSUPPORTED_FEATURE' : 'INVALID_CIRCUIT';
      for (const execute of [engine.validate.bind(engine), engine.simulate.bind(engine)]) {
        const result = await execute(input, { requestId: variant });
        expect(result, `${variant}: ${JSON.stringify(result)}`).toMatchObject({ ok: false, error: { code, phase: 'validation' } });
      }
    }
  } finally { await engine.close(); }
}, 30000);


it.each(waves.slice(0, 2))('matches text WASM on the fixed-step %s RC path', async (_wave, params, source) => {
  const input = request(params);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  const analysis = input.input.document.analyses[0]!;
  if (analysis.type !== 'tran') throw new Error('transient required');
  delete analysis.maxTimestep;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const native = await engine.simulate(input, { requestId: 'fixed-native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: deck(source, 0.001, false, true).replace('.tran 10u 1m 0 10u', '.tran 10u 1m') } }, { requestId: 'fixed-text' });
    if (!native.ok || !text.ok) throw new Error(JSON.stringify({ native, text }));
    expect(native.metadata.backend).toBe('spice-ts-wasm');
    const actual = native.data.analyses[0], reference = text.data.analyses[0];
    if (actual?.type !== 'tran' || reference?.type !== 'tran') throw new Error('transient required');
    expect(actual.timeS.length).toBe(reference.timeS.length);
    for (const [i, time] of actual.timeS.entries()) expect(Math.abs(time - reference.timeS[i]!)).toBeLessThan(1e-14);
    for (const field of ['voltagesV', 'currentsA'] as const) {
      expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
      for (const [name, values] of Object.entries(actual[field])) for (const [i, value] of values.entries()) {
        expect(Math.abs(value - reference[field][name]![i]!) / Math.max(Math.abs(reference[field][name]![i]!), 1e-9)).toBeLessThanOrEqual(0.01);
      }
    }
  } finally { await engine.close(); }
});
