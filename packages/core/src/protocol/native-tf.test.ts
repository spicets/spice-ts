import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parseTitleless } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import { executeProtocolV1 } from './envelopes.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
const base = 'https://spice-ts.dev/schemas/v1/';
const deck = 'V1 in 0 1\nR1 in mid 1000\nR2 mid 0 2000\nE1 out 0 mid 0 3\nR3 out 0 500';
function request(output = 'v(out)'): SimulationRequestV1 {
  const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
  const document = {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in', 'mid', 'out'], components: [
      component('V', 'V1', ['in', '0'], { dc: 1 }),
      component('R', 'R1', ['in', 'mid'], { resistance: 1000 }),
      component('R', 'R2', ['mid', '0'], { resistance: 2000 }),
      component('E', 'E1', ['mid', '0', 'out', '0'], { gain: 3 }),
      component('R', 'R3', ['out', '0'], { resistance: 500 }),
    ] }, analyses: [{ type: 'tf', output, source: 'V1' }],
  } as SpiceTsCircuitDocumentV1;
  return { apiVersion: '1', input: { format: 'spice-ts', document } };
}

describe('native protocol transfer function', () => {
  it.each([
    [{ type: 'tf', output: 'v(out)' }, 'source'],
    [{ type: 'tf', output: 'v(missing)', source: 'V1' }, 'output'],
    [{ type: 'tf', output: 'v(out)+1', source: 'V1' }, 'output'],
    [{ type: 'tf', output: null, source: 'V1' }, 'output'],
  ])('returns a structured diagnostic for %j', async (analysis, field) => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('expected native input');
    input.input.document.analyses = [analysis as never];
    const result = await executeProtocolV1(input);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/analyses/0/${field}` } } });
  });
  it.each(['v(X1.mid)', 'v(in,X1.mid)', 'v(x1.MID)'])('matches text for expanded subcircuit output %s', async output => {
    const input = request(output);
    if (input.input.format !== 'spice-ts') throw new Error('expected native input');
    const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
    input.input.document.circuit = { nets: ['in'], components: [
      component('V', 'V1', ['in', '0'], { dc: 1 }),
      { ...component('X', 'X1', ['in', '0'], {}), subcircuit: 'div' },
    ] };
    input.input.document.subcircuits = [{ name: 'div', ports: ['a', 'b'], components: [
      component('R', 'R1', ['a', 'mid'], { resistance: 1000 }),
      component('R', 'R2', ['mid', 'b'], { resistance: 1000 }),
    ] }];
    const source = `.subckt div a b\nR1 a mid 1000\nR2 mid b 1000\n.ends\nV1 in 0 1\nX1 in 0 div\n.tf ${output} V1`;
    expect(ajv.validate(`${base}simulation-request.schema.json`, input)).toBe(true);
    const expected = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source } });
    expect(expected.analyses[0]).toMatchObject({ type: 'tf', transferFunction: 0.5, inputResistanceOhm: 2000, outputResistanceOhm: 500 });
    expect(await simulateProtocolV1(input)).toEqual(expected);
    expect(await validateProtocolV1(input)).toMatchObject({ status: 'valid' });
    input.input.document.analyses = [{ type: 'tf', output: 'v(X1.missing)', source: 'V1' }];
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: '/input/document/analyses/0/output' } } });
    await expect(validateProtocolV1(input)).rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', details: { path: '/input/document/analyses/0/output' } } });
  });
  it.each(['v(out)', 'v(out,mid)', 'i(V1)'])('matches text .tf %s within 1e-12 relative', async output => {
    const input = request(output);
    expect(ajv.validate(`${base}simulation-request.schema.json`, input)).toBe(true);
    const expected = (await simulate(parseTitleless(`${deck}\n.tf ${output} V1`))).transferFunction!;
    const actual = await simulateProtocolV1(input);
    const result = actual.analyses[0];
    expect(result.type).toBe('tf');
    for (const [field, value] of Object.entries({ transferFunction: expected.transfer, inputResistanceOhm: expected.inputResistance, outputResistanceOhm: expected.outputResistance })) {
      expect(Math.abs((result as unknown as Record<string, number>)[field] - value)).toBeLessThanOrEqual(Math.abs(value) * 1e-12);
    }
    expect(ajv.validate(`${base}simulation-result.schema.json`, actual)).toBe(true);
    expect(await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${deck}\n.tf ${output} V1` } })).toEqual(actual);
  });
});
