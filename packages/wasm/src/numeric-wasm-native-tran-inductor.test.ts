import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, unknown>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
const request = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out'], components: [component('V', 'V1', ['in', '0'], { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 0.0001, fall: 0.0001, width: 0.01, period: 0.02 }), component('R', 'R1', ['in', 'out'], { resistance: 100 }), component('L', 'L1', ['out', '0'], { inductance: 0.1 })] }, analyses: [{ type: 'tran', timestep: 0.00001, stopTime: 0.003 }] } } } as SimulationRequestV1;

it('runs an ordinary native RL pulse transient on WASM', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const result = await engine.simulate(request, { requestId: 'rl' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
  } finally { await engine.close(); }
});

const sources = [
  ['dc', { dc: 1 }, 'DC 1'],
  ['pulse', { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 0.0001, fall: 0.0001, width: 0.01, period: 0.02 }, 'PULSE(0 1 0 100u 100u 10m 20m)'],
  ['sin', { waveform: 'sin', offset: 0, amplitude: 1, frequency: 1000 }, 'SIN(0 1 1000)'],
  ['exp', { waveform: 'exp', v1: 0, v2: 1, td1: 0.0001, tau1: 0.0002, td2: 0.002, tau2: 0.0002 }, 'EXP(0 1 100u 200u 2m 200u)'],
] as const;

it.each(sources.flatMap(([waveform, params, source]) => (['V', 'I'] as const).map(kind => ({ waveform, params, source, kind }))))('compares native, text WASM and core for $waveform $kind RLC', async ({ waveform, params, source, kind }) => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  input.input.document.circuit.components[0] = component(kind, `${kind}1`, kind === 'V' ? ['in', '0'] : ['0', 'in'], { ...params }) as typeof input.input.document.circuit.components[number];
  input.input.document.circuit.components[1]!.params = { resistance: 1000 };
  input.input.document.circuit.components.push(component('C', 'C1', ['out', '0'], { capacitance: 1e-6 }) as typeof input.input.document.circuit.components[number]);
  const deck = `${kind}1 ${kind === 'V' ? 'in 0' : '0 in'} ${source}\nR1 in out 1000\nL1 out 0 0.1\nC1 out 0 0.000001\n.tran 0.00001 0.003`;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(engine.capabilities.numericWasm?.fallback).toBe('reject');
    const native = await engine.simulate(input, { requestId: 'native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: deck } }, { requestId: 'text' });
    const core = await simulateProtocolV1(input);
    if (!native.ok || !text.ok) throw new Error(JSON.stringify({ native, text }));
    expect(native.metadata.backend).toBe('spice-ts-wasm');
    const a = native.data.analyses[0], b = text.data.analyses[0], c = core.analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran' || c?.type !== 'tran') throw new Error('transient required');
    expect(a.timeS).toEqual(b.timeS);
    expect(a.timeS.length).toBeGreaterThan(10);
    let textMax = 0, textSquared = 0, coreMax = 0, coreSquared = 0, count = 0, coreCount = 0, matched = 0;
    for (const field of ['voltagesV', 'currentsA'] as const) {
      expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
      expect(Object.keys(a[field]).sort()).toEqual(Object.keys(c[field]).sort());
    }
    for (let i = 0; i < a.timeS.length; i++) {
      const j = c.timeS.findIndex(t => Math.abs(t - a.timeS[i]!) <= 1e-13);
      if (j >= 0) matched++;
      for (const field of ['voltagesV', 'currentsA'] as const) for (const [name, values] of Object.entries(a[field])) {
        const x = values[i]!, y = b[field][name]![i]!;
        expect(Number.isFinite(x)).toBe(true);
        const e = Math.abs(x - y); textMax = Math.max(textMax, e); textSquared += e * e; count++;
        expect(e, `${field}.${name}[${i}]`).toBeLessThanOrEqual(1e-10 + 1e-8 * Math.abs(y));
        if (j >= 0) { const d = Math.abs(x - c[field][name]![j]!); coreMax = Math.max(coreMax, d); coreSquared += d * d; coreCount++; }
      }
    }
    expect(matched).toBeGreaterThan(1);
    expect(a.currentsA.L1).toBeDefined();
    if (waveform === 'pulse' && kind === 'V') {
      expect(Math.max(...a.voltagesV.out!)).toBeGreaterThan(0.1);
      expect(Math.min(...a.voltagesV.out!)).toBeLessThan(-0.05);
    }
    if (waveform === 'sin' || waveform === 'exp') expect(coreMax).toBeLessThan(1e-8);
    process.stdout.write(`inductor parity ${JSON.stringify({ waveform, kind, samples: a.timeS.length, matched, textMax, textRms: Math.sqrt(textSquared / count), coreMax, coreRms: Math.sqrt(coreSquared / coreCount) })}\n`);
  } finally { await engine.close(); }
});

it('matches RL steady state and finite-rise analytical step and signed current', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const dc of [false, true]) {
      const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
      if (dc) input.input.document.circuit.components[0]!.params = { dc: -1 };
      const result = await engine.simulate(input, { requestId: 'analytic' });
      if (!result.ok || result.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify(result));
      const a = result.data.analyses[0];
      const t = a.timeS.at(-1)!, tau = 0.001, rise = 0.0001;
      const expected = dc ? -0.01 : (1 - (tau / rise) * (Math.exp(-(t - rise) / tau) - Math.exp(-t / tau))) / 100;
      const actual = a.currentsA.L1!.at(-1)!;
      process.stdout.write(`inductor analytical ${JSON.stringify({ dc, t, expected, actual, error: Math.abs(actual - expected) })}\n`);
      expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
      if (dc) expect(actual).toBeLessThan(0);
    }
  } finally { await engine.close(); }
});

it('rejects invalid inductors, missing nets, models and coupling, and enforces limits', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const value of [0, -1, NaN, Infinity, -Infinity, 'bad', undefined]) {
      const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
      Object.assign(input.input.document.circuit.components[2]!.params, { inductance: value });
      expect(await engine.simulate(input, { requestId: 'invalid' }), `inductance=${value}`).toMatchObject({ ok: false });
    }
    for (const variant of ['net', 'model', 'coupling'] as const) {
      const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
      const l = input.input.document.circuit.components[2]!;
      if (variant === 'net') l.ports[0]!.net = 'missing';
      if (variant === 'model') Object.assign(l, { model: 'm' });
      if (variant === 'coupling') input.input.document.circuit.components.push(component('K', 'K1', ['out', '0'], { coupling: 0.5 }) as typeof input.input.document.circuit.components[number]);
      expect(await engine.simulate(input, { requestId: variant }), variant).toMatchObject({ ok: false });
    }
    const large = structuredClone(request); if (large.input.format !== 'spice-ts') throw new Error('native');
    const nets = Array.from({ length: 65 }, (_, i) => `n${i}`);
    large.input.document.circuit.nets = nets;
    large.input.document.circuit.components = nets.map((net, i) => component('L', `L${i}`, [net, '0'], { inductance: 0.1 })) as typeof large.input.document.circuit.components;
    expect(await engine.simulate(large, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder' } } });
  } finally { await engine.close(); }
});
