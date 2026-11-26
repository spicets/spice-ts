import { expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, unknown>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
const request = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in'], components: [component('V', 'V1', ['in', '0'], { waveform: 'pwl', points: [{ time: 0, value: 0 }, { time: 0.001, value: 1 }] }), component('R', 'R1', ['in', '0'], { resistance: 1000 })] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.002 }] } } } as SimulationRequestV1;

it('executes a native PWL voltage ramp on the numeric WASM backend', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const result = await engine.simulate(request, { requestId: 'pwl' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
  } finally { await engine.close(); }
});

it.each([['V', false], ['I', false], ['V', true], ['I', true]] as const)('matches native, text and core for %s driven RLC=%s', async (kind, rlc) => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  const points = [{ time: 0, value: -0.25 }, { time: 0.0003, value: 1 }, { time: 0.0007, value: -0.5 }, { time: 0.001, value: 0.75 }];
  const ports = kind === 'V' ? ['in', '0'] : ['0', 'in'];
  input.input.document.circuit.nets = ['in', 'out'];
  input.input.document.circuit.components = [component(kind, `${kind}1`, ports, { waveform: 'pwl', points }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('R', 'R2', ['out', '0'], { resistance: 1000 }), component('C', 'C1', ['out', '0'], { capacitance: 1e-6 }), ...(rlc ? [component('L', 'L1', ['out', '0'], { inductance: 0.1 })] : [])] as typeof input.input.document.circuit.components;
  const deck = `${kind}1 ${ports.join(' ')} PWL(0 -0.25 0.0003 1 0.0007 -0.5 0.001 0.75)\nR1 in out 1000\nR2 out 0 1000\nC1 out 0 1u\n${rlc ? 'L1 out 0 0.1\n' : ''}.tran 10u 2m`;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const native = await engine.simulate(input, { requestId: 'native' });
    const text = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: deck } }, { requestId: 'text' });
    const core = await simulateProtocolV1(input);
    if (!native.ok || !text.ok) throw new Error(JSON.stringify({ native, text }));
    expect(native.metadata.backend).toBe('spice-ts-wasm');
    const a = native.data.analyses[0], b = text.data.analyses[0], c = core.analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran' || c?.type !== 'tran') throw new Error('transient required');
    expect(a.timeS).toHaveLength(b.timeS.length);
    let voltage = 0, current = 0, coreVoltage = 0, coreCurrent = 0, matched = 0;
    for (let i = 0; i < a.timeS.length; i++) {
      const t = a.timeS[i]!;
      expect(Math.abs(t - b.timeS[i]!)).toBeLessThanOrEqual(1e-12);
      const j = c.timeS.findIndex(x => Math.abs(x - t) < 1e-13);
      if (j >= 0) matched++;
      for (const field of ['voltagesV', 'currentsA'] as const) for (const [name, values] of Object.entries(a[field])) {
        const error = Math.abs(values[i]! - b[field][name]![i]!);
        const coreError = j < 0 ? 0 : Math.abs(values[i]! - c[field][name]![j]!);
        if (field === 'voltagesV') { voltage = Math.max(voltage, error); coreVoltage = Math.max(coreVoltage, coreError); }
        else { current = Math.max(current, error); coreCurrent = Math.max(coreCurrent, coreError); }
        expect(error).toBeLessThanOrEqual(1e-9);
        expect(coreError).toBeLessThanOrEqual(1e-9);
      }
    }
    expect(matched).toBe(a.timeS.length);
    expect(c.timeS).toHaveLength(a.timeS.length);
    process.stdout.write(`PWL parity ${JSON.stringify({ kind, rlc, samples: a.timeS.length, coreSamples: c.timeS.length, matched, voltage, current, coreVoltage, coreCurrent })}\n`);
  } finally { await engine.close(); }
});

it('matches an analytic ramp, duplicate-time corner and final hold', async () => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  input.input.document.circuit.components[0]!.params.points = [{ time: 0, value: 0 }, { time: 0.0005, value: 0.5 }, { time: 0.001, value: 1 }, { time: 0.001, value: -1 }, { time: 0.0015, value: 0 }];
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const result = await engine.simulate(input, { requestId: 'analytic' });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const a = result.data.analyses[0];
    if (a?.type !== 'tran') throw new Error('tran');
    let maxError = 0;
    for (const [i, t] of a.timeS.entries()) {
      const expected = t < 0.001 ? t * 1000 : t <= 0.0015 ? -1 + (t - 0.001) * 2000 : 0;
      maxError = Math.max(maxError, Math.abs(a.voltagesV.in![i]! - expected));
    }
    expect(maxError).toBeLessThanOrEqual(1e-12);
    expect(a.timeS.some(t => Math.abs(t - 0.001) < 1e-15)).toBe(true);
    expect(a.timeS.at(-1)!).toBeGreaterThan(0.0015);
    process.stdout.write(`PWL analytic ${JSON.stringify({ samples: a.timeS.length, maxError })}\n`);
  } finally { await engine.close(); }
});

