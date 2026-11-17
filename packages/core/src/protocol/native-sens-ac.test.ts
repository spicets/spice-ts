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
      { type: 'V', id: 'v', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'ac', dc: 1, magnitude: 1 } },
      { type: 'R', id: 'r', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
      { type: 'C', id: 'c', name: 'C1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { capacitance: 1e-6 } },
    ] },
    analyses: [{ type: 'sens', mode: 'ac', outputNode: 'out', variation: 'dec', points: 2, startFreq: 10, stopFreq: 1000 }],
  };
}

describe('native AC sensitivity', () => {
  it.each([
    ['variation', undefined], ['variation', 'invalid'], ['variation', null],
    ['points', undefined], ['points', 0], ['points', -1], ['points', 1.5], ['points', Infinity], ['points', NaN], ['points', '2'],
    ['startFreq', undefined], ['startFreq', 0], ['startFreq', -1], ['startFreq', Infinity], ['startFreq', NaN], ['startFreq', '10'],
    ['stopFreq', undefined], ['stopFreq', 0], ['stopFreq', -1], ['stopFreq', Infinity], ['stopFreq', NaN], ['stopFreq', '1000'],
    ['outputNode', undefined], ['outputNode', ''], ['outputNode', '  '],
    ['outputReferenceNode', ''], ['outputType', 'power'], ['extra/~', true],
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

  it('rejects reversed frequencies with a structured stopFreq path', () => {
    const doc = document();
    Object.assign(doc.analyses[0], { stopFreq: 1 });
    try {
      circuitFromDocument(doc);
      expect.fail('reversed sweep accepted');
    } catch (error) {
      expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/analyses/0/stopFreq' } });
    }
  });

  it('requires sweep fields when an existing DC request switches to AC', () => {
    const doc = document();
    doc.analyses[0] = { type: 'sens', mode: 'dc', outputNode: 'out' };
    Object.assign(doc.analyses[0], { mode: 'ac' });
    expect(ajv.validate(schemaId, request(doc))).toBe(false);
    expect(() => circuitFromDocument(doc)).toThrow('Invalid native field at /input/document/analyses/0/variation');
  });

  describe.each(['rc', 'diode', 'bjt'] as const)('%s text parity', fixture => {
    describe.each(['dec', 'oct', 'lin'] as const)('%s sweep', variation => {
      it.each([
        [{ outputNode: 'out' }, 'V(out)'],
        [{ outputNode: 'out', outputReferenceNode: 'in', outputType: 'voltage' }, 'V(out,in)'],
        [{ outputNode: 'v1', outputType: 'current' }, 'I(v1)'],
      ] as const)('matches output %j exactly', async (output, expression) => {
        const doc = document();
        let source = 'V1 in 0 dc 1 ac 1\nR1 in out 1k\nC1 out 0 1u';
        if (fixture === 'diode') {
          doc.circuit.components.push({ type: 'D', id: 'd', name: 'D1', model: 'DMOD', params: {}, ports: [{ name: 'anode', net: 'out' }, { name: 'cathode', net: '0' }] });
          doc.models.push({ name: 'DMOD', type: 'D', params: { IS: 1e-14, N: 1, CJO: 1e-12 } });
          source += '\nD1 out 0 DMOD\n.model DMOD D(IS=1e-14 N=1 CJO=1e-12)';
        } else if (fixture === 'bjt') {
          doc.circuit.components[0].params.dc = 5;
          doc.circuit.nets.push('base');
          doc.circuit.components.push(
            { type: 'V', id: 'vb', name: 'VB', params: { dc: 0.65 }, ports: [{ name: 'p', net: 'base' }, { name: 'n', net: '0' }] },
            { type: 'Q', id: 'q', name: 'Q1', model: 'NMOD', params: {}, ports: [{ name: 'collector', net: 'out' }, { name: 'base', net: 'base' }, { name: 'emitter', net: '0' }] },
          );
          doc.models.push({ name: 'NMOD', type: 'NPN', params: { IS: 1e-15, BF: 100, CJE: 1e-12, CJC: 1e-12 } });
          source = 'V1 in 0 dc 5 ac 1\nR1 in out 1k\nC1 out 0 1u\nVB base 0 0.65\nQ1 out base 0 NMOD\n.model NMOD NPN(IS=1e-15 BF=100 CJE=1e-12 CJC=1e-12)';
        }
        if (fixture !== 'rc') {
          // Core supports nonlinear AC source-magnitude derivatives only at zero excitation.
          doc.circuit.components[0].params.magnitude = 0;
          source = source.replace('ac 1', 'ac 0');
        }
        Object.assign(doc.analyses[0], output, { variation });
        expect(ajv.validate(schemaId, request(doc))).toBe(true);
        const expected = (await simulate(parseTitleless(`${source}\n.sens ${expression} ac ${variation} 2 10 1000`))).sensitivity!;
        expect(expected.entries.some(entry => entry.ac?.some(value => value.real !== 0 || value.imaginary !== 0))).toBe(true);
        if (fixture !== 'rc') {
          expect(expected.entries.some(entry => entry.parameter === 'acMagnitude')).toBe(true);
          doc.circuit.components[0].params.magnitude = 1;
          const message = `device type ${fixture === 'diode' ? 'Diode' : 'BJT'} is outside the bounded slice`;
          await expect(simulate(parseTitleless(`${source.replace('ac 0', 'ac 1')}\n.sens ${expression} ac ${variation} 2 10 1000`))).rejects.toThrow(message);
          await expect(simulate(circuitFromDocument(doc))).rejects.toThrow(message);
          doc.circuit.components[0].params.magnitude = 0;
        }
        // Text omits explicit voltage metadata; no numerical values are normalized.
        expect((await simulate(circuitFromDocument(doc))).sensitivity).toEqual({ ...expected, outputType: 'outputType' in output ? output.outputType : undefined });
      });
    });
  });

  it.each(['dec', 'oct', 'lin'] as const)('accepts equal frequency endpoints and one %s point like core', async variation => {
    const doc = document();
    Object.assign(doc.analyses[0], { variation, points: 1, stopFreq: 10 });
    expect(ajv.validate(schemaId, request(doc))).toBe(true);
    const expected = (await simulate(parseTitleless(`V1 in 0 dc 1 ac 1\nR1 in out 1k\nC1 out 0 1u\n.sens V(out) ac ${variation} 1 10 10`))).sensitivity!;
    expect((await simulate(circuitFromDocument(doc))).sensitivity).toEqual(expected);
  });

  it.each([
    { outputNode: 'missing' }, { outputReferenceNode: 'missing' },
    { outputType: 'current', outputNode: 'missing' }, { outputType: 'current', outputNode: 'R1' },
    { outputType: 'current', outputNode: 'V1', outputReferenceNode: '0' },
  ])('rejects invalid output %j with a structured path', output => {
    const doc = document();
    Object.assign(doc.analyses[0], output);
    if ('outputType' in output && 'outputReferenceNode' in output) expect(ajv.validate(schemaId, request(doc))).toBe(false);
    const field = 'outputReferenceNode' in output ? 'outputReferenceNode' : 'outputNode';
    try {
      circuitFromDocument(doc);
      expect.fail('invalid output accepted');
    } catch (error) {
      expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/analyses/0/${field}` } });
    }
  });

  it('accepts an AC sweep in the schema and adapter', async () => {
    const doc = document();
    expect(ajv.validate(schemaId, request(doc))).toBe(true);
    const expected = (await simulate(parseTitleless('V1 in 0 dc 1 ac 1\nR1 in out 1k\nC1 out 0 1u\n.sens V(out) ac dec 2 10 1000'))).sensitivity!;
    expect(expected.entries.length).toBeGreaterThan(0);
    expect((await simulate(circuitFromDocument(doc))).sensitivity).toEqual(expected);
  });
});
