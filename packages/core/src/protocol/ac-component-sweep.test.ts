import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { mapProtocolErrorV1, simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const component = (type: string, name: string, p: string, n: string, params: Record<string, number | string>) => ({ type, id: name, name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params });
const document: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', 'in', '0', { waveform: 'ac', dc: 0, magnitude: 1 }),
    component('R', 'R1', 'in', 'out', { resistance: 1000 }),
    component('C', 'C1', 'out', '0', { capacitance: 1e-6 }),
    component('L', 'L1', 'out', '0', { inductance: 0.1 }),
  ] }, analyses: [{ type: 'ac', variation: 'dec', points: 5, startFreq: 10, stopFreq: 10000 }],
};
const request = (doc: SpiceTsCircuitDocumentV1): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });

describe('native AC component LIST', () => {
  it('accepts AC sweeps in the shipped JSON schema', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    expect(ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!(request({ ...document, componentSweep: { component: 'R1', values: [1000] } }))).toBe(true);
  });
  it.each([['R1', 'resistance', [2000, 1000, 2000]], ['C1', 'capacitance', [2e-6, 1e-6, 2e-6]], ['L1', 'inductance', [0.2, 0.1, 0.2]]] as const)('matches independent RLC AC runs for %s', async (name, parameter, values) => {
    const stepped = await simulateProtocolV1(request({ ...document, componentSweep: { component: name.toLowerCase(), values: [...values] } }));
    expect(stepped.analyses.map(a => a.step)).toEqual(values.map((value, index) => ({ index, parameter: name, value })));
    for (const [index, value] of values.entries()) {
      const single = await simulateProtocolV1(request({ ...document, circuit: { ...document.circuit, components: document.circuit.components.map(c => c.name === name ? { ...c, params: { ...c.params, [parameter]: value } } : c) } }));
      const { step: _step, ...actual } = stepped.analyses[index]!;
      expect(actual).toEqual(single.analyses[0]);
    }
  });
  it('matches the analytic RC response', async () => {
    const doc = { ...document, circuit: { ...document.circuit, components: document.circuit.components.filter(c => c.name !== 'L1') }, componentSweep: { component: 'R1', values: [1000, 2000] } };
    const result = await simulateProtocolV1(request(doc));
    for (const [index, analysis] of result.analyses.entries()) {
      if (analysis.type !== 'ac') throw new Error('expected AC');
      for (const [i, frequency] of analysis.frequencyHz.entries()) {
        const omegaRC = 2 * Math.PI * frequency * doc.componentSweep.values[index]! * 1e-6;
        const actual = analysis.voltagePhasors.out![i]!;
        expect(Math.abs(actual.magnitude - 1 / Math.sqrt(1 + omegaRC ** 2))).toBeLessThan(1e-10);
        expect(Math.abs(actual.phaseDegrees - (-Math.atan(omegaRC) * 180 / Math.PI))).toBeLessThan(1e-8);
      }
    }
  });
  it('validates selected outputs and rejects synthetic branch currents', async () => {
    const input = { ...request({ ...document, componentSweep: { component: 'R1', values: [1000, 2000] } }), outputs: ['v(out)', 'i(V1)'] };
    const result = await simulateProtocolV1(input);
    for (const a of result.analyses) { if (a.type !== 'ac') throw new Error('expected AC'); expect(Object.keys(a.voltagePhasors)).toEqual(['out']); expect(Object.keys(a.currentPhasors)).toEqual(['V1']); }
    for (const execute of [simulateProtocolV1, validateProtocolV1]) await expect(execute({ ...input, outputs: ['i(R1)'] }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: '/outputs/0' } });
  });
  it('rejects currents unavailable after stepping an originally zero-ohm resistor', async () => {
    const doc = { ...document, circuit: { ...document.circuit, components: document.circuit.components.map(c => c.name === 'R1' ? { ...c, params: { ...c.params, resistance: 0 } } : c) }, componentSweep: { component: 'R1', values: [1000, 2000] } };
    const input = { ...request(doc), outputs: ['i(R1)'] };
    for (const execute of [simulateProtocolV1, validateProtocolV1]) await expect(execute(input).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: '/outputs/0' } });
  });
  it('rejects invalid AC sweep requests in simulate and validate', async () => {
    const sweep = { component: 'R1', values: [1000] };
    const cases: [object, string][] = [
      ...[0, -1, NaN, Infinity].map(value => [{ componentSweep: { ...sweep, values: [value] } }, 'componentSweep/values/0'] as [object, string]),
      [{ componentSweep: { ...sweep, values: Array(17).fill(1) } }, 'componentSweep/values'],
      [{ componentSweep: { ...sweep, component: 'X1.R1' } }, 'componentSweep/component'],
      [{ componentSweep: { ...sweep, component: 'TEMP' } }, 'componentSweep/component'],
      [{ componentSweep: { ...sweep, extra: 1 } }, 'componentSweep/extra'],
      [{ componentSweep: sweep, temperatureSweep: { values: [27] } }, 'componentSweep'],
      [{ componentSweep: sweep, analyses: [...document.analyses, { type: 'op' }] }, 'analyses'],
    ];
    for (const [override, path] of cases) for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      const input = request({ ...document, componentSweep: sweep, ...override } as SpiceTsCircuitDocumentV1);
      await expect(execute(input).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/${path}` } });
    }
  });
  it('bounds aggregate points, serialized bytes, and work', async () => {
    const input = request({ ...document, componentSweep: { component: 'R1', values: [1000, 2000, 3000] } });
    const single = await simulateProtocolV1(request(document));
    const a = single.analyses[0]!; if (a.type !== 'ac') throw new Error('expected AC');
    for (const execute of [simulateProtocolV1, validateProtocolV1]) {
      await expect(execute({ ...input, options: { limits: { maxResultPoints: a.frequencyHz.length * 2 } } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } });
    }
    await expect(simulateProtocolV1({ ...input, options: { limits: { maxSerializedResultBytes: new TextEncoder().encode(JSON.stringify(single)).length * 2 } } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } });
    let expired = false;
    await expect(simulateProtocolV1({ ...input, options: { limits: { maxWallTimeMs: 5 } } }, { now: () => expired ? 6 : 0, onSafePoint: point => { if (point === 'solve:ac-point') expired = true; } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxWallTimeMs', safePoint: 'solve:ac-point' } });
  });
  it('cancels between independent AC steps', async () => {
    const controller = new AbortController();
    let completed = 0;
    const input = request({ ...document, componentSweep: { component: 'R1', values: [1000, 2000] } });
    await expect(simulateProtocolV1(input, { signal: controller.signal, onAnalysisComplete: () => { completed++; controller.abort(); } }).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'CANCELLED' });
    expect(completed).toBe(1);
  });
});