it('rejects malformed and unsupported PWL data during validation and simulation', async () => {
  const valid = [{ time: 0, value: 0 }, { time: 1, value: 1 }];
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ points: [] }, 'INVALID_CIRCUIT'], [{ points: Array.from({ length: 1025 }, () => ({ time: 0, value: 0 })) }, 'INVALID_CIRCUIT'],
    [{ points: null }, 'INVALID_CIRCUIT'], [{ points: [null] }, 'INVALID_CIRCUIT'], [{ points: [{ time: 0 }] }, 'INVALID_CIRCUIT'],
    [{ points: [{ time: -1, value: 0 }] }, 'INVALID_CIRCUIT'], [{ points: [{ time: 1, value: 0 }, { time: 0, value: 1 }] }, 'INVALID_CIRCUIT'],
    [{ points: [{ time: Infinity, value: 0 }] }, 'INVALID_REQUEST'], [{ points: [{ time: 0, value: NaN }] }, 'INVALID_REQUEST'],
    [{ points: [{ time: 0, value: 0, extra: 1 }] }, 'INVALID_CIRCUIT'],
    [{ points: '0:0,1:1' }, 'UNSUPPORTED_FEATURE'], [{ points: valid, delay: 1 }, 'UNSUPPORTED_FEATURE'], [{ points: valid, repeat: 1 }, 'UNSUPPORTED_FEATURE'],
    [{ points: valid, dc: 1 }, 'UNSUPPORTED_FEATURE'], [{ points: valid, v1: 1 }, 'UNSUPPORTED_FEATURE'], [{ points: valid, amplitude: 1 }, 'UNSUPPORTED_FEATURE'], [{ points: valid, extra: 1 }, 'UNSUPPORTED_FEATURE'],
  ];
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    for (const [params, code] of cases) {
      const input = structuredClone(request);
      if (input.input.format !== 'spice-ts') throw new Error('native');
      input.input.document.circuit.components[0]!.params = { waveform: 'pwl', ...params } as typeof input.input.document.circuit.components[number]['params'];
      for (const run of [engine.validate.bind(engine), engine.simulate.bind(engine)]) {
        const result = await run(input, { requestId: 'invalid' });
        expect(result, JSON.stringify({ params, result })).toMatchObject({ ok: false, error: { code, phase: 'validation' } });
      }
    }
    for (const ports of [[{ name: '0', net: 'missing' }, { name: '1', net: '0' }], [{ name: '0', net: 'in' }]]) {
      const input = structuredClone(request);
      if (input.input.format !== 'spice-ts') throw new Error('native');
      input.input.document.circuit.components[0]!.ports = ports;
      expect(await engine.validate(input, { requestId: 'ports' })).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT', phase: 'validation' } });
    }
    const boundary = structuredClone(request);
    if (boundary.input.format !== 'spice-ts') throw new Error('native');
    boundary.input.document.circuit.components[0]!.params.points = Array.from({ length: 1024 }, (_, i) => ({ time: i / 1e6, value: 0 }));
    expect(await engine.validate(boundary, { requestId: 'boundary' })).toMatchObject({ ok: true });
    for (const analysis of [{ type: 'op' }, { type: 'ac', variation: 'dec', points: 5, startFreq: 10, stopFreq: 1000 }, { type: 'dc', source: 'V1', start: 0, stop: 1, step: 1 }]) {
      const input = structuredClone(request);
      if (input.input.format !== 'spice-ts') throw new Error('native');
      input.input.document.analyses = [analysis as typeof input.input.document.analyses[number]];
      expect(await engine.validate(input, { requestId: 'analysis' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation' } });
    }
    const limited = { ...request, options: { limits: { maxResultPoints: 1 } } };
    expect(await engine.simulate(limited, { requestId: 'limit' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
  } finally { await engine.close(); }
}, 30_000);
