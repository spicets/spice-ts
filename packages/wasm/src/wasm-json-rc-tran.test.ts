import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out'], components: [component('V', 'V1', ['in', '0'], { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 1e-6, fall: 1e-6, width: 0.001, period: 0.002 }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('C', 'C1', ['out', '0'], { capacitance: 1e-6 })] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }] } } };

it('runs a native RC pulse in WASM', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const result = await engine.simulate(request, { requestId: 'native-rc' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' }, data: { analyses: [{ type: 'tran' }] } });
  } finally { await engine.close(); }
});


it('matches text WASM and native core at pulse edges with max step', async () => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native');
  Object.assign(input.input.document.analyses[0]!, { maxTimestep: 2e-6 });
  Object.assign(input.input.document.circuit.components[0]!.params, { width: 0.0003, period: 0.0006 });
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const native = await engine.simulate(input, { requestId: 'native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 PULSE(0 1 0 1u 1u 300u 600u)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 1m 0 2u' } }, { requestId: 'text' });
    const core = await simulateProtocolV1(input);
    expect(native, JSON.stringify(native)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    expect(text, JSON.stringify(text)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    if (!native.ok || !text.ok) throw new Error('expected success');
    const a = native.data.analyses[0], b = text.data.analyses[0], c = core.analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran' || c?.type !== 'tran') throw new Error('transient required');
    expect(a.timeS.length).toBeGreaterThan(10);
    expect(a.timeS).toHaveLength(b.timeS.length);
    expect(a.timeS).toHaveLength(c.timeS.length);
    let maxText = 0, maxCore = 0, maxTime = 0;
    for (let i = 0; i < a.timeS.length; i++) {
      maxTime = Math.max(maxTime, Math.abs(a.timeS[i]! - b.timeS[i]!));
      expect(Math.abs(a.timeS[i]! - b.timeS[i]!)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(a.timeS[i]! - c.timeS[i]!)).toBeLessThanOrEqual(1e-12);
      for (const field of ['voltagesV', 'currentsA'] as const) for (const [name, values] of Object.entries(a[field])) {
        const x = values[i]!, y = b[field][name]![i]!, z = c[field][name]![i]!;
        maxText = Math.max(maxText, Math.abs(x - y)); maxCore = Math.max(maxCore, Math.abs(x - z));
        expect(Math.abs(x - y), `${field}.${name}[${i}] text`).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(y)));
        expect(Math.abs(x - z), `${field}.${name}[${i}] core`).toBeLessThanOrEqual(Math.max(1e-12, 1e-6 * Math.abs(z)));
      }
    }
    expect(a.voltagesV.in![0]).toBe(0);
    expect(Math.max(...a.voltagesV.in!)).toBeCloseTo(1, 12);
    expect(a.voltagesV.in!.some((value, i, values) => i > 0 && value < values[i - 1]!)).toBe(true);
    console.log('native RC parity', JSON.stringify({ points: a.timeS.length, maxTime, maxText, maxCore }));
  } finally { await engine.close(); }
});


it('bounds the RC charging error against the physical exponential', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const result = await engine.simulate(request, { requestId: 'physical' });
    if (!result.ok || result.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify(result));
    const tran = result.data.analyses[0];
    // The source ramp is 1 us. Its ideal response is bounded by two step
    // responses separated by 1 us. The unresolved input edge contributes at
    // most h/tau = 0.01 V, plus 1e-5 V for trapezoidal decay error.
    const i = tran.timeS.length - 1, t = tran.timeS[i]!, actual = tran.voltagesV.out![i]!;
    const lower = 1 - Math.exp(-(t - 1e-6) / 1e-3), upper = 1 - Math.exp(-t / 1e-3);
    console.log('native RC physical', JSON.stringify({ t, actual, lower, upper, discretizationBound: 0.01001 }));
    expect(actual).toBeGreaterThanOrEqual(lower - 0.01001);
    expect(actual).toBeLessThanOrEqual(upper + 0.01001);
  } finally { await engine.close(); }
});

it('handles DC voltage and current drives in resistive circuits', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const [source, value] of [[component('V', 'V1', ['in', '0'], { dc: 2 }), 2], [component('I', 'I1', ['0', 'in'], { dc: 0.002 }), 2]] as const) {
      const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
      input.input.document.circuit.components = [source, component('R', 'R1', ['in', '0'], { resistance: 1000 })];
      const result = await engine.simulate(input, { requestId: 'dc' });
      if (!result.ok || result.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify(result));
      for (const actual of result.data.analyses[0].voltagesV.in!) expect(actual).toBeCloseTo(value, 12);
    }
  } finally { await engine.close(); }
});

