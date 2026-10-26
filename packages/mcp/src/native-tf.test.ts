import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';

const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'v', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
    { type: 'R', id: 'r1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'R', id: 'r2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
  ] }, analyses: [{ type: 'tf', output: 'v(out)', source: 'V1' }],
} } };

describe('native JSON transfer function forwarding', () => {
  it('returns the same scalar result as the SPICE text request', async () => {
    const actual = await executeTool('spice_simulate', { request });
    expect(actual.isError).not.toBe(true);
    const expected = await executeTool('spice_simulate', { request: { apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nR2 out 0 1k\n.tf v(out) V1' } } });
    expect(actual.structuredContent).toEqual(expected.structuredContent);
    expect(actual.structuredContent).toMatchObject({ analyses: [{ type: 'tf', transferFunction: 0.5, inputResistanceOhm: 2000, outputResistanceOhm: 500 }] });
  });
});
