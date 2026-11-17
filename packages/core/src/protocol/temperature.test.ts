import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { mapProtocolErrorV1, simulateProtocolV1 } from './adapter.js';
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

describe('protocol circuit temperatures', () => {
  it('validates temperature bounds in the shipped schema', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) {
      ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    }
    const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    const request = { apiVersion: '1', input: { format: 'spice-ts', document }, options: { temperature: 85, nominalTemperature: 27 } };
    expect(validate(request)).toBe(true);
    for (const value of ['85', -273.15, -300, NaN, Infinity]) {
      expect(validate({ ...request, options: { temperature: value } })).toBe(false);
    }
  });
  it.each(['op', 'dc'] as const)('matches text %s and differs from default temperature', async mode => {
    const analysis = mode === 'op' ? { type: 'op' as const } : { type: 'dc' as const, source: 'V1', start: 0.5, stop: 1, step: 0.25 };
    const request = { apiVersion: '1' as const, input: { format: 'spice-ts' as const, document: { ...document, analyses: [analysis] } }, options: { temperature: 85, nominalTemperature: 27 } };
    const actual = await simulateProtocolV1(request);
    const expected = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${netlist}\n.temp 85\n.options TNOM=27\n.${mode === 'op' ? 'op' : 'dc V1 0.5 1 0.25'}` } });
    const baseline = await simulateProtocolV1({ ...request, options: {} });
    expect(actual).toEqual(expected);
    expect(actual).not.toEqual(baseline);
  });
  it.each(['temperature', 'nominalTemperature'] as const)('rejects invalid %s with a path', async field => {
    for (const value of ['85', NaN, Infinity, -273.15, -300]) {
      const request = { apiVersion: '1', input: { format: 'spice-ts', document }, options: { [field]: value } } as unknown as SimulationRequestV1;
      try { await simulateProtocolV1(request); expect.fail('expected rejection'); }
      catch (error) { expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/options/${field}` } }); }
    }
  });
});
