import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { circuitFromDocument, mapProtocolErrorV1, simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import { simulate } from '../simulate.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const base: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 10 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
  ] }, analyses: [{ type: 'op' }],
};
const request = (document: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document } });

describe('native source LIST', () => {
  it('accepts a source sweep in the shipped schema', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    expect(ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!(request({ ...base, sourceSweep: { source: 'V1', values: [-2, 0, 3] } }))).toBe(true);
  });
  it('runs voltage sources as independent ordered OPs', async () => {
    const values = [-2, 0, 3];
    const result = await simulateProtocolV1(request({ ...base, sourceSweep: { source: 'v1', values } }));
    expect(result.analyses.map(a => a.step)).toEqual(values.map((value, index) => ({ index, parameter: 'V1', value })));
    for (const [index, analysis] of result.analyses.entries()) {
      if (analysis.type !== 'op') throw new Error('expected OP');
      expect(analysis.voltagesV.out).toBeCloseTo(values[index]! / 2, 9);
      expect(analysis.currentsA.V1).toBeCloseTo(-values[index]! / 2000, 9);
      const single = await simulateProtocolV1(request({ ...base, circuit: { ...base.circuit, components: base.circuit.components.map(c => c.name === 'V1' ? { ...c, params: { ...c.params, dc: values[index]! } } : c) } }));
      const coreDoc = { ...base, circuit: { ...base.circuit, components: base.circuit.components.map(c => c.name === 'V1' ? { ...c, params: { ...c.params, dc: values[index]! } } : c) } };
      const core = await simulate(circuitFromDocument(coreDoc));
      expect(analysis.voltagesV.out).toBe(core.dc!.voltage('out'));
      expect(analysis.currentsA.V1).toBe(core.dc!.current('V1'));
      const { step: _step, ...actual } = analysis;
      expect(actual).toEqual(single.analyses[0]);
    }
  });
  it('runs current sources independently and preserves the original document', async () => {
    const values = [-0.002, 0, 0.003, -0.002];
    const doc: SpiceTsCircuitDocumentV1 = { ...base, circuit: { nets: ['out'], components: [
      { type: 'I', id: 'I1', name: 'I1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { dc: 0.001 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
    ] } };
    const before = structuredClone(doc);
    const unstepped = await simulateProtocolV1(request(doc));
    const result = await simulateProtocolV1(request({ ...doc, sourceSweep: { source: 'i1', values } }));
    expect(result.analyses.map(a => a.step)).toEqual(values.map((value, index) => ({ index, parameter: 'I1', value })));
    for (const [index, analysis] of result.analyses.entries()) {
      if (analysis.type !== 'op') throw new Error('expected OP');
      expect(analysis.voltagesV.out).toBeCloseTo(-values[index]! * 1000, 9);
      expect(analysis.voltagesV.out! / 1000).toBeCloseTo(-values[index]!, 9);
      const single = await simulateProtocolV1(request({ ...doc, circuit: { ...doc.circuit, components: doc.circuit.components.map(c => c.name === 'I1' ? { ...c, params: { ...c.params, dc: values[index]! } } : c) } }));
      const coreDoc = { ...doc, circuit: { ...doc.circuit, components: doc.circuit.components.map(c => c.name === 'I1' ? { ...c, params: { ...c.params, dc: values[index]! } } : c) } };
      const core = await simulate(circuitFromDocument(coreDoc));
      expect(analysis.voltagesV.out).toBe(core.dc!.voltage('out'));
      const { step: _step, ...actual } = analysis;
      expect(actual).toEqual(single.analyses[0]);
    }
    expect(doc).toEqual(before);
    expect(await simulateProtocolV1(request(doc))).toEqual(unstepped);
  });
  it('rejects malformed, incompatible and unsupported sweeps in both entrypoints', async () => {
    const cases: [unknown, string][] = [
      [null, 'sourceSweep'], [{ values: [1] }, 'sourceSweep/source'], [{ source: 'unknown', values: [1] }, 'sourceSweep/source'],
      [{ source: 'R1', values: [1] }, 'sourceSweep/source'], [{ source: 'X1.V1', values: [1] }, 'sourceSweep/source'],
      [{ source: 'V1', values: [] }, 'sourceSweep/values'], [{ source: 'V1', values: Array(17).fill(1) }, 'sourceSweep/values'],
      ...[NaN, Infinity, -Infinity].map(value => [{ source: 'V1', values: [value] }, 'sourceSweep/values/0'] as [unknown, string]),
      [{ source: 'V1', values: [1], extra: 1 }, 'sourceSweep/extra'],
    ];
    for (const [sourceSweep, path] of cases) for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      const input = request({ ...base, sourceSweep } as SpiceTsCircuitDocumentV1);
      await expect(execute(input).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/${path}` } });
    }
    const sourceSweep = { source: 'V1', values: [1] };
    const overrides: [object, string][] = [
      [{ analyses: [] }, 'analyses'], [{ analyses: [{ type: 'op' }, { type: 'op' }] }, 'analyses'],
      [{ analyses: [{ type: 'tran', timestep: 1, stopTime: 2 }] }, 'analyses/0/type'],
      [{ componentSweep: { component: 'R1', values: [1] } }, 'sourceSweep'], [{ temperatureSweep: { values: [27] } }, 'sourceSweep'],
      [{ noiseAnalyses: [{}] }, 'noiseAnalyses'], [{ poleZeroAnalyses: [{}] }, 'poleZeroAnalyses'],
      [{ circuit: { ...base.circuit, components: base.circuit.components.map(c => c.name === 'V1' ? { ...c, params: { waveform: 'sin', dc: 1 } } : c) } }, 'sourceSweep/source'],
    ];
    for (const [override, path] of overrides) for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      const input = request({ ...base, sourceSweep, ...override } as SpiceTsCircuitDocumentV1);
      await expect(execute(input).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/${path}` } });
    }
  });
  it('enforces schema bounds and exclusive analysis selectors', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    for (const values of [[], Array(17).fill(1), [NaN], [Infinity]]) expect(validate(request({ ...base, sourceSweep: { source: 'V1', values } }))).toBe(false);
    expect(validate(request({ ...base, sourceSweep: { source: 'V1', values: Array(16).fill(-1) } }))).toBe(true);
    for (const override of [{ componentSweep: { component: 'R1', values: [1] } }, { temperatureSweep: { values: [27] } }, { analyses: [] }, { analyses: [{ type: 'op' }, { type: 'op' }] }, { analyses: [{ type: 'dc' }] }]) {
      expect(validate(request({ ...base, sourceSweep: { source: 'V1', values: [1] }, ...override } as SpiceTsCircuitDocumentV1))).toBe(false);
    }
  });
  it('applies resource limits to the entire sweep', async () => {
    const doc = { ...base, sourceSweep: { source: 'V1', values: [-2, 0, 3] } };
    for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      await expect(execute({ ...request(doc), options: { limits: { maxResultPoints: 2 } } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } });
    }
    const one = await simulateProtocolV1(request({ ...base, sourceSweep: { source: 'V1', values: [1] } }));
    const bytes = new TextEncoder().encode(JSON.stringify(one)).length * 2;
    await expect(simulateProtocolV1({ ...request(doc), options: { limits: { maxSerializedResultBytes: bytes } } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } });
  });

});
