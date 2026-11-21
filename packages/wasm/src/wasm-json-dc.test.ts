import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const c = (type: string, name: string, p: string, n: string, params: Record<string, number>) => ({ type, name, id: name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params });
const r = (name: string, p: string, n: string, resistance: number) => c('R', name, p, n, { resistance });
const sweep = { type: 'dc' as const, source: 'V1', start: 0, stop: 2, step: 1 };
const base: SpiceTsCircuitDocumentV1 = { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out', 'mid'], components: [c('V', 'V1', 'in', '0', { dc: 0 }), r('R1', 'in', 'out', 2000), r('R2', 'out', '0', 1000)] }, analyses: [sweep] };
const request = (document: SpiceTsCircuitDocumentV1, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document }, ...(options ? { options } : {}) });
const tol = (value: number) => Math.max(1e-12, 1e-9 * Math.abs(value));
const fixtures = [
  { name: 'voltage divider', components: base.circuit.components, source: 'V1', axis: [0, 1, 2], text: 'V1 in 0 0\nR1 in out 2k\nR2 out 0 1k', voltages: { in: [0, 1, 2], out: [0, 1 / 3, 2 / 3] }, currents: { V1: [0, -1 / 3000, -2 / 3000] } },
  { name: 'descending current source', components: [c('I', 'I1', '0', 'out', { dc: 0 }), r('R1', 'out', '0', 1000)], source: 'I1', axis: [0.002, 0.001, 0], text: 'I1 0 out 0\nR1 out 0 1k', voltages: { out: [2, 1, 0] }, currents: {} },
  { name: 'RC open', components: [...base.circuit.components, c('C', 'C1', 'out', '0', { capacitance: 1e-6 })], source: 'V1', axis: [0, 1, 2], text: 'V1 in 0 0\nR1 in out 2k\nR2 out 0 1k\nC1 out 0 1u', voltages: { in: [0, 1, 2], out: [0, 1 / 3, 2 / 3] }, currents: { V1: [0, -1 / 3000, -2 / 3000] } },
  { name: 'RL short', components: [base.circuit.components[0]!, base.circuit.components[1]!, c('L', 'L1', 'out', '0', { inductance: 0.01 })], source: 'V1', axis: [0, 1, 2], text: 'V1 in 0 0\nR1 in out 2k\nL1 out 0 10m', voltages: { in: [0, 1, 2], out: [0, 0, 0] }, currents: { V1: [0, -0.0005, -0.001], L1: [0, 0.0005, 0.001] } },
  { name: 'RLC short and open', components: [base.circuit.components[0]!, base.circuit.components[1]!, c('L', 'L1', 'out', 'mid', { inductance: 0.01 }), r('R2', 'mid', '0', 1000), c('C', 'C1', 'mid', '0', { capacitance: 1e-6 })], source: 'V1', axis: [0, 1, 2], text: 'V1 in 0 0\nR1 in out 2k\nL1 out mid 10m\nR2 mid 0 1k\nC1 mid 0 1u', voltages: { in: [0, 1, 2], out: [0, 1 / 3, 2 / 3], mid: [0, 1 / 3, 2 / 3] }, currents: { V1: [0, -1 / 3000, -2 / 3000], L1: [0, 1 / 3000, 2 / 3000] } },
];

