import { expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out', 'extra'], components: [component('V', 'V1', ['in', '0'], { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 1e-6, fall: 1e-6, width: 0.001, period: 0.002 }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('C', 'C1', ['out', '0'], { capacitance: 1e-6 }), component('R', 'R2', ['out', 'extra'], { resistance: 2000 }), component('C', 'C2', ['extra', '0'], { capacitance: 1e-6 })] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }] } } };

it('returns only selected native transient traces without changing their values', async () => {
  const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const full = await wasm.simulate(request, { requestId: 'full' });
    const selected = await wasm.simulate({ ...request, outputs: ['v(OUT)', 'i(v1)'] }, { requestId: 'selected' });
    expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    if (!selected.ok || !full.ok || selected.data.analyses[0]?.type !== 'tran' || full.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify({ full, selected }));
    const actual = selected.data.analyses[0], expected = full.data.analyses[0];
    expect(actual.timeS).toEqual(expected.timeS);
    expect(actual.voltagesV).toEqual({ out: expected.voltagesV.out });
    expect(actual.currentsA).toEqual({ V1: expected.currentsA.V1 });
    expect(actual.timeS.length).toBeGreaterThan(10);
  } finally { await wasm.close(); }
});

it('selects traces in the adaptive transient path as well', async () => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  Object.assign(input.input.document.analyses[0]!, { maxTimestep: 1e-5 });
  const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const full = await wasm.simulate(input, { requestId: 'full' });
    const selected = await wasm.simulate({ ...input, outputs: ['v(OUT)', 'i(v1)', 'V(out)'] }, { requestId: 'selected' });
    if (!selected.ok || !full.ok || selected.data.analyses[0]?.type !== 'tran' || full.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify(selected));
    expect(selected.data.analyses[0].timeS).toEqual(full.data.analyses[0].timeS);
    expect(selected.data.analyses[0].voltagesV).toEqual({ out: full.data.analyses[0].voltagesV.out });
    expect(selected.data.analyses[0].currentsA).toEqual({ V1: full.data.analyses[0].currentsA.V1 });
  } finally { await wasm.close(); }
});

it.each([[], ['V(0)'], ['V(nope)'], ['I(R1)'], ['v()'], [5], null])('matches OP selector rejection for %j', async outputs => {
  const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = { ...request, outputs } as unknown as SimulationRequestV1;
    const validation = await wasm.validate(input, { requestId: 'invalid' });
    const simulation = await wasm.simulate(input, { requestId: 'invalid' });
    expect(validation).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
    expect(simulation).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
    if (!validation.ok && !simulation.ok) expect(simulation.error).toEqual(validation.error);
  } finally { await wasm.close(); }
});

it('bounds the actual selected result and retains point limits', async () => {
  const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const selectedRequest = { ...request, outputs: ['v(out)'] };
    const full = await wasm.simulate(request, { requestId: 'full' });
    const selected = await wasm.simulate(selectedRequest, { requestId: 'selected' });
    if (!full.ok || !selected.ok || full.data.analyses[0]?.type !== 'tran') throw new Error(JSON.stringify(selected));
    const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).byteLength;
    const selectedBytes = bytes(selected.data), fullBytes = bytes(full.data);
    expect(selectedBytes).toBeLessThan(fullBytes);
    process.stdout.write(`TRAN output bytes: full=${fullBytes} selected=${selectedBytes} points=${full.data.analyses[0].timeS.length}\n`);
    const limited = (maxSerializedResultBytes: number) => ({ limits: { maxSerializedResultBytes } });
    expect(await wasm.simulate({ ...selectedRequest, options: limited(selectedBytes) }, { requestId: 'fits' })).toMatchObject({ ok: true });
    expect(await wasm.simulate({ ...selectedRequest, options: limited(selectedBytes - 1) }, { requestId: 'too-small' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } });
    expect(await wasm.simulate({ ...request, options: limited(selectedBytes) }, { requestId: 'full-too-large' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } });
    expect(await wasm.simulate({ ...selectedRequest, options: { limits: { maxResultPoints: 2 } } }, { requestId: 'points' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } } });
  } finally { await wasm.close(); }
});

it.each([false, true])('enforces engine point budget with selection, adaptive=%s', async adaptive => {
  const input = structuredClone(request);
  if (input.input.format !== 'spice-ts') throw new Error('native required');
  if (adaptive) Object.assign(input.input.document.analyses[0]!, { maxTimestep: 1e-5 });
  const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: 2 });
  try {
    expect(await wasm.simulate({ ...input, outputs: ['v(out)'] }, { requestId: 'points' })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxPoints' } } });
  } finally { await wasm.close(); }
});

it('preserves cancellation with selected outputs', async () => {
  const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const pending = wasm.simulate({ ...request, outputs: ['v(out)'] }, { requestId: 'cancel-selected' });
    expect(await wasm.cancel('cancel-selected')).toEqual({ requestId: 'cancel-selected', status: 'cancelling' });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  } finally { await wasm.close(); }
});
