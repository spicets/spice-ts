import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeProtocolV1, protocolCapabilitiesV1 } from './envelopes.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import { parseTitleless } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1 } from './types.js';

const deck = 'V1 in 0 PULSE(0 1 0 0.000003814697265625 0.000003814697265625 0.000244140625 0.0009765625)\nR1 in out 1000\nR2 out 0 1000';
const measurements = [
  { name: 'delay', kind: 'trig', trig: { vector: 'v(out)', value: 0.25, rise: 1 }, targ: { vector: 'v(out)', value: 0.25, fall: 1 } },
  { name: 'sample', kind: 'find', vector: 'v(out)', at: 0.0001220703125 },
  { name: 'cross', kind: 'find', vector: 'v(in)', when: { vector: 'v(out)', value: 0.25, rise: 1 } },
  ...['avg', 'min', 'max', 'pp', 'rms', 'integ'].map(kind => ({ name: kind, kind, vector: 'v(out)', from: 0, to: 0.0009765625 })),
];
const cards = [
  '.meas tran delay trig v(out) val=0.25 rise=1 targ v(out) val=0.25 fall=1',
  '.meas tran sample find v(out) at=0.0001220703125',
  '.meas tran cross find v(in) when v(out)=0.25 rise=1',
  ...['avg', 'min', 'max', 'pp', 'rms', 'integ'].map(kind => `.meas tran ${kind} ${kind} v(out) from=0 to=0.0009765625`),
];
function request(): SimulationRequestV1 {
  const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
  return { apiVersion: '1', input: { format: 'spice-ts', document: {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out'], components: [
      component('V', 'V1', ['in', '0'], { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 0.000003814697265625, fall: 0.000003814697265625, width: 0.000244140625, period: 0.0009765625 }),
      component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('R', 'R2', ['out', '0'], { resistance: 1000 }),
    ] }, analyses: [{ type: 'tran', timestep: 0.0000152587890625, stopTime: 0.0009765625, measurements } as never],
  } } };
}

describe('native transient measurements', () => {
  it('matches equivalent SPICE text measurements bit-for-bit', async () => {
    const expected = await simulate(parseTitleless(`${deck}\n.tran 0.0000152587890625 0.0009765625\n${cards.join('\n')}`));
    const input = request();
    const ajv = new Ajv2020({ strict: true });
    for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', input)).toBe(true);
    const actual = await simulateProtocolV1(input);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', actual)).toBe(true);
    expect(protocolCapabilitiesV1().analyses.find(a => a.type === 'tran')?.features).toContain('measurements:tran');
    const tran = actual.analyses[0] as { measurements?: { name: string; value: number }[] };
    expect(expected.measurements?.every(m => m.status === 'ok')).toBe(true);
    expect(tran.measurements).toEqual(expected.measurements?.map(m => ({ name: m.name, value: m.value })));
  });
  it('resolves differential voltages for find and crossing measurements', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'tran') throw new Error('tran');
    analysis.measurements = [
      { name: 'forward', kind: 'find', vector: 'v(in,out)', at: 0.0001220703125 },
      { name: 'reverse', kind: 'find', vector: 'v(out,in)', at: 0.0001220703125 },
      { name: 'ground', kind: 'find', vector: 'v(0,out)', at: 0.0001220703125 },
      { name: 'crossing', kind: 'find', vector: 'v(in,out)', when: { vector: 'v(in,out)', value: 0.25, rise: 1 } },
      { name: 'unknown', kind: 'find', vector: 'v(in,absent)', at: 0.0001220703125 },
    ];
    const result = await simulateProtocolV1(input);
    const text = await simulate(parseTitleless(`${deck}\n.tran 0.0000152587890625 0.0009765625\n.meas tran forward find v(in,out) at=0.0001220703125\n.meas tran reverse find v(out,in) at=0.0001220703125\n.meas tran ground find v(0,out) at=0.0001220703125\n.meas tran crossing find v(in,out) when v(in,out)=0.25 rise=1`));
    expect(result.analyses[0]).toMatchObject({ measurements: [
      { name: 'forward', value: 0.5 }, { name: 'reverse', value: -0.5 },
      { name: 'ground', value: -0.5 }, { name: 'crossing', value: 0.25 },
      { name: 'unknown', diagnostic: { code: 'MEASUREMENT_FAILED' } },
    ] });
    expect(text.measurements?.map(m => ({ name: m.name, value: m.value }))).toEqual(
      (result.analyses[0] as { measurements: unknown[] }).measurements.slice(0, 4),
    );
  });
  it.each([
    [{ name: 'x', kind: 'wat' }, 'kind'],
    [{ name: 'x', kind: 'trig', trig: { vector: 'v(out)', value: 0.25 } }, 'targ'],
  ])('rejects malformed measurement %j with INVALID_REQUEST', async (measurement, field) => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'tran') throw new Error('tran');
    analysis.measurements = [measurement as never];
    const ajv = new Ajv2020({ strict: true });
    for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', input)).toBe(false);
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: `/input/document/analyses/0/measurements/0/${field}` } } });
  });
  it('returns a typed diagnostic when a FIND WHEN crossing is never satisfied', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'tran') throw new Error('tran');
    analysis.measurements = [{ name: 'missing', kind: 'find', vector: 'v(in)', when: { vector: 'v(out)', value: 2, rise: 1 } }];
    const response = await simulateProtocolV1(input);
    const ajv = new Ajv2020({ strict: true });
    for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', response)).toBe(true);
    const result = response.analyses[0];
    expect(result).toMatchObject({ type: 'tran', measurements: [{ name: 'missing', diagnostic: { code: 'MEASUREMENT_FAILED' } }] });
  });
  it('keeps measurements scoped to their own transient analysis', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    input.input.document.analyses.push({ type: 'tran', timestep: 0.0000152587890625, stopTime: 0.0009765625 });
    const result = await simulateProtocolV1(input);
    expect(result.analyses[0]).toHaveProperty('measurements');
    expect(result.analyses[1]).not.toHaveProperty('measurements');
  });
  it('observes cancellation between measurements', async () => {
    const signal = { aborted: false };
    let count = 0;
    await expect(simulateProtocolV1(request(), { signal, onSafePoint(point) {
      if (point === 'solve:measurement' && ++count === 2) signal.aborted = true;
    } })).rejects.toMatchObject({ apiError: { code: 'CANCELLED', phase: 'solve', details: { safePoint: 'solve:measurement' } } });
    expect(count).toBe(2);
  });

});
