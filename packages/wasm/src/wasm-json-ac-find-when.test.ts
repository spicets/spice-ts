import { expect, it } from 'vitest';
import { simulateProtocolV1, simulate, parseTitleless } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';
import { validateLinearOpWasmV1 } from './numeric-wasm.js';

const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
function request(): SimulationRequestV1 {
  return { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out'], components: [component('V', 'V1', ['in', '0'], { waveform: 'ac', magnitude: 1 }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('C', 'C1', ['out', '0'], { capacitance: 100e-9 })] }, analyses: [{ type: 'ac', variation: 'dec', points: 20, startFreq: 10, stopFreq: 100000, measurements: [{ name: 'threshold', kind: 'find', vector: 'vm(out)', when: { vector: 'vdb(out)', value: -3, fall: 1 } }] }] } } };
}


it.each(['lin', 'dec', 'oct'])('matches native JS and SPICE text for RC FIND WHEN on %s', async variation => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native required');
    Object.assign(input.input.document.analyses[0]!, { variation });
    const actual = await engine.simulate(input, { requestId: 'when' });
    expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    if (!actual.ok) throw new Error(actual.error.message);
    const a = actual.data.analyses[0];
    const b = (await simulateProtocolV1(input)).analyses[0];
    const text = await simulate(parseTitleless(`V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac ${variation} 20 10 100000\n.meas ac threshold find vm(out) when vdb(out)=-3 fall=1`));
    if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('AC required');
    const av = a.measurements?.[0]; const bv = b.measurements?.[0];
    if (!av || !bv || !('value' in av) || !('value' in bv)) throw new Error('crossing expected');
    expect(Math.abs(av.value - bv.value)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(av.value - text.measurements![0]!.value!)).toBeLessThanOrEqual(1e-9);
  } finally { await engine.close(); }
});


it.each([
  ['fall', 'vdb(out)', -3, 'fall', 1],
  ['phase', 'vp(out)', -0.7, 'fall', 'last'],
  ['cross', 'vdb(out)', -3, 'cross', 'last'],
  ['default', 'vdb(out)', -3, undefined, undefined],
] as const)('matches JS and text for %s occurrence', async (name, vector, value, selector, occurrence) => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native required');
    Object.assign(input.input.document.analyses[0]!, { measurements: [{ name, kind: 'find', vector: 'vm(out)', when: { vector, value, ...(selector ? { [selector]: occurrence } : {}) } }] });
    const actual = await engine.simulate(input, { requestId: name });
    const js = await simulateProtocolV1(input);
    const text = await simulate(parseTitleless(`V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 20 10 100000\n.meas ac ${name} find vm(out) when ${vector}=${value}${selector ? ` ${selector}=${occurrence}` : ''}`));
    if (!actual.ok || actual.data.analyses[0]?.type !== 'ac' || js.analyses[0]?.type !== 'ac') throw new Error('AC required');
    const a = actual.data.analyses[0].measurements?.[0]; const b = js.analyses[0].measurements?.[0];
    if (!a || !b || !('value' in a) || !('value' in b)) throw new Error('crossing expected');
    expect(Math.abs(a.value - b.value)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(a.value - text.measurements![0]!.value!)).toBeLessThanOrEqual(1e-9);
  } finally { await engine.close(); }
});

it('matches a rising high-pass crossing against JS and text', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request(); if (input.input.format !== 'spice-ts') throw new Error('native required');
    const components = input.input.document.circuit.components;
    components[1] = { ...components[1]!, type: 'C', params: { capacitance: 100e-9 } };
    components[2] = { ...components[2]!, type: 'R', params: { resistance: 1000 } };
    Object.assign(input.input.document.analyses[0]!, { measurements: [{ name: 'rise', kind: 'find', vector: 'vp(out)', when: { vector: 'vdb(out)', value: -3, rise: 1 } }] });
    const actual = await engine.simulate(input, { requestId: 'rise' }); const js = await simulateProtocolV1(input);
    const text = await simulate(parseTitleless('V1 in 0 AC 1\nC1 in out 100n\nR1 out 0 1k\n.ac dec 20 10 100000\n.meas ac rise find vp(out) when vdb(out)=-3 rise=1'));
    if (!actual.ok || actual.data.analyses[0]?.type !== 'ac' || js.analyses[0]?.type !== 'ac') throw new Error('AC required');
    const a = actual.data.analyses[0].measurements?.[0]; const b = js.analyses[0].measurements?.[0];
    if (!a || !b || !('value' in a) || !('value' in b)) throw new Error('crossing expected');
    expect(Math.abs(a.value - b.value)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(a.value - text.measurements![0]!.value!)).toBeLessThanOrEqual(1e-9);
  } finally { await engine.close(); }
});

