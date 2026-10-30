import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { mapProtocolErrorV1, simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const document: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts' as const, schemaVersion: '1.0' as const, models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 10 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
  ] }, analyses: [{ type: 'op' as const }], componentSweep: { component: 'R1', values: [1000, 2000, 3000] },
};

describe('native component LIST', () => {
  it('accepts the shipped schema and matches text stepping', async () => {
    const request = { apiVersion: '1', input: { format: 'spice-ts', document } } as SimulationRequestV1;
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    expect(ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!(request)).toBe(true);
    const native = await simulateProtocolV1(request);
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.step R1 LIST 1000 2000 3000\n.op' } });
    expect(native.analyses).toEqual(text.analyses);
    expect(native.analyses).toHaveLength(3);
    expect(native.analyses.map(a => a.step)).toEqual([1000, 2000, 3000].map((value, index) => ({ index, parameter: 'R1', value })));
    for (const [index, analysis] of native.analyses.entries()) {
      if (analysis.type !== 'op') throw new Error('expected OP');
      expect(analysis.voltagesV.out).toBeCloseTo([5, 10 / 3, 2.5][index]!, 9);
      expect(analysis.currentsA.R1).toBeCloseTo([0.005, 10 / 3000, 0.0025][index]!, 9);
      expect(analysis.currentsA.V1).toBeCloseTo([-0.005, -10 / 3000, -0.0025][index]!, 9);
    }
  });
  it('preserves repeated and reordered values without leaking state', async () => {
    for (const values of [[3000, 1000, 3000], [2000, 1000, 3000]]) {
      const native = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document: { ...document, componentSweep: { component: 'r1', values } } } });
      const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.step R1 LIST ${values.join(' ')}\n.op` } });
      expect(native.analyses).toEqual(text.analyses);
      expect(native.analyses.map(a => a.step)).toEqual(values.map((value, index) => ({ index, parameter: 'R1', value })));
    }
  });
  it.each(['C', 'L'])('matches text stepping for %s including topology failures', async type => {
    const field = type === 'C' ? 'capacitance' : 'inductance';
    const values = [1e-6, 2e-6, 1e-6];
    const component = { type, id: `${type}1`, name: `${type}1`, ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { [field]: 1e-6 } };
    const doc = { ...document, circuit: { ...document.circuit, components: [...document.circuit.components, component] }, componentSweep: { component: component.name, values } };
    const native = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document: doc } }).catch(mapProtocolErrorV1);
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n${type}1 out 0 1u\n.step ${type}1 LIST ${values.join(' ')}\n.op` } }).catch(mapProtocolErrorV1);
    expect('analyses' in native).toBe(true);
    expect('analyses' in text).toBe(true);
    if (!('analyses' in native) || !('analyses' in text)) throw new Error(`unexpected topology result: ${JSON.stringify({ native, text })}`);
    expect(native.analyses).toEqual(text.analyses);
    expect(native.analyses.map(a => a.step)).toEqual(values.map((value, index) => ({ index, parameter: component.name, value })));
  });
  it('reports the same structured topology error for a floating capacitor', async () => {
    const doc: SpiceTsCircuitDocumentV1 = { ...document, circuit: { nets: ['floating'], components: [{ type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'floating' }, { name: 'n', net: '0' }], params: { capacitance: 1e-6 } }] }, componentSweep: { component: 'C1', values: [1e-6, 2e-6] } };
    const native = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document: doc } }).catch(mapProtocolErrorV1);
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: 'C1 floating 0 1u\n.step C1 LIST 1e-6 2e-6\n.op' } }).catch(mapProtocolErrorV1);
    expect(native).toMatchObject({ code: 'INVALID_CIRCUIT' });
    expect(text).toMatchObject({ code: 'INVALID_CIRCUIT' });
    if ('analyses' in native || 'analyses' in text) throw new Error('expected topology errors');
    expect(native.code).toEqual(text.code);
    expect(native.details).toMatchObject({ kind: 'NO_DC_REFERENCE', sourcePaths: ['/input/document/circuit/components/0'] });
    expect(text.details).toMatchObject({ kind: 'NO_DC_REFERENCE', sourcePaths: ['/input/source/lines/0'] });
  });
  it('rejects invalid requests with field paths in both entrypoints', async () => {
    const cases: [unknown, string][] = [
      [null, 'componentSweep'], [{ component: 'missing', values: [1] }, 'componentSweep/component'],
      [{ component: 'V1', values: [1] }, 'componentSweep/component'], [{ component: 'R1', values: [] }, 'componentSweep/values'],
      [{ component: 'R1', values: Array(17).fill(1) }, 'componentSweep/values'],
      ...[0, -1, NaN, Infinity].map(value => [{ component: 'R1', values: [value] }, 'componentSweep/values/0'] as [unknown, string]),
      [{ component: 'R1', values: [1], bad: 2 }, 'componentSweep/bad'],
    ];
    for (const [sweep, path] of cases) for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      const request = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, componentSweep: sweep } } } as unknown as SimulationRequestV1;
      await expect(execute(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/${path}` } });
    }
    for (const [override, path] of [
      [{ analyses: [] }, 'analyses'], [{ analyses: [{ type: 'op' }, { type: 'op' }] }, 'analyses'],
      [{ analyses: [{ type: 'tran', timestep: 1, stopTime: 1 }] }, 'analyses/0/type'],
      [{ temperatureSweep: { values: [27] } }, 'componentSweep'], [{ noiseAnalyses: [{}] }, 'noiseAnalyses'],
      [{ poleZeroAnalyses: [{}] }, 'poleZeroAnalyses'],
    ] as [object, string][]) for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      const request = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, ...override } } } as unknown as SimulationRequestV1;
      await expect(execute(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/${path}` } });
    }
  });
  it('enforces shipped schema sweep bounds and combinations', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    const request = (doc: unknown) => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });
    for (const values of [[], Array(17).fill(1), [0], [-1], [NaN], [Infinity]]) expect(validate(request({ ...document, componentSweep: { component: 'R1', values } }))).toBe(false);
    expect(validate(request({ ...document, componentSweep: { component: 'R1', values: Array(16).fill(1) } }))).toBe(true);
    for (const override of [{ temperatureSweep: { values: [27] } }, { analyses: [] }, { analyses: [{ type: 'op' }, { type: 'op' }] }, { analyses: [{ type: 'dc' }] }]) expect(validate(request({ ...document, ...override }))).toBe(false);
  });
  it('respects result limits and leaves unstepped requests unchanged', async () => {
    const request = { apiVersion: '1', input: { format: 'spice-ts', document }, options: { limits: { maxResultPoints: 2 } } } as SimulationRequestV1;
    await expect(simulateProtocolV1(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } });
    await expect(simulateProtocolV1({ ...request, options: {} }, { signal: { aborted: true } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'CANCELLED' });
    const { componentSweep: _sweep, ...unstepped } = document;
    const result = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document: unstepped } });
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op' } });
    expect(result.analyses).toEqual(text.analyses);
    expect(result.analyses).toHaveLength(1);
    expect(result.analyses[0]!.step).toBeUndefined();
  });
});
