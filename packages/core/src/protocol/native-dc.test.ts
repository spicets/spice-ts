import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const name of Object.keys(protocolSchemasV1)) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
}
const base = 'https://spice-ts.dev/schemas/v1/';
const deck = 'V1 a 0 0\nV2 b 0 0\nR1 a b 1000\n.dc V1 0 1 0.5 V2 0 2 1';
function request(): SimulationRequestV1 {
  const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
  const document = {
    format: 'spice-ts', schemaVersion: '1.0', circuit: { nets: ['a', 'b'], components: [
      component('V', 'V1', ['a', '0'], { dc: 0 }),
      component('V', 'V2', ['b', '0'], { dc: 0 }),
      component('R', 'R1', ['a', 'b'], { resistance: 1000 }),
    ] }, models: [], subcircuits: [],
    analyses: [{ type: 'dc', source: 'V1', start: 0, stop: 1, step: 0.5, secondary: { source: 'V2', start: 0, stop: 2, step: 1 } }],
  } as SpiceTsCircuitDocumentV1;
  return { apiVersion: '1', input: { format: 'spice-ts', document } };
}

describe('native nested DC sweeps', () => {
  it.each([
    [{ source: 'V2', start: 0, stop: 2, step: 0 }, 'step'],
    [{ source: 'missing', start: 0, stop: 2, step: 1 }, 'source'],
    [{ source: 'V2', start: 0, stop: 2, step: -1 }, 'step'],
    [{ source: 'v1', start: 0, stop: 2, step: 1 }, 'source'],
    [{ source: 'V2', start: 0, stop: 2 }, 'step'],
    [{ source: 'V2', start: 0, stop: Infinity, step: 1 }, 'stop'],
    [{ source: 'V2', start: 0, stop: 2, step: 1, extra: true }, 'extra'],
    [null, ''],
  ])('rejects invalid secondary %j before solving', async (secondary, field) => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('Expected native');
    Object.assign(input.input.document.analyses[0], { secondary });
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: {
      code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/analyses/0/secondary${field ? `/${field}` : ''}` },
    } });
    await expect(validateProtocolV1(input)).rejects.toMatchObject({ apiError: { phase: 'validation' } });
  });
  it('preflights the product of both dimensions', async () => {
    const input = request();
    input.options = { limits: { maxResultPoints: 8 } };
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: {
      code: 'RESOURCE_LIMIT', phase: 'validation', details: { limit: 'maxResultPoints', observed: 9, configured: 8 },
    } });
  });
  it('retains single-source result shape when secondary is omitted', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('Expected native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'dc') throw new Error('Expected DC');
    delete analysis.secondary;
    const result = await simulateProtocolV1(input);
    expect(result.analyses[0]).not.toHaveProperty('secondaryAxis');
    expect(result.analyses[0]).toMatchObject({ axis: { values: [0, 0.5, 1] } });
  });
  it('preserves descending, non-divisible current-source outer coordinates', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('Expected native');
    const document = input.input.document;
    document.circuit.components[1] = { ...document.circuit.components[1], type: 'I', name: 'I2', id: 'I2' };
    document.circuit.components.push({ type: 'R', name: 'R2', id: 'R2', ports: [{ name: '0', net: 'b' }, { name: '1', net: '0' }], params: { resistance: 1000 } });
    const analysis = document.analyses[0];
    if (analysis.type !== 'dc') throw new Error('Expected DC');
    analysis.secondary = { source: 'i2', start: 1, stop: 0, step: -0.75 };
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: 'V1 a 0 0\nI2 b 0 0\nR1 a b 1000\nR2 b 0 1000\n.dc V1 0 1 0.5 I2 1 0 -0.75' } });
    const result = await simulateProtocolV1(input);
    expect(result).toEqual(text);
    expect(result.analyses[0]).toMatchObject({ secondaryAxis: { name: 'I2', unit: 'A', values: [1, 1, 1, 0.25, 0.25, 0.25] } });
  });
  it('matches all nine text points exactly and exposes both coordinates', async () => {
    const input = request();
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: deck } });
    const native = await simulateProtocolV1(input);
    expect(native).toEqual(text);
    expect(native.analyses[0]).toMatchObject({
      type: 'dc', axis: { name: 'V1', unit: 'V', values: [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1] },
      secondaryAxis: { name: 'V2', unit: 'V', values: [0, 0, 0, 1, 1, 1, 2, 2, 2] },
      voltagesV: { a: [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1], b: [0, 0, 0, 1, 1, 1, 2, 2, 2] },
    });
    const dc = native.analyses[0];
    if (dc.type !== 'dc') throw new Error('Expected DC');
    expect(dc.currentsA.V1).toHaveLength(9);
    expect(dc.currentsA.V1[1]).not.toBe(0);
    expect(ajv.validate(`${base}simulation-request.schema.json`, input), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(`${base}simulation-result.schema.json`, native), JSON.stringify(ajv.errors)).toBe(true);
  });
});
