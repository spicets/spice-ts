import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

function document(polarity: 'NJF' | 'PJF' = 'NJF', sweep = false, area = 1): SpiceTsCircuitDocumentV1 {
  const sign = polarity === 'NJF' ? 1 : -1;
  return {
    format: 'spice-ts', schemaVersion: '1.0', models: [{ name: 'JM', type: polarity, params: { VTO: -2, BETA: 0.001 } }], subcircuits: [],
    circuit: { nets: ['supply', 'd', 'g'], components: [
      { type: 'V', id: 'Vd', name: 'Vd', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: '0' }], params: { dc: sign * 3 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: 'd' }], params: { resistance: 100 } },
      { type: 'V', id: 'Vg', name: 'Vg', ports: [{ name: 'p', net: 'g' }, { name: 'n', net: '0' }], params: { dc: -sign } },
      { type: 'J', id: 'J1', name: 'J1', ports: [{ name: 'source', net: '0' }, { name: 'drain', net: 'd' }, { name: 'gate', net: 'g' }], params: { AREA: area }, model: 'JM' },
    ] }, analyses: sweep ? [{ type: 'dc', source: 'Vg', start: -sign * 2, stop: 0, step: sign * 0.25 }] : [{ type: 'op' }],
  };
}
const native = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });
function text(polarity: 'NJF' | 'PJF', sweep: boolean, area: number): SimulationRequestV1 {
  const sign = polarity === 'NJF' ? 1 : -1;
  return { apiVersion: '1', input: { format: 'spice', source: `Vd supply 0 ${sign * 3}\nR1 supply d 100\nVg g 0 ${-sign}\nJ1 d g 0 JM AREA=${area}\n.model JM ${polarity} VTO=-2 BETA=0.001\n${sweep ? `.dc Vg ${-sign * 2} 0 ${sign * 0.25}` : '.op'}` } };
}
function compare(label: string, actual: number[], expected: number[]) {
  expect(actual.length).toBeGreaterThan(0);
  expect(actual.length).toBe(expected.length);
  expect(actual.every(Number.isFinite) && expected.every(Number.isFinite)).toBe(true);
  const scale = Math.max(1e-12, ...expected.map(Math.abs));
  const error = Math.max(...actual.map((v, i) => Math.abs(v - expected[i]!) / scale));
  console.info(`${label}: expected=${expected[0]} actual=${actual[0]} points=${actual.length} normalizedMaxError=${error}`);
  expect(error).toBeLessThanOrEqual(1e-9);
}

describe('native level-1 JFET', () => {
  it.each(['NJF', 'PJF'] as const)('%s OP and gate sweep match SPICE for AREA variations', async polarity => {
    for (const area of [1, 2]) for (const sweep of [false, true]) {
      const a = (await simulateProtocolV1(native(document(polarity, sweep, area)))).analyses[0];
      const b = (await simulateProtocolV1(text(polarity, sweep, area))).analyses[0];
      if (a?.type === 'op' && b?.type === 'op') {
        compare(`${polarity} area=${area} OP drain`, [a.voltagesV.d!], [b.voltagesV.d!]);
        compare(`${polarity} area=${area} OP Vd`, [a.currentsA.Vd!], [b.currentsA.Vd!]);
        expect(Math.abs(a.currentsA.Vd!)).toBeGreaterThan(1e-8);
      } else if (a?.type === 'dc' && b?.type === 'dc') {
        expect(a.axis.values.length).toBeGreaterThanOrEqual(5);
        compare(`${polarity} area=${area} DC drain`, a.voltagesV.d!, b.voltagesV.d!);
        compare(`${polarity} area=${area} DC Vd`, a.currentsA.Vd!, b.currentsA.Vd!);
      } else throw new Error('unexpected result type');
    }
  });
  it('accepts positional ports and supported instance values', async () => {
    const d = document();
    const j = d.circuit.components[3]!;
    d.models[0]!.params.LEVEL = 1;
    delete j.model;
    j.ports = [{ name: '2', net: '0' }, { name: '0', net: 'd' }, { name: '1', net: 'g' }];
    j.params = { modelName: 'JM', M: 2, OFF: true, ICVDS: 0.5, ICVGS: -1 };
    const a = (await simulateProtocolV1(native(d))).analyses[0];
    const b = (await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: 'Vd supply 0 3\nR1 supply d 100\nVg g 0 -1\nJ1 d g 0 JM M=2 OFF IC=0.5,-1\n.model JM NJF LEVEL=1 VTO=-2 BETA=0.001\n.op' } })).analyses[0];
    if (a?.type !== 'op' || b?.type !== 'op') throw new Error('expected OP');
    compare('instance M and IC', [a.currentsA.Vd!], [b.currentsA.Vd!]);
  });
  it.each([
    ['missing model', (d: SpiceTsCircuitDocumentV1) => { delete d.circuit.components[3]!.model; }],
    ['unknown model', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.model = 'missing'; }],
    ['level 2', (d: SpiceTsCircuitDocumentV1) => { d.models[0]!.params.LEVEL = 2; }],
    ['wrong model type', (d: SpiceTsCircuitDocumentV1) => { d.models[0]!.type = 'NPN'; }],
    ['missing port', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.ports.pop(); }],
    ['duplicate port', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.ports[0]!.name = 'drain'; }],
    ['invalid port', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.ports[0]!.net = ''; }],
    ['unknown port', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.ports[0]!.name = 'other'; }],
    ['unknown port field', (d: SpiceTsCircuitDocumentV1) => { Object.assign(d.circuit.components[3]!.ports[0]!, { bogus: 1 }); }],
    ...['AREA', 'M', 'ICVDS', 'ICVGS'].flatMap(field => ['bad', NaN, Infinity].map(value => [`${field} ${value}`, (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.params[field] = value; }] as const)),
    ['zero area', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.params.AREA = 0; }],
    ['bad OFF', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.params.OFF = 1; }],
    ['unknown param', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.params.bogus = 1; }],
    ['unknown component field', (d: SpiceTsCircuitDocumentV1) => { Object.assign(d.circuit.components[3]!, { bogus: 1 }); }],
    ['missing params', (d: SpiceTsCircuitDocumentV1) => { Object.assign(d.circuit.components[3]!, { params: null }); }],
    ['conflicting model names', (d: SpiceTsCircuitDocumentV1) => { d.circuit.components[3]!.params.modelName = 'other'; }],
    ['JFET in subcircuit', (d: SpiceTsCircuitDocumentV1) => { d.subcircuits.push({ name: 'S', ports: [], components: [d.circuit.components[3]!] }); }],
  ] as const)('rejects %s with a structured error', async (_name, mutate) => {
    const d = document();
    mutate(d);
    const result = await executeProtocolV1(native(d));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
  });
});
