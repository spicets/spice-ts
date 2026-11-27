import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

type Polarity = 'NJF' | 'PJF';
function document(polarity: Polarity, direction: 'op' | 'up' | 'down', scaled: boolean): SpiceTsCircuitDocumentV1 {
  const sign = polarity === 'NJF' ? 1 : -1;
  return {
    format: 'spice-ts', schemaVersion: '1.0', models: [{ name: 'JM', type: polarity, params: { LEVEL: 2, VTO: -2, BETA: 0.001 } }], subcircuits: [],
    circuit: { nets: ['supply', 'd', 'g'], components: [
      { type: 'V', id: 'Vd', name: 'Vd', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: '0' }], params: { dc: sign * 3 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: 'd' }], params: { resistance: 100 } },
      { type: 'V', id: 'Vg', name: 'Vg', ports: [{ name: 'p', net: 'g' }, { name: 'n', net: '0' }], params: { dc: -sign } },
      { type: 'J', id: 'J1', name: 'J1', ports: scaled ? [{ name: '2', net: '0' }, { name: '0', net: 'd' }, { name: '1', net: 'g' }] : [{ name: 'source', net: '0' }, { name: 'drain', net: 'd' }, { name: 'gate', net: 'g' }], params: scaled ? { AREA: 2, M: 3 } : {}, model: 'JM' },
    ] }, analyses: direction === 'op' ? [{ type: 'op' }] : [{ type: 'dc', source: 'Vg', start: direction === 'up' ? -2 : 2, stop: direction === 'up' ? 2 : -2, step: direction === 'up' ? 0.5 : -0.5 }],
  };
}
const native = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });
function text(polarity: Polarity, direction: 'op' | 'up' | 'down', scaled: boolean): SimulationRequestV1 {
  const sign = polarity === 'NJF' ? 1 : -1;
  return { apiVersion: '1', input: { format: 'spice', source: `Vd supply 0 ${sign * 3}\nR1 supply d 100\nVg g 0 ${-sign}\nJ1 d g 0 JM ${scaled ? 'AREA=2 M=3' : ''}\n.model JM ${polarity} LEVEL=2 VTO=-2 BETA=0.001\n${direction === 'op' ? '.op' : direction === 'up' ? '.dc Vg -2 2 0.5' : '.dc Vg 2 -2 -0.5'}` } };
}
function compare(label: string, actual: number[], expected: number[]) {
  expect(actual.length).toBeGreaterThan(0);
  expect(actual.length).toBe(expected.length);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i]! - expected[i]!);
    expect(Number.isFinite(delta)).toBe(true);
    expect(delta).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected[i]!)));
    max = Math.max(max, delta);
    sum += delta * delta;
  }
  console.info(`${label}: maxAbs=${max} rmsAbs=${Math.sqrt(sum / actual.length)} points=${actual.length}`);
}

describe('native level-2 JFET OP/DC', () => {
  it.each(['NJF', 'PJF'] as const)('%s matches text with defaults and scaling in OP and both sweep directions', async polarity => {
    for (const scaled of [false, true]) for (const direction of ['op', 'up', 'down'] as const) {
      const a = (await simulateProtocolV1(native(document(polarity, direction, scaled)))).analyses[0];
      const b = (await simulateProtocolV1(text(polarity, direction, scaled))).analyses[0];
      if (a?.type === 'op' && b?.type === 'op') {
        compare(`${polarity} ${scaled} OP drain`, [a.voltagesV.d!], [b.voltagesV.d!]);
        for (const source of ['Vd', 'Vg']) compare(`${polarity} ${scaled} OP ${source}`, [a.currentsA[source]!], [b.currentsA[source]!]);
        expect(Math.abs(a.currentsA.Vd!)).toBeGreaterThan(1e-8);
      } else if (a?.type === 'dc' && b?.type === 'dc') {
        expect(a.axis.values.length).toBeGreaterThanOrEqual(5);
        compare(`${polarity} ${scaled} ${direction} drain`, a.voltagesV.d!, b.voltagesV.d!);
        for (const source of ['Vd', 'Vg']) compare(`${polarity} ${scaled} ${direction} ${source}`, a.currentsA[source]!, b.currentsA[source]!);
        expect(Math.max(...a.voltagesV.d!) - Math.min(...a.voltagesV.d!)).toBeGreaterThan(1e-3);
      } else throw new Error('unexpected result type');
    }
  });
  it.each(['NJF', 'PJF'] as const)('%s AREA and M scaling changes the operating point', async polarity => {
    const base = (await simulateProtocolV1(native(document(polarity, 'op', false)))).analyses[0];
    const scaled = (await simulateProtocolV1(native(document(polarity, 'op', true)))).analyses[0];
    if (base?.type !== 'op' || scaled?.type !== 'op') throw new Error('expected OP');
    expect(Math.abs(scaled.currentsA.Vd!) - Math.abs(base.currentsA.Vd!)).toBeGreaterThan(1e-5);
  });
  it.each(['tran', 'disto', 'sens', 'tf', 'sp'])('rejects %s analyses at their path', async type => {
    const d = document('NJF', 'op', false);
    Object.assign(d.analyses[0]!, { type });
    const result = await executeProtocolV1(native(d));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/analyses/0/type' } } });
  });
  it.each(['noiseAnalyses', 'poleZeroAnalyses'] as const)('rejects %s at its path', async field => {
    const d = document('PJF', 'op', false);
    Object.assign(d, { [field]: [{}] });
    const result = await executeProtocolV1(native(d));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/${field}` } } });
  });
  it.each([
    ['unknown model', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.model = 'missing'; }, 'model'],
    ['unknown level', (d: SpiceTsCircuitDocumentV1) => { d.models[0]!.params.LEVEL = 3; }, 'model'],
    ['missing port', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.ports.pop(); }, 'ports'],
    ['duplicate port', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.ports[0]!.name = 'drain'; }, 'ports'],
    ['invalid area', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.params.AREA = 0; }, 'params/AREA'],
    ['invalid multiplier', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.params.M = -1; }, 'params/M'],
  ] as const)('rejects %s with its path', async (_label, mutate, suffix) => {
    const d = document('NJF', 'op', false);
    mutate(d);
    const result = await executeProtocolV1(native(d));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/circuit/components/3/${suffix}` } } });
  });
  it('rejects a non-source DC target', async () => {
    const d = document('NJF', 'up', false);
    Object.assign(d.analyses[0]!, { source: 'R1' });
    const result = await executeProtocolV1(native(d));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/analyses/0/source' } } });
  });
});
