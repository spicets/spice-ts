import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { circuitFromDocument, simulateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const component = (type: string, name: string, nets: string[], params: Record<string, number> = {}) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params,
});
function document(): SpiceTsCircuitDocumentV1 {
  return {
    format: 'spice-ts', schemaVersion: '1.0', models: [],
    globalNodes: ['VDD', 'vdd', '0', 'gnd'],
    circuit: { nets: ['VDD', 'out1', 'out2'], components: [
      component('V', 'V1', ['VDD', '0'], { dc: 4 }),
      { ...component('X', 'X1', ['out1']), subcircuit: 'outer' },
      { ...component('X', 'X2', ['out2']), subcircuit: 'outer' },
    ] },
    subcircuits: [
      { name: 'inner', ports: ['out'], components: [component('R', 'R1', ['vdd', 'out'], { resistance: 1000 }), component('R', 'R2', ['out', '0'], { resistance: 1000 })] },
      { name: 'outer', ports: ['out'], components: [{ ...component('X', 'XI', ['out']), subcircuit: 'inner' }] },
    ], analyses: [{ type: 'op' }],
  };
}
const deck = `.global VDD vdd 0 gnd
V1 VDD 0 4
.subckt inner out
R1 vdd out 1000
R2 out 0 1000
.ends inner
.subckt outer out
XI out inner
.ends outer
X1 out1 outer
X2 out2 outer`;
const request = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });

describe('native global nodes', () => {
  it.each(['op', 'dc'] as const)('matches nested text %s with shared supply', async mode => {
    const doc = document();
    doc.analyses = mode === 'op' ? [{ type: 'op' }] : [{ type: 'dc', source: 'V1', start: 2, stop: 4, step: 1 }];
    const native = await simulateProtocolV1(request(doc));
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${deck}\n.${mode === 'op' ? 'op' : 'dc V1 2 4 1'}` } });
    expect(native).toEqual(text);
    const result = native.analyses[0];
    if (result.type === 'op') {
      expect(result.voltagesV.out1).toBe(2);
      expect(result.voltagesV.out2).toBe(2);
      expect(result.currentsA.V1).toBe(-0.004);
    } else if (result.type === 'dc') {
      expect(result.voltagesV.out1).toEqual([1, 1.5, 2]);
      expect(result.voltagesV.out2).toEqual([1, 1.5, 2]);
      expect(result.currentsA.V1).toEqual([-0.002, -0.0030000000000000005, -0.004]);
    } else {
      throw new Error('Unexpected analysis type');
    }
    const nodes = [...circuitFromDocument(doc).compile().nodeIndexMap.keys()];
    expect(nodes.some(node => /x[12].*vdd/i.test(node))).toBe(false);
    expect(nodes.filter(node => node.toLowerCase() === 'vdd')).toHaveLength(1);
  });
  it('uses the core duplicate, case and ground semantics', () => {
    const circuit = circuitFromDocument(document());
    expect(circuit.globalNodes).toEqual(['VDD', 'gnd']);
  });
  it('preserves local nodes when omitted', () => {
    const doc = document();
    delete doc.globalNodes;
    const nodes = [...circuitFromDocument(doc).compile().nodeIndexMap.keys()];
    expect(nodes.filter(node => /x[12].*vdd/i.test(node))).toHaveLength(2);
  });
  it.each([[null, '/input/document/globalNodes'], ['VDD', '/input/document/globalNodes'], [[42], '/input/document/globalNodes/0'], [[''], '/input/document/globalNodes/0'], [['bad node'], '/input/document/globalNodes/0'], [['VDD\n'], '/input/document/globalNodes/0'], [['VDD', null], '/input/document/globalNodes/1']])('rejects %j at its pointer', async (value, path) => {
    const doc = document();
    Object.assign(doc, { globalNodes: value });
    expect(await executeProtocolV1(request(doc))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path } } });
  });
  it('ships a schema accepting declarations and rejecting malformed names', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const name of Object.keys(protocolSchemasV1)) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    const valid = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    expect(valid(request(document()))).toBe(true);
    for (const value of [null, 'VDD', [42], [''], ['bad node'], ['VDD\n']]) {
      const doc = document();
      Object.assign(doc, { globalNodes: value });
      expect(valid(request(doc))).toBe(false);
    }
  });
});
