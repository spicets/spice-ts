import { describe, expect, it } from 'vitest';
import { Circuit, simulate } from '../index.js';
import { mapProtocolErrorV1, simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

function document(params: Record<string, number>): SpiceTsCircuitDocumentV1 {
  return {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in'], components: [
      { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { resistance: 1000, ...params } },
    ] }, analyses: [{ type: 'op' }],
  };
}

describe('native resistor temperature coefficients', () => {
  it.each<Record<string, number>>([{ TC1: 0.001 }, { TC2: 0.00001 }, { TC1: 0.001, TC2: 0.00001 }, {}])('matches Circuit and SPICE text for %j', async params => {
    const currents: number[] = [];
    for (const temperature of [-40, 27, 85]) {
      const doc = document(params);
      const original = structuredClone(doc);
      const result = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document: doc }, options: { temperature, nominalTemperature: 27 } });
      const op = result.analyses[0];
      if (op?.type !== 'op') throw new Error('expected OP');
      const actual = op.currentsA.V1!;
      const circuit = new Circuit();
      circuit.addVoltageSource('V1', 'in', '0', { dc: 1 });
      circuit.addResistor('R1', 'in', '0', 1000, params);
      circuit.setTemperature(temperature);
      circuit.setNominalTemperature(27);
      circuit.addAnalysis('op');
      const direct = (await simulate(circuit)).dc!.current('V1');
      const coefficients = Object.entries(params).map(([key, value]) => `${key}=${value}`).join(' ');
      const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `V1 in 0 1\nR1 in 0 1000 ${coefficients}\n.temp ${temperature}\n.options TNOM=27\n.op` } });
      const textOp = text.analyses[0];
      if (textOp?.type !== 'op') throw new Error('expected OP');
      expect(Math.abs(actual - direct)).toBeLessThan(1e-10);
      expect(Math.abs(actual - textOp.currentsA.V1!)).toBeLessThan(1e-10);
      expect(doc).toEqual(original);
      currents.push(actual);
    }
    if ('TC1' in params) expect(new Set(currents).size).toBe(3);
    else if (!('TC2' in params)) expect(new Set(currents).size).toBe(1);
  });

  it.each(['TC1', 'TC2'])('rejects invalid subcircuit resistor %s with its document path', async field => {
    for (const value of ['bad', null, NaN, Infinity, -Infinity]) {
      const doc = document({});
      const resistor = doc.circuit.components.pop()!;
      resistor.ports[0]!.net = 'p';
      resistor.params[field] = value as number;
      doc.subcircuits = [
        { name: 'unused', ports: ['p'], components: [] },
        { name: 'load', ports: ['p'], components: [resistor] },
      ];
      doc.circuit.components.push({ type: 'X', id: 'X1', name: 'X1', ports: [{ name: 'p', net: 'in' }], params: {}, subcircuit: 'load' });
      const original = structuredClone(doc);
      const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: doc }, options: { temperature: 85 } };
      await expect(simulateProtocolV1(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/subcircuits/1/components/0/params/${field}` } });
      expect(doc).toEqual(original);
    }
  });

  it.each(['TC1', 'TC2'])('rejects invalid %s as a structured error', async field => {
    for (const value of ['bad', null, NaN, Infinity, -Infinity]) {
      const doc = document({});
      doc.circuit.components[1]!.params[field] = value as number;
      const original = structuredClone(doc);
      const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document: doc } };
      await expect(simulateProtocolV1(request).catch(mapProtocolErrorV1)).resolves.toMatchObject({ code: 'INVALID_REQUEST', details: { path: `/input/document/circuit/components/1/params/${field}` } });
      expect(doc).toEqual(original);
    }
  });
});