it('rejects invalid transient controls before execution', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const [key, value] of [['timestep', 0], ['timestep', -1], ['timestep', Infinity], ['stopTime', 0], ['stopTime', -1], ['stopTime', NaN], ['startTime', -1], ['startTime', 0.001], ['maxTimestep', 0], ['maxTimestep', -1], ['maxTimestep', Infinity]] as const) {
      const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
      Object.assign(input.input.document.analyses[0]!, { [key]: value });
      const result = await engine.simulate(input, { requestId: 'invalid' });
      expect(result, `${key}=${value} ${JSON.stringify(result)}`).toMatchObject({ ok: false });
    }
  } finally { await engine.close(); }
});

it('enforces resource limits and rejects excluded features', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const [key, value] of [['maxComponents', 2], ['maxSourceBytes', 10], ['maxResultPoints', 2], ['maxSerializedResultBytes', 10]] as const) {
      const input = { ...structuredClone(request), options: { limits: { [key]: value } } };
      const result = await engine.simulate(input, { requestId: 'limit' });
      expect(result, `${key} ${JSON.stringify(result)}`).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: key } } });
    }
    for (const extra of [{ uic: true }, { measurements: [] }, { fourier: { fundamentalHz: 1000, outputs: ['v(out)'] } }]) {
      const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
      Object.assign(input.input.document.analyses[0]!, extra);
      const result = await engine.simulate(input, { requestId: 'excluded' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
    }
    const selected = await engine.simulate({ ...structuredClone(request), outputs: ['v(out)'] }, { requestId: 'selected' });
    expect(selected).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
  } finally { await engine.close(); }
});


it('reports a singular circuit and enforces the fixed system-order limit', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
    input.input.document.circuit.components = [component('R', 'R1', ['in', 'out'], { resistance: 1000 })];
    const singular = await engine.simulate(input, { requestId: 'singular' });
    expect(singular, JSON.stringify(singular)).toMatchObject({ ok: false });
    const large = structuredClone(request); if (large.input.format !== 'spice-ts') throw new Error('native');
    const nets = Array.from({ length: 65 }, (_, i) => `n${i}`);
    large.input.document.circuit.nets = nets;
    large.input.document.circuit.components = nets.map((net, i) => component('R', `R${i}`, [net, '0'], { resistance: 1000 }));
    const limited = await engine.simulate(large, { requestId: 'order' });
    expect(limited, JSON.stringify(limited)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder' } } });
  } finally { await engine.close(); }
});


it('matches fixed-step text WASM for every node and source current', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const a = await engine.simulate(request, { requestId: 'native-fixed' });
    const b = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 PULSE(0 1 0 1u 1u 1m 2m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 1m' } }, { requestId: 'text-fixed' });
    if (!a.ok || !b.ok || a.data.analyses[0]?.type !== 'tran' || b.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify({ a, b }));
    const x = a.data.analyses[0], y = b.data.analyses[0];
    expect(x.timeS).toHaveLength(y.timeS.length);
    x.timeS.forEach((t, i) => expect(Math.abs(t - y.timeS[i]!)).toBeLessThanOrEqual(1e-12));
    for (const field of ['voltagesV', 'currentsA'] as const) {
      expect(Object.keys(x[field]).sort()).toEqual(Object.keys(y[field]).sort());
      for (const [name, values] of Object.entries(x[field])) values.forEach((value, i) => {
        const expected = y[field][name]![i]!;
        expect(Math.abs(value - expected)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
      });
    }
  } finally { await engine.close(); }
});

it('rejects extra transient options and hierarchy while accepting inductors', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const extra = { ...structuredClone(request), options: { reltol: 0.001 } };
    expect(await engine.simulate(extra, { requestId: 'extra' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
    const input = structuredClone(request); if (input.input.format !== 'spice-ts') throw new Error('native');
    input.input.document.circuit.components.push(component('L', 'L1', ['out', '0'], { inductance: 0.001 }));
    expect(await engine.simulate(input, { requestId: 'inductor' })).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    input.input.document.circuit.components.pop();
    Object.assign(input.input.document.circuit, { initialConditions: { out: 1 } });
    const excluded = await engine.simulate(input, { requestId: 'directive' });
    expect(excluded).toMatchObject({ ok: false });
  } finally { await engine.close(); }
});
