import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { mapProtocolErrorV1, simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

function document(diode: boolean): SpiceTsCircuitDocumentV1 {
  return {
    format: 'spice-ts', schemaVersion: '1.0',
    models: diode ? [{ name: 'DM', type: 'D', params: { IS: 1e-12 } }] : [], subcircuits: [],
    circuit: { nets: ['in', 'out'], components: [
      { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'ac', dc: 1, magnitude: 1, phase: 30 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
      { type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { capacitance: 1e-6 } },
      ...(diode ? [{ type: 'D', id: 'D1', name: 'D1', ports: [{ name: 'anode', net: 'out' }, { name: 'cathode', net: '0' }], params: {}, model: 'DM' }] : []),
    ] }, analyses: [{ type: 'ac', variation: 'dec', points: 4, startFreq: 10, stopFreq: 10000 }],
  };
}
const request = (doc: SpiceTsCircuitDocumentV1, temperature?: number): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc }, ...(temperature === undefined ? {} : { options: { temperature } }) });

describe('native AC temperature list', () => {
  it.each([true, false])('matches fresh standalone results, diode=%s', async diode => {
    const doc = document(diode);
    const values = [0, 27, 75, 27];
    const standalone = await Promise.all(values.map(t => simulateProtocolV1(request(doc, t))));
    const stepped = await simulateProtocolV1(request({ ...doc, temperatureSweep: { values } }));
    expect(stepped.analyses).toHaveLength(values.length);
    for (const [i, result] of stepped.analyses.entries()) {
      const expected = standalone[i]!.analyses[0]!;
      expect(result.type).toBe('ac');
      if (result.type !== 'ac' || expected.type !== 'ac') throw new Error('expected AC');
      expect(result.step).toEqual({ index: i, parameter: 'TEMP', value: values[i] });
      expect({ ...result, step: undefined }).toEqual(expected);
      for (const data of [...Object.values(result.voltagePhasors), ...Object.values(result.currentPhasors)]) for (const phasor of data) {
        expect(Number.isFinite(phasor.magnitude)).toBe(true);
        expect(Number.isFinite(phasor.phaseDegrees)).toBe(true);
      }
      console.info(`diode=${diode} temp=${values[i]} out=${JSON.stringify(result.voltagePhasors.out![0])}`);
    }
    if (diode) {
      const first = stepped.analyses[0]!; const last = stepped.analyses[2]!;
      if (first.type !== 'ac' || last.type !== 'ac') throw new Error('expected AC');
      expect(first.voltagePhasors.out![0]!.magnitude).not.toBeCloseTo(last.voltagePhasors.out![0]!.magnitude, 4);
    }
  });

  it('rejects invalid lists and unsupported combinations with structured paths', async () => {
    const doc = document(true);
    const ac = doc.analyses[0]!;
    const cases: [object, string, object?][] = [
      [{ temperatureSweep: { values: [] } }, '/input/document/temperatureSweep/values'],
      [{ temperatureSweep: { values: Array(17).fill(27) } }, '/input/document/temperatureSweep/values'],
      ...[NaN, Infinity, -Infinity, -273.15].map(value => [{ temperatureSweep: { values: [value] } }, '/input/document/temperatureSweep/values/0'] as [object, string]),
      [{}, '/options/temperature', { temperature: 27 }],
      [{ analyses: [ac, ac] }, '/input/document/analyses/0/type'],
      [{ analyses: [ac, { type: 'op' }] }, '/input/document/analyses/0/type'],
      [{ analyses: [{ type: 'op' }, ac] }, '/input/document/analyses/1/type'],
      [{ analyses: [{ type: 'tran', timestep: 1, stopTime: 1 }] }, '/input/document/analyses/0/type'],
      [{ noiseAnalyses: [{}] }, '/input/document/noiseAnalyses'],
      [{ poleZeroAnalyses: [{}] }, '/input/document/poleZeroAnalyses'],
      [{ sourceSweep: { source: 'V1', values: [1] } }, '/input/document/sourceSweep'],
      [{ componentSweep: { component: 'R1', values: [1000] } }, '/input/document/componentSweep'],
    ];
    for (const [overrides, path, options] of cases) {
      const input = { ...doc, temperatureSweep: { values: [27] }, ...overrides } as SpiceTsCircuitDocumentV1;
      const req = { ...request(input), ...(options ? { options } : {}) } as SimulationRequestV1;
      await expect(simulateProtocolV1(req).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', phase: 'validation', details: { path } });
    }
  });

  it('validates the published request schema for AC and exclusions', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    const doc = document(true); const ac = doc.analyses[0]!;
    const withSweep = { ...doc, temperatureSweep: { values: [0, 27, 75] } };
    expect(validate(request(withSweep))).toBe(true);
    for (const override of [{ analyses: [ac, ac] }, { analyses: [{ type: 'op' }, ac] }, { temperatureSweep: { values: [] } }, { temperatureSweep: { values: Array(17).fill(27) } }, { noiseAnalyses: [{}] }]) {
      expect(validate(request({ ...withSweep, ...override } as SpiceTsCircuitDocumentV1))).toBe(false);
    }
    expect(validate(request(withSweep, 27))).toBe(false);
  });

  it('counts all AC temperatures against the result point limit', async () => {
    const doc = { ...document(true), temperatureSweep: { values: [0, 27, 75] } };
    const req: SimulationRequestV1 = { ...request(doc), options: { limits: { maxResultPoints: 20 } } };
    await expect(simulateProtocolV1(req).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } });
  });
});
