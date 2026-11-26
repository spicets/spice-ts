import { expect, it, vi } from 'vitest';
import { Circuit, simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in'], components: [component('V', 'V1', ['in', '0'], { waveform: 'exp', v1: 1, v2: 2, td1: 0.0001, tau1: 0.0001, td2: 0.0005, tau2: 0.0001 }), component('R', 'R1', ['in', '0'], { resistance: 1000 })] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }] } } };

it('validates and simulates native EXP voltage sources', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  const conversion = vi.spyOn(Circuit.prototype, 'toNetlist').mockImplementation(() => { throw new Error('unexpected JSON-to-text conversion'); });
  try {
    expect(engine.capabilities.numericWasm?.fallback).toBe('reject');
    const validation = await engine.validate(request, { requestId: 'exp-validation' });
    expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
    const result = await engine.simulate(request, { requestId: 'exp' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    expect(conversion).not.toHaveBeenCalled();
  } finally { conversion.mockRestore(); await engine.close(); }
});



it.each([
  ['V', false, false, false], ['I', false, false, false],
  ['V', false, true, true], ['I', false, true, true],
  ['V', true, false, false], ['I', true, false, false],
  ['V', true, true, false], ['I', true, true, false],
  ['V', true, true, true], ['I', true, true, true],
] as const)('EXP parity %s RC=%s explicit=%s reversed=%s', async (kind, rc, explicit, reversed) => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  const params = { waveform: 'exp', v1: 0, v2: kind === 'V' ? 2 : 0.002, ...(explicit ? { td1: 0.0001, tau1: 0.0001, td2: 0.0005, tau2: 0.0001 } : {}) };
  const ports = reversed ? ['0', 'in'] : ['in', '0'];
  input.input.document.circuit.components = [component(kind, `${kind}1`, ports, params), component('R', 'R1', ['in', '0'], { resistance: 1000 }), ...(rc ? [component('C', 'C1', ['in', '0'], { capacitance: 1e-7 })] : [])];
  const source = `${kind}1 ${ports.join(' ')} EXP(0 ${params.v2}${explicit ? ' 0.0001 0.0001 0.0005 0.0001' : ''})\nR1 in 0 1000\n${rc ? 'C1 in 0 0.0000001\n' : ''}.tran 0.00001 0.001`;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(await engine.validate(input, { requestId: 'validate' })).toMatchObject({ ok: true });
    const native = await engine.simulate(input, { requestId: 'native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source } }, { requestId: 'text' });
    const core = await simulateProtocolV1(input);
    if (!native.ok || !text.ok) throw new Error(JSON.stringify({ native, text }));
    expect(native.metadata.backend).toBe('spice-ts-wasm');
    const a = native.data.analyses[0], b = text.data.analyses[0], c = core.analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran' || c?.type !== 'tran') throw new Error('transient required');
    expect(a.timeS.length).toBeGreaterThan(10);
    expect(a.timeS).toHaveLength(b.timeS.length);
    let textError = 0, coreError = 0, matched = 0;
    for (const field of ['voltagesV', 'currentsA'] as const) {
      expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
      expect(Object.keys(a[field]).sort()).toEqual(Object.keys(c[field]).sort());
    }
    for (let i = 0; i < a.timeS.length; i++) {
      const t = a.timeS[i]!;
      expect(Math.abs(t - b.timeS[i]!)).toBeLessThanOrEqual(1e-12);
      const j = c.timeS.findIndex(time => Math.abs(time - t) <= 1e-13);
      if (j >= 0) matched++;
      for (const field of ['voltagesV', 'currentsA'] as const) for (const [name, values] of Object.entries(a[field])) {
        const value = values[i]!, reference = b[field][name]![i]!;
        textError = Math.max(textError, Math.abs(value - reference));
        expect(Math.abs(value - reference)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(reference)));
        if (j >= 0) {
          const expected = c[field][name]![j]!;
          coreError = Math.max(coreError, Math.abs(value - expected));
          expect(Math.abs(value - expected)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
        }
      }
    }
    expect(matched).toBeGreaterThan(0);
    if (explicit) {
      expect(Math.max(...a.voltagesV.in!.map(Math.abs))).toBeGreaterThan(0.5);
      const direction = (kind === 'V' ? 1 : -1) * (reversed ? -1 : 1);
      expect(Math.max(...a.voltagesV.in!.map(value => value * direction))).toBeGreaterThan(0.5);
      expect(Math.abs(a.voltagesV.in!.at(-1)!)).toBeLessThan(Math.max(...a.voltagesV.in!.map(Math.abs)));
    }
    process.stdout.write(`EXP parity ${JSON.stringify({ kind, rc, explicit, reversed, samples: a.timeS.length, coreSamples: c.timeS.length, matched, textError, coreError })}\n`);
  } finally { await engine.close(); }
});

it('rejects malformed and mixed EXP sources with structured errors', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const mutations: Array<(input: SimulationRequestV1) => void> = [];
    for (const key of ['v1', 'v2', 'td1', 'tau1', 'td2', 'tau2']) for (const value of [NaN, Infinity, -Infinity]) mutations.push(input => {
      if (input.input.format === 'spice-ts') input.input.document.circuit.components[0]!.params[key] = value;
    });
    for (const values of [{ v1: undefined }, { v2: undefined }, { dc: 1 }, { offset: 1 }, { delay: 1 }, { points: '0:0' }, { waveform: 'sffm' }]) mutations.push(input => {
      if (input.input.format === 'spice-ts') Object.assign(input.input.document.circuit.components[0]!.params, values);
    });
    mutations.push(input => { if (input.input.format === 'spice-ts') input.input.document.circuit.components[0]!.ports = []; });
    mutations.push(input => { if (input.input.format === 'spice-ts') input.input.document.circuit.components[0]!.ports[0]!.net = 'missing'; });
    mutations.push(input => { if (input.input.format === 'spice-ts') input.input.document.circuit.components[0]!.ports[1]!.name = '0'; });
    for (const mutate of mutations) {
      const input = structuredClone(request); mutate(input);
      for (const result of [await engine.validate(input, { requestId: 'invalid' }), await engine.simulate(input, { requestId: 'invalid' })]) {
        expect(result).toMatchObject({ ok: false, error: { code: expect.any(String), phase: expect.any(String) } });
      }
    }
  } finally { await engine.close(); }
});


it.each([0, -0.001])('accepts finite EXP timing boundary %s', async value => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  Object.assign(input.input.document.circuit.components[0]!.params, { td1: value, tau1: value, td2: value, tau2: value });
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(await engine.validate(input, { requestId: 'boundary' })).toMatchObject({ ok: true });
  } finally { await engine.close(); }
});
