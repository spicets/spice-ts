import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Circuit } from '../circuit.js';
import { circuitFromDocument, simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const name of Object.keys(protocolSchemasV1)) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
}
const schema = 'https://spice-ts.dev/schemas/v1/simulation-request.schema.json';
const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({
  type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params,
});
function document(): SpiceTsCircuitDocumentV1 {
  return {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['out'], components: [
      component('R', 'R1', ['out', '0'], { resistance: 1000 }),
      component('C', 'C1', ['out', '0'], { capacitance: 0.000001 }),
    ] }, analyses: [{ type: 'tran', timestep: 0.0001, stopTime: 0.001, uic: true }],
    initialConditions: { out: 1 },
  };
}
const request = (doc = document()): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });

describe('native initial state', () => {
  it.each(['initialConditions', 'nodesets'] as const)('guards hierarchical expansion before validating %s', async field => {
    const doc = document();
    doc.circuit.components = [{ ...component('X', 'XTOP', ['out', '0'], {}), subcircuit: 'outer' }];
    doc.subcircuits = [
      { name: 'inner', ports: ['a', 'b'], components: [component('R', 'R1', ['a', 'b'], { resistance: 1000 })] },
      { name: 'outer', ports: ['a', 'b'], components: [{ ...component('X', 'X1', ['a', 'b'], {}), subcircuit: 'inner' }] },
    ];
    delete doc.initialConditions;
    doc[field] = { out: 1 };
    const bounded = { ...request(doc), options: { limits: { maxSubcircuitDepth: 1 } } };
    const compile = vi.spyOn(Circuit.prototype, 'compile');
    try {
      await expect(validateProtocolV1(bounded)).rejects.toMatchObject({ apiError: {
        code: 'RESOURCE_LIMIT', phase: 'compile', details: { limit: 'maxSubcircuitDepth', configured: 1, observed: 2 },
      } });
      expect(compile).toHaveBeenCalledTimes(1);
      expect(compile.mock.calls.every(([guard]) => guard !== undefined)).toBe(true);
    } finally {
      compile.mockRestore();
    }
  });
  it.each(['initialConditions', 'nodesets'] as const)('normalizes ground aliases in %s before execution', async field => {
    for (const ground of ['gnd', 'GND', 'GnD', '0']) {
      const doc = document();
      doc[field] = { out: 1, [ground]: 0 };
      expect(await validateProtocolV1(request(doc))).toMatchObject({ status: 'valid' });
      const compiled = circuitFromDocument(doc).compile();
      expect(compiled[field === 'initialConditions' ? 'initialConditions' : 'nodeSets']).toContainEqual({ node: '0', value: 0 });
      const canonical = document();
      canonical[field] = { out: 1, '0': 0 };
      expect(await simulateProtocolV1(request(doc))).toEqual(await simulateProtocolV1(request(canonical)));
    }
  });
  it.each(['initialConditions', 'nodesets'] as const)('rejects nonzero ground in %s at the state pointer', async field => {
    for (const ground of ['0', 'gnd', 'GND', 'GnD']) {
      for (const value of [-1, 1]) {
        const doc = document();
        doc[field] = { [ground]: value };
        const error = { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/${field}/${ground}` } };
        await expect(validateProtocolV1(request(doc))).rejects.toMatchObject({ apiError: error });
        expect(await executeProtocolV1(request(doc))).toMatchObject({ ok: false, error });
      }
    }
  });
  it('accepts case-insensitive expanded nodes and ground, but not phantom nets', async () => {
    const doc = document();
    doc.circuit = { nets: ['out', 'phantom'], components: [
      { ...component('X', 'X1', ['out', '0'], {}), subcircuit: 'cell' },
    ] };
    doc.subcircuits = [{ name: 'cell', ports: ['a', 'b'], components: [
      component('R', 'R1', ['a', 'mid'], { resistance: 1000 }),
      component('C', 'C1', ['mid', 'b'], { capacitance: 0.000001 }),
    ] }];
    doc.initialConditions = { 'X1.MID': 1, '0': 0 };
    doc.nodesets = { out: 0.5 };
    expect(await validateProtocolV1(request(doc))).toMatchObject({ status: 'valid' });
    expect(circuitFromDocument(doc).compile().initialConditions).toContainEqual({ node: 'X1.MID', value: 1 });
    doc.initialConditions = { phantom: 1 };
    expect(await executeProtocolV1(request(doc))).toMatchObject({ ok: false, error: { phase: 'validation', details: { path: '/input/document/initialConditions/phantom' } } });
  });
  it.each(['initialConditions', 'nodesets'] as const)('rejects malformed %s values in the shipped schema', field => {
    for (const states of [null, [], 1, { out: '1' }, { out: null }, { out: Infinity }, { out: NaN }]) {
      const doc = document();
      Object.assign(doc, { [field]: states });
      expect(ajv.validate(schema, request(doc))).toBe(false);
    }
  });
  it.each(['initialConditions', 'nodesets'] as const)('rejects invalid %s with exact validation paths', async field => {
    for (const [states, suffix] of [
      [{ missing: 1 }, '/missing'], [{ 'missing/~': 1 }, '/missing~1~0'],
      [{ out: Infinity }, '/out'], [{ out: -Infinity }, '/out'], [{ out: NaN }, '/out'],
      [{ out: '1' }, '/out'], [null, ''], [[], ''], [1, ''],
    ] as const) {
      const doc = document();
      Object.assign(doc, { [field]: states });
      expect(await executeProtocolV1(request(doc))).toMatchObject({ ok: false, error: {
        code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/${field}${suffix}` },
      } });
      await expect(validateProtocolV1(request(doc))).rejects.toMatchObject({ apiError: { phase: 'validation' } });
    }
  });
  it.each([false, 'true', 1, null])('rejects invalid uic %j in adapter and schema', async uic => {
    const doc = document();
    Object.assign(doc.analyses[0], { uic });
    expect(ajv.validate(schema, request(doc))).toBe(false);
    expect(await executeProtocolV1(request(doc))).toMatchObject({ ok: false, error: {
      code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/analyses/0/uic' },
    } });
  });
  it('matches text diode OP with nodeset hints', async () => {
    const doc = document();
    delete doc.initialConditions;
    doc.nodesets = { out: 0.5 };
    doc.analyses = [{ type: 'op' }];
    doc.models = [{ name: 'DM', type: 'D', params: { IS: 1e-14 } }];
    doc.circuit = { nets: ['in', 'out'], components: [
      component('V', 'V1', ['in', '0'], { dc: 1 }),
      component('R', 'R1', ['in', 'out'], { resistance: 1000 }),
      { ...component('D', 'D1', ['out', '0'], {}), model: 'DM' },
    ] };
    expect(ajv.validate(schema, request(doc))).toBe(true);
    expect(circuitFromDocument(doc).compile().nodeSets).toEqual([{ node: 'out', value: 0.5 }]);
    const expected = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1000\nD1 out 0 DM\n.model DM D(IS=1e-14)\n.nodeset v(out)=0.5\n.op' } });
    const actual = await simulateProtocolV1(request(doc));
    expect(actual).toEqual(expected);
    expect(actual.analyses[0]).toMatchObject({ type: 'op', voltagesV: { in: 1 } });
  });
  it('matches the entire text RC UIC transient exactly with a nonzero initial state', async () => {
    const actual = await simulateProtocolV1(request());
    const expected = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: 'R1 out 0 1000\nC1 out 0 1u\n.ic v(out)=1\n.tran 0.0001 0.001 uic' } });
    expect(actual).toEqual(expected);
    const tran = actual.analyses[0];
    if (tran.type !== 'tran') throw new Error('Expected transient');
    expect(tran.voltagesV.out[0]).toBeGreaterThan(0.99);
    expect(tran.voltagesV.out.at(-1)).toBeLessThan(0.5);
    expect(ajv.validate(schema, request())).toBe(true);
  });
});
