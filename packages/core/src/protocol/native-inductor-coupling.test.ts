import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

function document(k = 0.8): SpiceTsCircuitDocumentV1 {
  const component = (type: string, name: string, p: string, n: string, params: Record<string, number | string>) => ({ type, id: name, name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params });
  return { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in', 'primary', 'out'], components: [
      component('V', 'V1', 'in', '0', { waveform: 'ac', dc: 0, magnitude: 1 }),
      component('R', 'Rs', 'in', 'primary', { resistance: 10 }),
      component('L', 'L1', 'primary', '0', { inductance: 0.01 }),
      component('L', 'L2', 'out', '0', { inductance: 0.04 }),
      component('R', 'R1', 'out', '0', { resistance: 100 }),
      { type: 'K', id: 'K1', name: 'K1', ports: [], params: { inductorA: 'L1', inductorB: 'L2', coupling: k } },
    ] }, analyses: [{ type: 'ac', variation: 'lin', points: 5, startFreq: 100, stopFreq: 500 }] };
}
const native = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });
const text = (k: number): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 dc 0 ac 1\nRs in primary 10\nL1 primary 0 0.01\nL2 out 0 0.04\nR1 out 0 100\nK1 L1 L2 ${k}\n.ac lin 5 100 500\n.end` } });
type Complex = { re: number; im: number };
const mul = (a: Complex, b: Complex): Complex => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const div = (a: Complex, b: Complex): Complex => ({ re: (a.re * b.re + a.im * b.im) / (b.re ** 2 + b.im ** 2), im: (a.im * b.re - a.re * b.im) / (b.re ** 2 + b.im ** 2) });
const rectangular = (p: { magnitude: number; phaseDegrees: number }): Complex => ({ re: p.magnitude * Math.cos(p.phaseDegrees * Math.PI / 180), im: p.magnitude * Math.sin(p.phaseDegrees * Math.PI / 180) });
function compare(label: string, actual: Complex[], expected: Complex[]) {
  expect(actual.length).toBeGreaterThanOrEqual(5);
  expect(actual.length).toBe(expected.length);
  expect([...actual, ...expected].every(v => Number.isFinite(v.re) && Number.isFinite(v.im))).toBe(true);
  const scale = Math.max(1e-12, ...expected.map(v => Math.hypot(v.re, v.im)));
  const errors = actual.map((v, i) => Math.hypot(v.re - expected[i]!.re, v.im - expected[i]!.im) / scale);
  const max = Math.max(...errors), rms = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);
  console.info(`${label}: matched=${actual.length} normalizedMax=${max} normalizedRms=${rms}`);
  expect(max).toBeLessThanOrEqual(1e-9);
}

describe('native inductor coupling', () => {
  it.each([0, 0.8, -0.8, 1, -1])('matches SPICE and analytic transformer at k=%s', async k => {
    const doc = document(k);
    doc.circuit.components[5]!.params.inductorA = 'l1';
    doc.circuit.components[5]!.params.inductorB = 'l2';
    doc.circuit.components.reverse();
    const a = (await simulateProtocolV1(native(doc))).analyses[0];
    const b = (await simulateProtocolV1(text(k))).analyses[0];
    if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('expected AC');
    expect(a.frequencyHz).toEqual(b.frequencyHz);
    compare(`k=${k} secondary`, a.voltagePhasors.out!.map(rectangular), b.voltagePhasors.out!.map(rectangular));
    compare(`k=${k} primary inductor current`, a.currentPhasors.L1!.map(rectangular), b.currentPhasors.L1!.map(rectangular));
    // Solve the two coupled winding equations independently: V2=jωM I1/(1+jωL2/R),
    // 1=(Rs+jωL1)I1+jωM I2, with I2=-V2/R and source current=-I1.
    const w = 2 * Math.PI * a.frequencyHz[0]!;
    const jwM = { re: 0, im: w * k * Math.sqrt(0.01 * 0.04) };
    const ratio = div(jwM, { re: 1, im: w * 0.04 / 100 });
    const feedback = mul(jwM, ratio);
    const i1 = div({ re: 1, im: 0 }, { re: 10 - feedback.re / 100, im: w * 0.01 - feedback.im / 100 });
    const expected = mul(ratio, i1);
    const actual = rectangular(a.voltagePhasors.out![0]!);
    console.info(`analytic k=${k} f=${a.frequencyHz[0]} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    expect(Math.hypot(actual.re - expected.re, actual.im - expected.im)).toBeLessThan(1e-9);
  });

  it.each([
    ['missing reference', '/params/inductorA', (d: SpiceTsCircuitDocumentV1) => { delete d.circuit.components[5]!.params.inductorA; }],
    ['non-L reference', '/params/inductorA', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.params.inductorA = 'R1'; }],
    ['unknown reference', '/params/inductorA', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.params.inductorA = 'L9'; }],
    ['self reference', '/params/inductorB', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.params.inductorB = 'l1'; }],
    ['malformed reference', '/params/inductorA', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.params.inductorA = ' L1'; }],
    ['duplicate reference target', '/params/inductorA', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components.push({ ...d.circuit.components[2]! }); }],
    ['ports', '/ports', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.ports.push({ name: 'p', net: '0' }); }],
    ['missing id', '/id', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.id = ''; }],
    ['missing name', '/name', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.name = ''; }],
    ['missing params', '/params', (d: SpiceTsCircuitDocumentV1) => { Object.assign(d.circuit.components[5]!, { params: null }); }],
    ['missing coupling', '/params/coupling', (d: SpiceTsCircuitDocumentV1) => { delete d.circuit.components[5]!.params.coupling; }],
    ['duplicate name', '/name', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components.push({ ...d.circuit.components[5]!, id: 'other' }); }],
    ['duplicate id', '/id', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components.push({ ...d.circuit.components[5]!, name: 'K2' }); }],
    ['unknown param', '/params/extra', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.params.extra = 1; }],
    ['duplicate param spelling', '/params/InductorA', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.params.InductorA = 'L1'; }],
    ['unknown field', '/extra', (d: SpiceTsCircuitDocumentV1) => { Object.assign(d.circuit.components[5]!, { extra: 1 }); }],
    ...[NaN, Infinity, -Infinity, 1.01, -1.01, '0.8'].map(value => [`invalid coupling ${value}`, '/params/coupling', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[5]!.params.coupling = value; }] as const),
  ] as const)('rejects %s at its field path', async (_label, suffix, mutate) => {
    const d = document(); mutate(d);
    const result = await executeProtocolV1(native(d));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/circuit/components/5${suffix}` } } });
  });
  it.each(['op', 'dc', 'tran', 'sp'] as const)('rejects %s analysis', async type => {
    const d = document(); Object.assign(d.analyses[0]!, { type });
    expect(await executeProtocolV1(native(d))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/analyses/0/type' } } });
  });
  it('rejects K inside a subcircuit', async () => {
    const d = document(); d.subcircuits.push({ name: 'S', ports: [], components: [d.circuit.components[5]!] });
    expect(await executeProtocolV1(native(d))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/subcircuits/0/components/0/type' } } });
  });
});
