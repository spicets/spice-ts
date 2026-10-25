import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { circuitFromDocument, mapProtocolErrorV1, validateProtocolV1 } from './adapter.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import type { SpiceTsCircuitDocumentV1 } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
const schemaId = 'https://spice-ts.dev/schemas/v1/simulation-request.schema.json';

function document(variation: 'lin' | 'dec' | 'oct' = 'lin'): SpiceTsCircuitDocumentV1 {
  const component = (type: string, name: string, p: string, n: string, params: Record<string, number | string>) => ({
    type, id: name, name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params,
  });
  return {
    format: 'spice-ts', schemaVersion: '1.0',
    circuit: { nets: ['in', 'out'], components: [
      component('V', 'V1', 'in', '0', { waveform: 'ac', dc: 0, magnitude: 1, portnum: 1, z0: 100 }),
      component('R', 'R1', 'in', 'out', { resistance: 100 }),
      component('C', 'C1', 'out', '0', { capacitance: 1e-9 }),
      component('V', 'V2', 'out', '0', { waveform: 'ac', dc: 0, magnitude: 0, portnum: 2, z0: 50 }),
    ] },
    analyses: [{ type: 'sp', variation, points: 3, startFreq: 1e6, stopFreq: 1e8 }],
    models: [], subcircuits: [],
  };
}

const request = (doc: SpiceTsCircuitDocumentV1) => ({ apiVersion: '1' as const, input: { format: 'spice-ts' as const, document: doc } });

describe('native protocol S-parameter requests', () => {
  it.each(['lin', 'dec', 'oct'] as const)('validates and preserves %s sweeps and unequal RF impedances', async variation => {
    const doc = document(variation);
    expect(ajv.validate(schemaId, request(doc))).toBe(true);
    await expect(validateProtocolV1(request(doc))).resolves.toMatchObject({ status: 'valid', analysisCount: 1 });
    const native = (await simulate(circuitFromDocument(doc))).sParameters!;
    const text = (await simulate(`native RF parity
V1 in 0 dc 0 ac 1 portnum 1 z0 100
R1 in out 100
C1 out 0 1e-9
V2 out 0 dc 0 ac 0 portnum 2 z0 50
.sp ${variation} 3 1e6 1e8
.end`)).sParameters!;
    expect(native.frequencies).toEqual(text.frequencies);
    expect(native.referenceImpedances).toEqual(text.referenceImpedances);
    expect([...native.vectors.keys()]).toEqual([...text.vectors.keys()]);
    for (const [name, expected] of text.vectors) {
      expected.forEach((value, index) => {
        const actual = native.vectors.get(name)![index];
        const scale = Math.hypot(value.real, value.imaginary);
        expect(Math.hypot(actual.real - value.real, actual.imaginary - value.imaginary)).toBeLessThanOrEqual(1e-12 * scale);
      });
    }
  });

  it.each([
    ['zero points', '/input/document/analyses/0/points', (doc: SpiceTsCircuitDocumentV1) => { Object.assign(doc.analyses[0], { points: 0 }); }],
    ['non-numeric z0', '/input/document/circuit/components/0/params/z0', (doc: SpiceTsCircuitDocumentV1) => { doc.circuit.components[0].params.z0 = '50'; }],
  ] as const)('rejects %s with a structured JSON path', async (_name, path, mutate) => {
    const doc = document();
    mutate(doc);
    expect(ajv.validate(schemaId, request(doc))).toBe(false);
    try {
      await validateProtocolV1(request(doc));
      expect.fail('invalid native RF request accepted');
    } catch (error) {
      expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', details: { path } });
    }
  });
});
