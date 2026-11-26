import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in'], components: [component('V', 'V1', ['in', '0'], { waveform: 'sin', offset: 1, amplitude: 2, frequency: 1000 }), component('R', 'R1', ['in', '0'], { resistance: 1000 })] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }] } } };

it('validates and simulates native SIN voltage sources', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const validation = await engine.validate(request, { requestId: 'sin-validation' });
    expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
    const result = await engine.simulate(request, { requestId: 'sin' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
  } finally { await engine.close(); }
});


it.each([
  ['V', false, false], ['I', false, false], ['V', false, true], ['I', false, true],
  ['V', true, true], ['I', true, true],
] as const)('compares %s source, RC=%s, explicit coefficients=%s', async (kind, rc, explicit) => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native');
  const params = { waveform: 'sin', offset: 1, amplitude: 0.5, frequency: 1000, ...(explicit ? { delay: 0.0001, damping: 30, phase: 37 } : {}) };
  const ports = kind === 'V' ? ['in', '0'] : ['0', 'in'];
  input.input.document.circuit.components = [component(kind, `${kind}1`, ports, params), component('R', 'R1', ['in', '0'], { resistance: 1000 }), ...(rc ? [component('C', 'C1', ['in', '0'], { capacitance: 1e-6 })] : [])];
  const netlist = `${kind}1 ${ports.join(' ')} SIN(1 0.5 1000${explicit ? ' 0.0001 30 37' : ''})\nR1 in 0 1000\n${rc ? 'C1 in 0 1u\n' : ''}.tran 10u 1m`;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(await engine.validate(input, { requestId: 'validation' })).toMatchObject({ ok: true });
    const native = await engine.simulate(input, { requestId: 'native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: netlist } }, { requestId: 'text' });
    const core = await simulateProtocolV1(input);
    if (!native.ok || !text.ok) throw new Error(JSON.stringify({ native, text }));
    expect(native.metadata.backend).toBe('spice-ts-wasm');
    const a = native.data.analyses[0], b = text.data.analyses[0], c = core.analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran' || c?.type !== 'tran') throw new Error('transient required');
    expect(a.timeS.length).toBeGreaterThan(10);
    expect(a.timeS).toHaveLength(b.timeS.length);
    let textError = 0, coreError = 0, matched = 0, analyticError = 0;
    for (let i = 0; i < a.timeS.length; i++) {
      const t = a.timeS[i]!;
      expect(Math.abs(t - b.timeS[i]!)).toBeLessThanOrEqual(1e-12);
      const j = c.timeS.findIndex(time => Math.abs(time - t) <= 1e-13);
      if (j >= 0) matched++;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [name, values] of Object.entries(a[field])) {
          const value = values[i]!, reference = b[field][name]![i]!;
          textError = Math.max(textError, Math.abs(value - reference));
          expect(Math.abs(value - reference)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(reference)));
          if (j >= 0) {
            const expected = c[field][name]![j]!;
            coreError = Math.max(coreError, Math.abs(value - expected));
            expect(Math.abs(value - expected), `${kind} rc=${rc} ${field}.${name} at ${t}`).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
          }
        }
      }
      if (!rc) {
        const dt = t - (explicit ? 0.0001 : 0);
        const wave = dt < 0 ? 1 : 1 + 0.5 * Math.exp(-(explicit ? 30 : 0) * dt) * Math.sin(2 * Math.PI * 1000 * dt + (explicit ? 37 : 0) * Math.PI / 180);
        const voltage = kind === 'V' ? wave : 1000 * wave;
        analyticError = Math.max(analyticError, Math.abs(a.voltagesV.in![i]! - voltage));
        expect(Math.abs(a.voltagesV.in![i]! - voltage)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(voltage)));
        if (kind === 'V') expect(Math.abs(a.currentsA.V1![i]! + wave / 1000)).toBeLessThanOrEqual(1e-12);
      }
    }
    expect(Object.keys(a.voltagesV).sort()).toEqual(Object.keys(c.voltagesV).sort());
    expect(Object.keys(a.currentsA).sort()).toEqual(Object.keys(c.currentsA).sort());
    expect(matched).toBeGreaterThan(0);
    process.stdout.write(`SIN parity ${JSON.stringify({ kind, rc, explicit, samples: a.timeS.length, coreSamples: c.timeS.length, matched, textError, coreError, analyticError })}\n`);
  } finally { await engine.close(); }
});


