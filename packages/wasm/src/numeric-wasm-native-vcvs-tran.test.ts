import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, unknown>, named = false) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: named && type === 'E' ? ['outP', 'outN', 'ctrlP', 'ctrlN'][i]! : String(i), net })), params,
});

function request(): SimulationRequestV1 {
  return { apiVersion: '1', input: { format: 'spice-ts', document: {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in', 'drive', 'out'], components: [
      component('V', 'V1', ['in', '0'], { dc: 1 }),
      component('E', 'E1', ['drive', '0', 'in', '0'], { gain: 2 }, true),
      component('R', 'R1', ['drive', 'out'], { resistance: 1000 }),
      component('C', 'C1', ['out', '0'], { capacitance: 1e-6 }),
    ] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001, maxTimestep: 1e-5 }],
  } } } as SimulationRequestV1;
}

it('validates and simulates a native VCVS-driven RC transient', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native required');
    const analysis = input.input.document.analyses[0]!;
    if (analysis.type !== 'tran') throw new Error('transient required');
    delete analysis.maxTimestep;
    const validation = await engine.validate(input, { requestId: 'validate' });
    expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
    const result = await engine.simulate(input, { requestId: 'simulate' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
  } finally { await engine.close(); }
});


const waveforms = [
  ['dc', { dc: 1 }, 'DC 1'],
  ['pulse', { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 0.0001, fall: 0.0001, width: 0.0003, period: 0.0008 }, 'PULSE(0 1 0 100u 100u 300u 800u)'],
  ['sin', { waveform: 'sin', offset: 0, amplitude: 1, frequency: 1000 }, 'SIN(0 1 1000)'],
] as const;

it.each(waveforms.flatMap(([waveform, params, source]) => [2, -2, 0].flatMap(gain => (waveform === 'sin' ? [false, true] : [false]).map(rlc => ({ waveform, params, source, gain, rlc })))))('matches text WASM and core for $waveform gain $gain RLC=$rlc', async ({ waveform, params, source, gain, rlc }) => {
  const input = request();
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  const components = input.input.document.circuit.components;
  components[0]!.params = { ...params };
  components[1]!.params = { gain };
  // Core positional E ports are control pair followed by output pair.
  if (gain < 0) components[1] = component('E', 'E1', ['in', '0', 'drive', '0'], { gain }) as typeof components[number];
  if (rlc) {
    components.push(component('L', 'L1', ['out', '0'], { inductance: 0.1 }) as typeof components[number]);
  }
  const deck = `V1 in 0 ${source}\nE1 drive 0 in 0 ${gain}\nR1 drive out 1000\nC1 out 0 1u\n${rlc ? 'L1 out 0 0.1\n' : ''}.tran 10u 1m 0 10u`;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(engine.capabilities.numericWasm?.fallback).toBe('reject');
    expect(await engine.validate(input, { requestId: 'validate' })).toMatchObject({ ok: true });
    const native = await engine.simulate(input, { requestId: 'native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: deck } }, { requestId: 'text' });
    const core = await simulateProtocolV1(input);
    if (!native.ok || !text.ok) throw new Error(JSON.stringify({ native, text }));
    expect(native.metadata.backend).toBe('spice-ts-wasm');
    const actual = native.data.analyses[0];
    const references = [text.data.analyses[0], core.analyses[0]];
    if (actual?.type !== 'tran') throw new Error('transient required');
    expect(actual.currentsA.E1).toBeDefined();
    expect(actual.currentsA.V1).toBeDefined();
    if (gain !== 0) expect(Math.max(...actual.voltagesV.drive!.map(Math.abs))).toBeGreaterThan(0.1);
    for (const [index, reference] of references.entries()) {
      if (reference?.type !== 'tran') throw new Error('reference transient required');
      let count = 0, matched = 0, max = 0, squared = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
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
      process.stdout.write(`VCVS parity ${JSON.stringify({ waveform, gain, rlc, reference: index ? 'core' : 'text', actualPoints: actual.timeS.length, referencePoints: reference.timeS.length, matched, count, max, rms: Math.sqrt(squared / count) })}\n`);
    }
  } finally { await engine.close(); }
});

it('rejects invalid VCVS inputs and unsupported controlled sources with structured errors', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const variant of ['ports', 'net', 'gain-nan', 'gain-infinity', 'H'] as const) {
      const input = request();
      if (input.input.format !== 'spice-ts') throw new Error('native required');
      const e = input.input.document.circuit.components[1]!;
      if (variant === 'ports') e.ports.pop();
      else if (variant === 'net') e.ports[2]!.net = 'missing';
      else if (variant === 'gain-nan') e.params.gain = NaN;
      else if (variant === 'gain-infinity') e.params.gain = Infinity;
      else e.type = variant;
      const code = ['H'].includes(variant) ? 'UNSUPPORTED_FEATURE' : variant.startsWith('gain-') ? 'INVALID_REQUEST' : 'INVALID_CIRCUIT';
      for (const result of [await engine.validate(input, { requestId: variant }), await engine.simulate(input, { requestId: variant })]) {
        expect(result, `${variant}: ${JSON.stringify(result)}`).toMatchObject({ ok: false, error: { code, phase: 'validation' } });
      }
    }
  } finally { await engine.close(); }
}, 30000);
