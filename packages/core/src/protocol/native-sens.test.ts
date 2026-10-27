import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parseTitleless } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { circuitFromDocument, mapProtocolErrorV1 } from './adapter.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import type { SpiceTsCircuitDocumentV1 } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
const schemaId = 'https://spice-ts.dev/schemas/v1/simulation-request.schema.json';
const request = (document: SpiceTsCircuitDocumentV1) => ({ apiVersion: '1', input: { format: 'spice-ts', document } });
function document(): SpiceTsCircuitDocumentV1 {
  return {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in', 'out'], components: [
      { type: 'V', id: 'v', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
      { type: 'R', id: 'r1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
      { type: 'R', id: 'r2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 2000 } },
    ] },
    analyses: [{ type: 'sens', mode: 'dc', outputNode: 'out' }],
  };
}

describe('native DC sensitivity', () => {
  it.each([
    [{ outputNode: 'OUT', outputReferenceNode: 'IN', outputType: 'voltage' }, 'V(OUT,IN)'],
    [{ outputNode: 'out', outputReferenceNode: 'gnd' }, 'V(out,gnd)'],
    [{ outputNode: '0' }, 'V(0)'],
    [{ outputNode: 'v1', outputType: 'current' }, 'I(v1)'],
  ] as const)('matches text divider output %j exactly', async (output, expression) => {
    const doc = document();
    Object.assign(doc.analyses[0], output);
    expect(ajv.validate(schemaId, request(doc))).toBe(true);
    const expected = (await simulate(parseTitleless(`V1 in 0 1\nR1 in out 1k\nR2 out 0 2k\n.sens ${expression}`))).sensitivity!;
    const actual = (await simulate(circuitFromDocument(doc))).sensitivity!;
    // Text canonicalizes ground aliases and omits explicit voltage type; native preserves request metadata.
    expect(actual).toEqual({ ...expected, outputReferenceNode: 'outputReferenceNode' in output ? output.outputReferenceNode : undefined, outputType: 'outputType' in output ? output.outputType : undefined });
  });

  it.each([
    [{ outputNode: 'out' }, 'V(out)'],
    [{ outputNode: 'out', outputReferenceNode: 'in' }, 'V(out,in)'],
    [{ outputNode: 'v1', outputType: 'current' }, 'I(v1)'],
  ] as const)('matches text BJT bias output %j exactly', async (output, expression) => {
    const doc = document();
    doc.circuit.components[0].params.dc = 5;
    doc.circuit.components[2] = {
      type: 'V', id: 'vb', name: 'VB', ports: [{ name: 'p', net: 'base' }, { name: 'n', net: '0' }], params: { dc: 0.65 },
    };
    doc.circuit.components.push({
      type: 'Q', id: 'q', name: 'Q1', model: 'NMOD', params: {},
      ports: [{ name: 'collector', net: 'out' }, { name: 'base', net: 'base' }, { name: 'emitter', net: '0' }],
    });
    doc.circuit.nets.push('base');
    doc.models.push({ name: 'NMOD', type: 'NPN', params: { IS: 1e-15, BF: 100 } });
    Object.assign(doc.analyses[0], output);
    expect(ajv.validate(schemaId, request(doc))).toBe(true);
    const expected = (await simulate(parseTitleless(`V1 in 0 5\nR1 in out 1k\nVB base 0 0.65\nQ1 out base 0 NMOD\n.model NMOD NPN(IS=1e-15 BF=100)\n.sens ${expression}`))).sensitivity!;
    expect(expected.entries.some(entry => entry.device === 'Q1')).toBe(true);
    expect((await simulate(circuitFromDocument(doc))).sensitivity).toEqual(expected);
  });

  it('does not accept unused net declarations as output nodes', () => {
    const doc = document();
    doc.circuit.nets.push('missing');
    Object.assign(doc.analyses[0], { outputNode: 'missing' });
    expect(() => circuitFromDocument(doc)).toThrow('Invalid native field at /input/document/analyses/0/outputNode');
  });

  it('requires an actual voltage source, not a source-like name', () => {
    const doc = document();
    doc.circuit.components[0].type = 'I';
    Object.assign(doc.analyses[0], { outputType: 'current', outputNode: 'V1' });
    expect(() => circuitFromDocument(doc)).toThrow('Invalid native field at /input/document/analyses/0/outputNode');
  });

  it.each([
    ['mode', undefined], ['mode', 'ac'], ['mode', null], ['mode', 1],
    ['outputNode', undefined], ['outputNode', ''], ['outputNode', '  '], ['outputNode', null], ['outputNode', 1],
    ['outputReferenceNode', ''], ['outputReferenceNode', '  '], ['outputReferenceNode', null], ['outputReferenceNode', 1],
    ['outputType', 'power'], ['outputType', null], ['outputType', 1],
    ['points', 1], ['extra/~', true],
  ])('schema and adapter reject malformed %s=%j', (field, value) => {
    const doc = document();
    Object.assign(doc.analyses[0], { [field]: value });
    expect(ajv.validate(schemaId, request(doc))).toBe(false);
    try {
      circuitFromDocument(doc);
      expect.fail('malformed sensitivity accepted');
    } catch (error) {
      expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/analyses/0/${field.replaceAll('~', '~0').replaceAll('/', '~1')}` } });
    }
  });

  it.each([
    { outputNode: 'missing' }, { outputReferenceNode: 'missing' },
    { outputType: 'current', outputNode: 'missing' },
    { outputType: 'current', outputNode: 'R1' },
    { outputType: 'current', outputNode: 'V1', outputReferenceNode: '0' },
  ])('rejects invalid output %j with a structured path', output => {
    const doc = document();
    Object.assign(doc.analyses[0], output);
    const field = 'outputReferenceNode' in output ? 'outputReferenceNode' : 'outputNode';
    try {
      circuitFromDocument(doc);
      expect.fail('invalid output accepted');
    } catch (error) {
      expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/analyses/0/${field}` } });
    }
  });

  it('schema rejects current output with a voltage reference', () => {
    const doc = document();
    Object.assign(doc.analyses[0], { outputType: 'current', outputNode: 'V1', outputReferenceNode: '0' });
    expect(ajv.validate(schemaId, request(doc))).toBe(false);
  });

  it('matches text divider sensitivity exactly with default voltage output', async () => {
    const doc = document();
    const expected = (await simulate(parseTitleless('V1 in 0 1\nR1 in out 1k\nR2 out 0 2k\n.sens V(out)'))).sensitivity!;
    expect(expected.entries.length).toBeGreaterThan(0);
    expect((await simulate(circuitFromDocument(doc))).sensitivity).toEqual(expected);
    expect(ajv.validate(schemaId, request(doc))).toBe(true);
  });
});