it('reports no crossing and validates malformed selectors at both boundaries', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request(); if (input.input.format !== 'spice-ts') throw new Error('native required');
    const analysis = input.input.document.analyses[0]!;
    Object.assign(analysis, { measurements: [{ name: 'missing', kind: 'find', vector: 'vm(out)', when: { vector: 'vdb(out)', value: 10, rise: 1 } }] });
    const result = await engine.simulate(input, { requestId: 'missing' });
    expect(result).toMatchObject({ ok: true, data: { analyses: [{ measurements: [{ name: 'missing', diagnostic: { code: 'MEASUREMENT_FAILED' } }] }] } });
    const js = await simulateProtocolV1(input);
    const text = await simulate(parseTitleless('V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 20 10 100000\n.meas ac missing find vm(out) when vdb(out)=10 rise=1'));
    expect(js.analyses[0]).toMatchObject({ measurements: [{ name: 'missing', diagnostic: { code: 'MEASUREMENT_FAILED' } }] });
    expect(text.measurements![0]!.status).not.toBe('ok');
    for (const [measurement, path] of [
      [{ name: 'x', kind: 'find', vector: 'vm(out)', at: 1, when: { vector: 'vdb(out)', value: -3 } }, '/0'],
      [{ name: 'x', kind: 'find', vector: 'vm(out)', when: { vector: 'vdb(out)', value: -3, fall: 0 } }, '/0/when/fall'],
      [{ name: 'x', kind: 'find', vector: 'vm(out)', when: { vector: 'vdb(out)', value: -3, cross: 1.5 } }, '/0/when/cross'],
      [{ name: 'x', kind: 'find', vector: 'vm(out)', when: { vector: 'vdb(out)', value: -3, rise: 1, fall: 1 } }, '/0/when'],
    ] as const) {
      Object.assign(analysis, { measurements: [measurement] });
      expect(() => validateLinearOpWasmV1(input)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_REQUEST', details: { path: `/input/document/analyses/0/measurements${path}` } }) }));
      for (const execute of [engine.validate.bind(engine), engine.simulate.bind(engine)]) {
        const invalid = await execute(input, { requestId: 'invalid' });
        expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });

      }
    }
  } finally { await engine.close(); }
});

it.each(['exact', 'interpolated'])('evaluates %s synthetic threshold from WASM samples', async mode => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request(); if (input.input.format !== 'spice-ts') throw new Error('native required');
    const analysis = input.input.document.analyses[0]!;
    Object.assign(analysis, { variation: 'lin', points: 5, startFreq: 100, stopFreq: 4100, measurements: [] });
    const baseline = await engine.simulate(input, { requestId: 'samples' });
    if (!baseline.ok || baseline.data.analyses[0]?.type !== 'ac') throw new Error('AC required');
    const samples = baseline.data.analyses[0].voltagePhasors.out!;
    const value = mode === 'exact' ? samples[2]!.magnitude : (samples[2]!.magnitude + samples[3]!.magnitude) / 2;
    Object.assign(analysis, { measurements: [{ name: 'synthetic', kind: 'find', vector: 'vm(out)', when: { vector: 'vm(out)', value, fall: 1 } }] });
    const result = await engine.simulate(input, { requestId: mode });
    if (!result.ok || result.data.analyses[0]?.type !== 'ac') throw new Error('AC required');
    const measurement = result.data.analyses[0].measurements?.[0];
    if (!measurement || !('value' in measurement)) throw new Error('crossing expected');
    expect(Math.abs(measurement.value - value)).toBeLessThanOrEqual(1e-9);
  } finally { await engine.close(); }
});


it('evaluates the crossing before output projection', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request();
    const full = await engine.simulate(input, { requestId: 'full' });
    const selected = await engine.simulate({ ...input, outputs: ['v(in)'] }, { requestId: 'selected' });
    if (!full.ok || !selected.ok || full.data.analyses[0]?.type !== 'ac' || selected.data.analyses[0]?.type !== 'ac') throw new Error('AC required');
    expect(selected.data.analyses[0].measurements).toEqual(full.data.analyses[0].measurements);
    expect(selected.data.analyses[0].measurements?.[0]).toMatchObject({ name: 'threshold', value: expect.any(Number) });
    expect(selected.data.analyses[0].voltagePhasors?.out).toBeUndefined();
  } finally { await engine.close(); }
});


it.each([
  ['second', { fall: 2 }],
  ['delayed', { fall: 1, td: 10000 }],
] as const)('matches JS and text for %s occurrence', async (name, selector) => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const input = request(); if (input.input.format !== 'spice-ts') throw new Error('native required');
    Object.assign(input.input.document.analyses[0]!, { measurements: [{ name, kind: 'find', vector: 'vm(out)', when: { vector: 'vdb(out)', value: -3, ...selector } }] });
    const wasm = await engine.simulate(input, { requestId: name });
    const js = await simulateProtocolV1(input);
    const clause = name === 'second' ? 'fall=2' : 'fall=1 td=10000';
    const text = await simulate(parseTitleless(`V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 20 10 100000\n.meas ac ${name} find vm(out) when vdb(out)=-3 ${clause}`));
    if (!wasm.ok || wasm.data.analyses[0]?.type !== 'ac' || js.analyses[0]?.type !== 'ac') throw new Error('AC required');
    const a = wasm.data.analyses[0].measurements![0]!; const b = js.analyses[0].measurements![0]!;
    if (name === 'second') {
      expect(a).toMatchObject({ diagnostic: { code: 'MEASUREMENT_FAILED' } });
      expect(b).toMatchObject({ diagnostic: { code: 'MEASUREMENT_FAILED' } });
      expect(text.measurements![0]!.status).not.toBe('ok');
    } else {
      // Existing AC evaluator ignores td, unlike transient; preserve text/JS semantics.
      if (!('value' in a) || !('value' in b)) throw new Error('crossing expected');
      expect(Math.abs(a.value - b.value)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(a.value - text.measurements![0]!.value!)).toBeLessThanOrEqual(1e-9);
    }
  } finally { await engine.close(); }
});