describe('bounded native JSON DC sweeps', () => {
  it.each(fixtures)('$name: baseline core-native and WASM-text control', async fixture => {
    const [start, middle, stop] = fixture.axis as [number, number, number];
    const step = middle - start;
    const native = request({ ...base, circuit: { nets: ['in', 'out', 'mid'], components: fixture.components }, analyses: [{ type: 'dc', source: fixture.source, start, stop, step }] });
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const core = (await simulateProtocolV1(native)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `${fixture.text}\n.dc ${fixture.source} ${start} ${stop} ${step}` } }, { requestId: 'baseline-text' });
      expect(text, JSON.stringify(text)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!text.ok || core?.type !== 'dc' || text.data.analyses[0]?.type !== 'dc') throw new Error('Expected DC controls');
      const actual = text.data.analyses[0];
      let maxError = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(core[field]).sort());
        for (const [name, values] of Object.entries(core[field])) {
          expect(actual[field][name]).toHaveLength(values.length);
          values.forEach((value, i) => { const error = Math.abs(actual[field][name]![i]! - value); maxError = Math.max(maxError, error); expect(error).toBeLessThanOrEqual(tol(value)); });
        }
      }
      process.stdout.write(`baseline DC ${JSON.stringify({ name: fixture.name, axis: actual.axis.values, voltages: actual.voltagesV, currents: actual.currentsA, maxError })}\n`);
    } finally { await wasm.close(); }
  });
  it.each(fixtures)('$name: validates and matches analytic, core and WASM text samples', async fixture => {
    const axis = fixture.axis;
    const analysis = { type: 'dc' as const, source: fixture.source, start: axis[0]!, stop: axis[2]!, step: axis[1]! - axis[0]! };
    const native = request({ ...base, circuit: { nets: ['in', 'out', 'mid'], components: fixture.components }, analyses: [analysis] });
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const validation = await wasm.validate(native, { requestId: 'native-validation' });
      expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
      const result = await wasm.simulate(native, { requestId: 'native-dc' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) throw new Error(result.error.message);
      const core = (await simulateProtocolV1(native)).analyses[0];
      const text = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: `${fixture.text}\n.dc ${fixture.source} ${analysis.start} ${analysis.stop} ${analysis.step}` } }, { requestId: 'text-dc' });
      expect(text, JSON.stringify(text)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      const actual = result.data.analyses[0];
      if (!text.ok || actual?.type !== 'dc' || core?.type !== 'dc' || text.data.analyses[0]?.type !== 'dc') throw new Error('Expected DC results');
      expect(actual.axis.values).toEqual(axis);
      for (const [field, values] of Object.entries({ voltagesV: fixture.voltages, currentsA: fixture.currents })) {
        const vectors = actual[field as 'voltagesV' | 'currentsA'];
        for (const [name, expected] of Object.entries(values) as [string, number[]][]) expected.forEach((value, i) => expect(Math.abs(vectors[name]![i]! - value), `${field}.${name}[${i}]`).toBeLessThanOrEqual(tol(value)));
      }
      let maxError = 0;
      for (const ref of [core, text.data.analyses[0]]) for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(ref[field]).sort());
        for (const [name, values] of Object.entries(ref[field])) {
          expect(actual[field][name]).toHaveLength(values.length);
          values.forEach((value, i) => { const error = Math.abs(actual[field][name]![i]! - value); maxError = Math.max(maxError, error); expect(error, `${fixture.name} ${field}.${name}[${i}]`).toBeLessThanOrEqual(tol(value)); });
        }
      }
      process.stdout.write(`native DC parity ${JSON.stringify({ name: fixture.name, axis: actual.axis.values, voltages: actual.voltagesV, currents: actual.currentsA, maxError })}\n`);
    } finally { await wasm.close(); }
  });

  it.each([
    ['zero step', { ...sweep, step: 0 }], ['wrong direction', { ...sweep, step: -1 }],
    ['missing source', { ...sweep, source: 'Vmissing' }], ['wrong-kind source', { ...sweep, source: 'R1' }],
    ['nonfinite step', { ...sweep, step: Infinity }],
  ])('rejects %s with a structured error', async (_name, analysis) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try { for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) {
      const result = await execute(request({ ...base, analyses: [analysis] }), { requestId: 'invalid' });
      expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^(INVALID_REQUEST|INVALID_CIRCUIT)$/) } });
    } } finally { await wasm.close(); }
  });

  it.each(['C', 'L'])('rejects undeclared %s net', async type => {
    const component = c(type, `${type}1`, 'absent', '0', type === 'C' ? { capacitance: 1e-6 } : { inductance: 0.01 });
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try { const result = await wasm.simulate(request({ ...base, circuit: { ...base.circuit, components: [...base.circuit.components, component] } }), { requestId: 'net' }); expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } }); } finally { await wasm.close(); }
  });

  it('rejects a singular circuit', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try { const result = await wasm.simulate(request({ ...base, circuit: { nets: ['x', 'y'], components: [c('V', 'V1', 'x', 'y', { dc: 0 }), r('R1', 'x', 'y', 1000)] } }), { requestId: 'singular' }); expect(result).toMatchObject({ ok: false, error: { code: 'SINGULAR_MATRIX', phase: 'solve' } }); } finally { await wasm.close(); }
  });

  it.each([
    ['point', { maxResultPoints: 2 }, 'maxResultPoints'],
    ['component', { maxComponents: 2 }, 'maxComponents'],
    ['source byte', { maxSourceBytes: 1 }, 'maxSourceBytes'],
    ['serialized byte', { maxSerializedResultBytes: 1 }, 'maxSerializedResultBytes'],
  ])('enforces %s limit', async (_name, limits, limit) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try { const result = await wasm.simulate(request(base, { limits }), { requestId: 'limit' }); expect(result).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit } } }); } finally { await wasm.close(); }
  });

  it.each([
    ['nested sweep', { ...base, analyses: [{ ...sweep, secondary: { source: 'V2', start: 0, stop: 1, step: 1 } }] }],
    ['model', { ...base, models: [{ name: 'Dmod', type: 'D', params: {} }] }],
  ])('rejects unsupported %s without partial execution', async (_name, document) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try { for (const execute of [wasm.validate.bind(wasm), wasm.simulate.bind(wasm)]) { const result = await execute(request(document as SpiceTsCircuitDocumentV1), { requestId: 'unsupported' }); expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: expect.any(String) } } }); if (!result.ok) expect(result.error.details?.feature).not.toBe('analysis'); expect(result).not.toHaveProperty('data'); } } finally { await wasm.close(); }
  });
});
