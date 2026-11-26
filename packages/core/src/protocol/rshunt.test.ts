import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const document: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
  ] }, analyses: [{ type: 'op' }],
};
const deck = 'V1 in 0 1\nR1 in out 1k\nR2 out 0 1k';

describe('native rshunt', () => {
  it('matches SPICE text for OP while preserving the default', async () => {
    const request = { apiVersion: '1', input: { format: 'spice-ts', document }, options: { rshunt: 1000 } } as unknown as SimulationRequestV1;
    const actual = (await simulateProtocolV1(request)).analyses[0];
    const baseline = (await simulateProtocolV1({ ...request, options: {} })).analyses[0];
    const text = (await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${deck}\n.options rshunt=1k\n.op` } })).analyses[0];
    if (actual.type !== 'op' || baseline.type !== 'op' || text.type !== 'op') throw new Error('expected OP');
    expect(actual.voltagesV.out).toBeCloseTo(1 / 3, 9);
    expect(actual.currentsA.V1).toBeCloseTo(-1 / 600, 9);
    expect(baseline.voltagesV.out).toBeCloseTo(0.5, 9);
    expect(baseline.currentsA.V1).toBeCloseTo(-0.0005, 9);
    expect(actual).toEqual(text);
  });
  it('overrides a text rshunt without changing omitted-option behavior', async () => {
    const input = { format: 'spice' as const, source: `${deck}\n.options rshunt=2k\n.op` };
    const overridden = (await simulateProtocolV1({ apiVersion: '1', input, options: { rshunt: 1000 } })).analyses[0];
    const original = (await simulateProtocolV1({ apiVersion: '1', input })).analyses[0];
    if (overridden.type !== 'op' || original.type !== 'op') throw new Error('expected OP');
    expect(overridden.voltagesV.out).toBeCloseTo(1 / 3, 9);
    expect(original.voltagesV.out).toBeCloseTo(0.4, 9);
  });
  it.each(['', '.options rshunt=2k\n'])('preserves protocol rshunt through TEMPER recompilation with text options %j', async prefix => {
    const temperDeck = 'V1 in 0 1\nR1 in out {1000+temper}\nR2 out 0 1k\n.step TEMP LIST 27 50\n.op';
    const actual = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${prefix}${temperDeck}` }, options: { rshunt: 1000 } });
    const reference = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `.options rshunt=1k\n${temperDeck}` } });
    expect(actual.analyses).toEqual(reference.analyses);
    expect(actual.analyses).toHaveLength(2);
    for (const [index, analysis] of actual.analyses.entries()) {
      if (analysis.type !== 'op') throw new Error('expected OP');
      expect(analysis.voltagesV.out).toBeCloseTo([0.3274394237066142, 0.3225806451612903][index]!, 9);
    }
  });
  it('matches SPICE text for a linear DC sweep', async () => {
    const sweep = { type: 'dc' as const, source: 'V1', start: 0, stop: 2, step: 1 };
    const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, analyses: [sweep] } }, options: { rshunt: 1000 } };
    const actual = (await simulateProtocolV1(request)).analyses[0];
    const text = (await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${deck}\n.options rshunt=1k\n.dc V1 0 2 1` } })).analyses[0];
    if (actual.type !== 'dc' || text.type !== 'dc') throw new Error('expected DC');
    expect(actual.voltagesV.out).toHaveLength(3);
    actual.voltagesV.out.forEach((v, i) => expect(Math.abs(v - i / 3)).toBeLessThan(1e-9));
    expect(actual).toEqual(text);
  });
  it.each([0, -1, 1e-30, 1e-31, NaN, Infinity, -Infinity, '1000', null])('rejects invalid rshunt %s', async value => {
    const request = { apiVersion: '1', input: { format: 'spice-ts', document }, options: { rshunt: value } } as unknown as SimulationRequestV1;
    expect(await executeProtocolV1(request)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: '/options/rshunt' } } });
    await expect(validateProtocolV1(request)).rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', details: { path: '/options/rshunt' } } });
  });
  it.each(['spice-ts-wasm', 'ngspice-wasm'] as const)('rejects rshunt on %s', async backend => {
    const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document }, options: { rshunt: 1000, backend } };
    expect(await executeProtocolV1(request)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: '/options/rshunt' } } });
  });
  it('validates the shipped request schema', () => {
    const ajv = new Ajv2020({ strict: true });
    for (const name of ['common', 'simulation-request']) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/simulation-request.schema.json')!;
    const request = { apiVersion: '1', input: { format: 'spice-ts', document } };
    for (const rshunt of [1000, 1e-29]) expect(validate({ ...request, options: { rshunt } })).toBe(true);
    for (const rshunt of [0, -1, 1e-30, 1e-31, NaN, Infinity, '1000', null]) expect(validate({ ...request, options: { rshunt } })).toBe(false);
    expect(validate({ ...request, options: { unknown: 1 } })).toBe(false);
  });
});
