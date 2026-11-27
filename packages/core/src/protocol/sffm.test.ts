import { describe, expect, it } from 'vitest';
import { evaluateSffm } from '../devices/voltage-source.js';
import type { SffmSource } from '../types.js';
import { mapProtocolErrorV1, simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1 } from './types.js';

type Params = Record<string, number | string>;
const stopTime = 0.002;
const port = (net: string, name: string) => ({ name, net });

function native(kind: 'V' | 'I', params: Params): SimulationRequestV1 {
  const component = (type: string, name: string, a: string, b: string, p: Params) => ({
    type, name, id: name, ports: [port(a, '0'), port(b, '1')], params: p,
  });
  const components = kind === 'V' ? [
    component('V', 'V1', 'in', '0', { waveform: 'sffm', ...params }),
    component('R', 'R1', 'in', 'out', { resistance: 1000 }),
    component('C', 'C1', 'out', '0', { capacitance: 1e-7 }),
  ] : [
    component('I', 'I1', '0', 'in', { waveform: 'sffm', ...params }),
    component('V', 'Vprobe', 'in', 'out', { dc: 0 }),
    component('R', 'R1', 'out', 'mid', { resistance: 100 }),
    component('L', 'L1', 'mid', '0', { inductance: 0.01 }),
  ];
  return { apiVersion: '1', input: { format: 'spice-ts', document: {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in', 'out', 'mid'], components },
    analyses: [{ type: 'tran', timestep: 1e-5, stopTime }],
  } } };
}

function text(kind: 'V' | 'I', args: string, dc = ''): SimulationRequestV1 {
  const source = kind === 'V'
    ? `V1 in 0 ${dc} SFFM(${args})\nR1 in out 1000\nC1 out 0 1e-7`
    : `I1 0 in ${dc} SFFM(${args})\nVprobe in out 0\nR1 out mid 100\nL1 mid 0 0.01`;
  return { apiVersion: '1', input: { format: 'spice', source: `${source}\n.tran 1e-5 ${stopTime}` } };
}

async function tran(request: SimulationRequestV1) {
  const result = (await simulateProtocolV1(request)).analyses[0];
  if (result?.type !== 'tran') throw new Error('transient required');
  return result;
}

const cases: Array<{ name: string; params: Params; args: string; dc?: string }> = [
  { name: 'modulated', params: { offset: 0.2, amplitude: 1, carrierFrequency: 1000, modulationIndex: 2, signalFrequency: 100 }, args: '0.2 1 1000 2 100' },
  { name: 'zero modulation', params: { offset: 0.2, amplitude: 1, carrierFrequency: 1000, modulationIndex: 0, signalFrequency: 100 }, args: '0.2 1 1000 0 100' },
  { name: 'defaults', params: { offset: 0.2, amplitude: 1 }, args: '0.2 1' },
  { name: 'delay and phases with explicit dc', params: { offset: 0.2, amplitude: 1, carrierFrequency: 1000, modulationIndex: 2, signalFrequency: 100, delay: 0.0002, signalPhase: 30, carrierPhase: 45, dc: 0.3 }, args: '0.2 1 1000 2 100 0.0002 30 45', dc: 'DC 0.3' },
];

describe('native SFFM transient sources', () => {
  it.each(cases.flatMap(c => (['V', 'I'] as const).map(kind => ({ ...c, kind }))))('$kind $name matches text and evaluator', async ({ kind, params, args, dc }) => {
    const actual = await tran(native(kind, params));
    const reference = await tran(text(kind, args, dc));
    expect(actual.timeS.length).toBeGreaterThan(1);
    expect(actual.timeS).toEqual(reference.timeS);
    const traces = kind === 'V' ? [['in', actual.voltagesV.in!, reference.voltagesV.in!], ['out', actual.voltagesV.out!, reference.voltagesV.out!], ['V1', actual.currentsA.V1!, reference.currentsA.V1!]] as const
      : [['out', actual.voltagesV.out!, reference.voltagesV.out!], ['mid', actual.voltagesV.mid!, reference.voltagesV.mid!], ['Vprobe', actual.currentsA.Vprobe!, reference.currentsA.Vprobe!]] as const;
    for (const [name, values, expected] of traces) {
      expect(values.length, name).toBe(actual.timeS.length);
      expect(values.every(Number.isFinite), name).toBe(true);
      const scale = Math.max(...expected.map(Math.abs), 1e-30);
      const errors = values.map((v, i) => Math.abs(v - expected[i]!) / scale);
      const max = Math.max(...errors);
      const rms = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
      console.info(`SFFM ${kind} ${name} ${args}: n=${errors.length} max=${max} rms=${rms}`);
      expect(max, name).toBeLessThanOrEqual(0.01);
      expect(rms, name).toBeLessThanOrEqual(0.01);
    }
    const waveform = { type: 'sffm', ...params } as SffmSource;
    const samples = kind === 'V' ? actual.voltagesV.in! : actual.currentsA.Vprobe!;
    for (let i = 1; i < actual.timeS.length; i++) {
      expect(samples[i], `source at ${actual.timeS[i]}`).toBeCloseTo(evaluateSffm(waveform, actual.timeS[i]!, stopTime), 7);
    }
  });

  it.each(['offset', 'amplitude', 'carrierFrequency', 'modulationIndex', 'signalFrequency', 'delay', 'signalPhase', 'carrierPhase', 'dc'])('rejects malformed and nonfinite %s', async field => {
    for (const value of ['bad', NaN, Infinity, -Infinity]) {
      await expect(simulateProtocolV1(native('V', { offset: 0, amplitude: 1, [field]: value }))).rejects.toSatisfy((error: unknown) => mapProtocolErrorV1(error).code === 'INVALID_CIRCUIT');
    }
  });

  it.each(['V', 'I'] as const)('rejects invalid %s source ports with structured errors', async kind => {
    for (const ports of [[port('in', '0')], [port('in', '0'), port('', '1')], [port('in', '0'), port('0', '1'), port('out', '2')]]) {
      const request = native(kind, { offset: 0, amplitude: 1 });
      if (request.input.format !== 'spice-ts') throw new Error('native required');
      request.input.document.circuit.components[0]!.ports = ports;
      await expect(simulateProtocolV1(request)).rejects.toSatisfy((error: unknown) => mapProtocolErrorV1(error).code === 'INVALID_CIRCUIT');
    }
  });

  it.each(['offset', 'amplitude'])('rejects missing %s', async field => {
    const params: Params = { offset: 0, amplitude: 1 };
    delete params[field];
    await expect(simulateProtocolV1(native('I', params))).rejects.toSatisfy((error: unknown) => mapProtocolErrorV1(error).code === 'INVALID_CIRCUIT');
  });
});
