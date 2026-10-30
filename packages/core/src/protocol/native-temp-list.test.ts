import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { mapProtocolErrorV1, simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const document: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [{ name: 'DM', type: 'D', params: { IS: 1e-12 } }], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'D', id: 'D1', name: 'D1', ports: [{ name: 'anode', net: 'out' }, { name: 'cathode', net: '0' }], params: {}, model: 'DM' },
  ] }, analyses: [{ type: 'op' }],
};
const netlist = 'V1 in 0 1\nR1 in out 1k\nD1 out 0 DM\n.model DM D(IS=1e-12)';

describe('native TEMP LIST', () => {
  it('rejects a sweep without an OP analysis in both entrypoints', async () => {
    const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, analyses: [], temperatureSweep: { values: [0, 27, 75] } } } };
    for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      await expect(execute(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: '/input/document/analyses' } });
    }
  });
  it('rejects unknown document keys consistently with the shipped schema', async () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    for (const [field, path] of [['temperatureSweeps', 'temperatureSweeps'], ['extra~/key', 'extra~0~1key']]) {
      for (const sweep of [undefined, { values: [27] }]) {
        const request = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, ...(sweep && { temperatureSweep: sweep }), [field]: [{ values: [75] }] } } } as unknown as SimulationRequestV1;
        expect(validate(request)).toBe(false);
        for (const execute of [simulateProtocolV1, validateProtocolV1]) {
          await expect(execute(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/${path}` } });
        }
      }
    }
  });
  it('matches ordered text sweep results', async () => {
    const native = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document: { ...document, temperatureSweep: { values: [0, 27, 75] } } } } as SimulationRequestV1);
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${netlist}\n.step TEMP LIST 0 27 75\n.op` } });
    expect(native.analyses).toEqual(text.analyses);
    expect(native.analyses.map(a => a.step)).toEqual([0, 27, 75].map((value, index) => ({ index, parameter: 'TEMP', value })));
    expect(native.analyses).toHaveLength(3);
  });
  it('preserves an ordinary no-sweep request', async () => {
    const native = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document } });
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${netlist}\n.op` } });
    expect(native.analyses).toEqual(text.analyses);
    expect(native.analyses).toHaveLength(1);
    expect(native.analyses[0].step).toBeUndefined();
  });
  it('rejects invalid lists and unsupported combinations with paths', async () => {
    const cases: [unknown, string][] = [
      [{ values: [] }, '/input/document/temperatureSweep/values'],
      [{ values: Array(17).fill(27) }, '/input/document/temperatureSweep/values'],
      [{ values: [NaN] }, '/input/document/temperatureSweep/values/0'],
      [{ values: [Infinity] }, '/input/document/temperatureSweep/values/0'],
      [{ values: [-273.15] }, '/input/document/temperatureSweep/values/0'],
      [{ values: [-300] }, '/input/document/temperatureSweep/values/0'],
      [{ values: [27], start: 0 }, '/input/document/temperatureSweep/start'],
      [[], '/input/document/temperatureSweep'],
    ];
    for (const [sweep, path] of cases) {
      const request = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, temperatureSweep: sweep } } } as unknown as SimulationRequestV1;
      await expect(simulateProtocolV1(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path } });
    }
    for (const analysis of [{ type: 'dc', source: 'V1', start: 0, stop: 1, step: 1 }, { type: 'tran', timestep: 1, stopTime: 1 }]) {
      const request = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, analyses: [analysis], temperatureSweep: { values: [27] } } } } as SimulationRequestV1;
      await expect(simulateProtocolV1(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: '/input/document/analyses/0/type' } });
    }
    for (const field of ['noiseAnalyses', 'poleZeroAnalyses', 'steps', 'sweeps']) {
      const request = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, temperatureSweep: { values: [27] }, [field]: [{}] } } } as unknown as SimulationRequestV1;
      await expect(simulateProtocolV1(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/${field}` } });
    }
    const ambiguous: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, temperatureSweep: { values: [27] } } }, options: { temperature: 27 } };
    await expect(simulateProtocolV1(ambiguous).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: '/options/temperature' } });
  });
  it('validates the shipped schema and cross-field restrictions', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    const request = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, temperatureSweep: { values: [0, 27, 75] } } } };
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, options: { nominalTemperature: 27 } })).toBe(true);
    expect(validate({ ...request, input: { ...request.input, document: { ...request.input.document, temperatureSweep: { values: Array(16).fill(27) } } } })).toBe(true);
    for (const values of [[], Array(17).fill(27), [NaN], [Infinity], [-273.15]]) expect(validate({ ...request, input: { ...request.input, document: { ...request.input.document, temperatureSweep: { values } } } })).toBe(false);
    expect(validate({ ...request, options: { temperature: 27 } })).toBe(false);
    expect(validate({ ...request, input: { ...request.input, document: { ...request.input.document, analyses: [] } } })).toBe(false);
    expect(validate({ ...request, input: { ...request.input, document: { ...request.input.document, analyses: [{ type: 'dc', source: 'V1', start: 0, stop: 1, step: 1 }] } } })).toBe(false);
  });
  it('retains result limits and cancellation', async () => {
    const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, temperatureSweep: { values: [0, 27, 75] } } }, options: { limits: { maxResultPoints: 2 } } };
    await expect(simulateProtocolV1(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } });
    await expect(simulateProtocolV1({ ...request, options: {} }, { signal: { aborted: true } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'CANCELLED' });
  });
});
