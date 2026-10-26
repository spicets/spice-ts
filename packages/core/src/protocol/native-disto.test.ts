import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parseTitleless } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { circuitFromDocument, mapProtocolErrorV1, validateProtocolV1 } from './adapter.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import type { SpiceTsCircuitDocumentV1 } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
const schemaId = 'https://spice-ts.dev/schemas/v1/simulation-request.schema.json';
function document(type = 'V'): SpiceTsCircuitDocumentV1 {
  return {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['out'], components: [
      { type, id: 'source', name: `${type}1`, ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }],
        params: { distortionF1: { magnitude: 0.01 }, distortionF2: { magnitude: 0.005, phase: 15 } } },
      { type: 'R', id: 'r', name: 'R1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 100 } },
    ] },
    analyses: [{ type: 'disto', variation: 'dec', points: 5, startFreq: 1e3, stopFreq: 1e5, f2OverF1: 0.9 }],
  };
}
const request = (doc: SpiceTsCircuitDocumentV1) => ({ apiVersion: '1' as const, input: { format: 'spice-ts' as const, document: doc } });

describe('native protocol distortion', () => {
  it.each(['V', 'I'])('preserves %s DISTOF excitations without DC or phase and matches text exactly', async type => {
    const doc = document(type);
    expect(ajv.validate(schemaId, request(doc))).toBe(true);
    const circuit = circuitFromDocument(doc);
    expect(circuit.toNetlist()).toContain('DISTOF1 0.01 0 DISTOF2 0.005 15');
    expect(await validateProtocolV1(request(doc))).toMatchObject({ status: 'valid', analysisCount: 1 });
    const actual = (await simulate(circuit)).distortion!;
    const expected = (await simulate(parseTitleless(`${type}1 out 0 DISTOF1 0.01 DISTOF2 0.005 15\nR1 out 0 100\n.disto dec 5 1k 100k 0.9`))).distortion!;
    expect(actual.frequencies).toEqual(expected.frequencies);
    expect(actual.products).toEqual(expected.products);
    for (const product of expected.products) expect(actual.voltage('out', product)).toEqual(expected.voltage('out', product));
  });

  it.each([
    ['distortionF1', null], ['distortionF2', []], ['distortionF1', {}],
    ['distortionF2', { magnitude: '1' }], ['distortionF1', { magnitude: 1, phase: null }],
    ['distortionF2', { magnitude: 1, unknown: 2 }],
  ])('schema and adapter reject malformed %s=%j', (field, value) => {
    const doc = document();
    Object.assign(doc.circuit.components[0].params, { [field as string]: value, dc: 0 });
    expect(ajv.validate(schemaId, request(doc))).toBe(false);
    try {
      circuitFromDocument(doc);
      expect.fail('malformed excitation accepted');
    } catch (error) {
      expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'INVALID_INPUT', phase: 'validation', details: { path: expect.stringContaining(field as string) } });
    }
  });
});
