import { expect, it } from 'vitest';
import { simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1 } from './types.js';

it('simulates a native EXP source with core', async () => {
  const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in'], components: [
      { type: 'V', name: 'V1', id: 'V1', ports: [{ name: '0', net: 'in' }, { name: '1', net: '0' }], params: { waveform: 'exp', v1: 1, v2: 2, td1: 0.0001, tau1: 0.0001, td2: 0.0005, tau2: 0.0001 } },
      { type: 'R', name: 'R1', id: 'R1', ports: [{ name: '0', net: 'in' }, { name: '1', net: '0' }], params: { resistance: 1000 } },
    ] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }],
  } } };
  const native = await simulateProtocolV1(request);
  const analysis = native.analyses[0];
  if (analysis?.type !== 'tran') throw new Error('transient required');
  expect(Math.max(...analysis.voltagesV.in!)).toBeGreaterThan(1.9);
  expect(analysis.voltagesV.in!.at(-1)).toBeLessThan(1.1);
});