it('rejects invalid and mixed SIN coefficients and ports', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const mutations: Array<(input: SimulationRequestV1) => void> = [];
    for (const key of ['offset', 'amplitude', 'frequency', 'delay', 'damping', 'phase']) {
      for (const value of [NaN, Infinity, -Infinity]) mutations.push(input => {
        if (input.input.format !== 'spice-ts') throw new Error('native');
        input.input.document.circuit.components[0]!.params[key] = value;
      });
    }
    for (const values of [{ offset: undefined }, { amplitude: undefined }, { frequency: undefined }, { unknown: 1 }, { dc: 2 }, { v1: 0 }, { rise: 1 }, { magnitude: 1 }]) mutations.push(input => {
      if (input.input.format !== 'spice-ts') throw new Error('native');
      Object.assign(input.input.document.circuit.components[0]!.params, values);
    });
    mutations.push(input => { if (input.input.format === 'spice-ts') input.input.document.circuit.components[0]!.ports = []; });
    mutations.push(input => { if (input.input.format === 'spice-ts') input.input.document.circuit.components[0]!.ports[0]!.net = 'missing'; });
    mutations.push(input => { if (input.input.format === 'spice-ts') input.input.document.circuit.components[0]!.ports[1]!.name = '0'; });
    for (const [index, mutate] of mutations.entries()) {
      const input = structuredClone(request); mutate(input);
      for (const run of [engine.validate.bind(engine), engine.simulate.bind(engine)]) {
        const result = await run(input, { requestId: 'invalid' });
        expect(result, `mutation ${index}: ${JSON.stringify(result)}`).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^(INVALID_CIRCUIT|INVALID_REQUEST|UNSUPPORTED_FEATURE)$/), phase: expect.any(String) } });
      }
    }
  } finally { await engine.close(); }
});

it('preserves resource limits for SIN', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const [key, value] of [['maxComponents', 1], ['maxSourceBytes', 10], ['maxResultPoints', 2], ['maxSerializedResultBytes', 10]] as const) {
      const result = await engine.simulate({ ...request, options: { limits: { [key]: value } } }, { requestId: 'limit' });
      expect(result, key).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: key } } });
    }
    const large = structuredClone(request);
    if (large.input.format !== 'spice-ts') throw new Error('native');
    const nets = Array.from({ length: 65 }, (_, i) => `n${i}`);
    large.input.document.circuit.nets = ['in', ...nets];
    large.input.document.circuit.components.push(...nets.map((net, i) => component('R', `Rx${i}`, [net, '0'], { resistance: 1000 })));
    expect(await engine.simulate(large, { requestId: 'memory-limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder' } } });
  } finally { await engine.close(); }
});


it('compares a voltage-driven series RC at matched core times', async () => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native');
  input.input.document.circuit.nets = ['in', 'out'];
  input.input.document.circuit.components = [component('V', 'V1', ['in', '0'], { waveform: 'sin', offset: 1, amplitude: 0.5, frequency: 1000, delay: 0.0001, damping: 30, phase: 37 }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('C', 'C1', ['out', '0'], { capacitance: 1e-6 })];
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const native = await engine.simulate(input, { requestId: 'native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 SIN(1 0.5 1000 0.0001 30 37)\nR1 in out 1000\nC1 out 0 1u\n.tran 10u 1m' } }, { requestId: 'text' });
    const core = await simulateProtocolV1(input);
    if (!native.ok || !text.ok) throw new Error(JSON.stringify({ native, text }));
    const a = native.data.analyses[0], b = text.data.analyses[0], c = core.analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran' || c?.type !== 'tran') throw new Error('tran');
    expect(a.timeS).toHaveLength(b.timeS.length);
    let maxText = 0, maxCore = 0, matched = 0;
    for (let i = 0; i < a.timeS.length; i++) {
      const t = a.timeS[i]!; expect(Math.abs(t - b.timeS[i]!)).toBeLessThanOrEqual(1e-12);
      const j = c.timeS.findIndex(time => Math.abs(time - t) <= 1e-13); if (j >= 0) matched++;
      for (const field of ['voltagesV', 'currentsA'] as const) for (const [name, values] of Object.entries(a[field])) {
        const x = values[i]!, y = b[field][name]![i]!; maxText = Math.max(maxText, Math.abs(x - y));
        expect(Math.abs(x - y)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(y)));
        if (j >= 0) { const z = c[field][name]![j]!; maxCore = Math.max(maxCore, Math.abs(x - z)); expect(Math.abs(x - z), `${field}.${name} t=${t}`).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(z))); }
      }
    }
    expect(matched).toBeGreaterThan(0);
    process.stdout.write(`series RC parity ${JSON.stringify({ samples: a.timeS.length, coreSamples: c.timeS.length, matched, maxText, maxCore })}\n`);
  } finally { await engine.close(); }
});
