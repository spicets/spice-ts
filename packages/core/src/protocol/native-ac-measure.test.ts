import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeProtocolV1, protocolCapabilitiesV1 } from './envelopes.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import { parseTitleless } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1 } from './types.js';

function request(): SimulationRequestV1 {
  const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
  return { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out'], components: [component('V', 'V1', ['in', '0'], { waveform: 'ac', dc: 0, magnitude: 1 }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('C', 'C1', ['out', '0'], { capacitance: 100e-9 })] }, analyses: [{ type: 'ac', variation: 'dec', points: 20, startFreq: 10, stopFreq: 100000, measurements: [{ name: 'sample', kind: 'find', vector: 'vm(out)', at: 1000 }] } as never] } } };
}

const kinds = ['avg', 'min', 'max', 'pp', 'rms', 'integ'];
function setMeasurements(input: SimulationRequestV1, measurements: unknown) {
  if (input.input.format !== 'spice-ts') throw new Error('native');
  (input.input.document.analyses[0] as { measurements?: unknown }).measurements = measurements;
}
const schema = () => { const ajv = new Ajv2020({ strict: true }); for (const s of Object.values(protocolSchemasV1)) ajv.addSchema(s); return ajv; };
const requestSchema = 'https://spice-ts.dev/schemas/v1/simulation-request.schema.json';

describe('native AC measurements', () => {
  it('evaluates FIND AT magnitude', async () => {
    const result = await simulateProtocolV1(request());
    expect(result.analyses[0]).toMatchObject({ type: 'ac', measurements: [{ name: 'sample', value: expect.any(Number) }] });
  });
  it('matches the SPICE text engine on an original RC low-pass', async () => {
    const entries = ['vm', 'vdb', 'vp'].map(v => ({ name: v, kind: 'find', vector: `${v}(out)`, at: 1000 })).concat(kinds.map(kind => ({ name: kind, kind, vector: 'vm(out)', from: 100, to: 10000 })) as never);
    const cards = ['vm', 'vdb', 'vp'].map(v => `.meas ac ${v} find ${v}(out) at=1000`).concat(kinds.map(kind => `.meas ac ${kind} ${kind} vm(out) from=100 to=10000`));
    const text = await simulate(parseTitleless(`V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 20 10 100000\n${cards.join('\n')}`));
    const input = request(); setMeasurements(input, entries);
    const ajv = schema(); expect(ajv.validate(requestSchema, input)).toBe(true);
    expect(protocolCapabilitiesV1().analyses.find(a => a.type === 'ac')?.features).toContain('measurements:ac');
    const actual = await simulateProtocolV1(input);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', actual)).toBe(true);
    const ac = actual.analyses[0]; if (ac.type !== 'ac') throw new Error('ac');
    expect(ac.frequencyHz).toEqual(text.ac!.frequencies);
    expect(text.measurements!.every(m => m.status === 'ok')).toBe(true);
    const measured = ac.measurements!;
    expect(measured).toHaveLength(9);
    const deltas = measured.map((m, i) => Math.abs(('value' in m ? m.value : NaN) - text.measurements![i]!.value!));
    expect(Math.max(...deltas)).toBeLessThanOrEqual(1e-12);
    const first = measured[0]; if (!('value' in first)) throw new Error('measurement failed');
    const expected = 1 / Math.sqrt(1 + (2 * Math.PI * 1000 * 1000 * 100e-9) ** 2);
    expect(first.value).toBeCloseTo(expected, 5);
    console.log('AC parity count, max delta, vm, analytic:', measured.length, Math.max(...deltas), first.value, expected, JSON.stringify(measured));
  });
  it.each([
    [[{ name: 'x', kind: 'find', vector: 'vm(out)', at: -1 }], '/0/at'],
    [[{ name: 'x', kind: 'find', vector: 'vm(out)', at: Infinity }], '/0/at'],
    [[{ name: 'x', kind: 'min', vector: 'vm(out)', from: -1 }], '/0/from'],
    [[{ name: 'x', kind: 'min', vector: 'vm(out)', from: 20, to: 10 }], '/0/to'],
    [[{ name: 'x', kind: 'min', vector: 'v(out)' }], '/0/vector'],
    [[{ name: 'x', kind: 'min', vector: 'vm(out,in)' }], '/0/vector'],
    [[{ name: 'x', kind: 'min', vector: 'vm(out)+1' }], '/0/vector'],
    [[{ name: 'x', kind: 'find', vector: 'vm(out)', when: {} }], '/0/when'],
    [[{ name: 'x', kind: 'trig' }], '/0/kind'],
    [[{ name: 'x', kind: 'min', vector: 'vm(out)', extra: 1 }], '/0/extra'],
    [[{ name: 'x', kind: 'min', vector: 'vm(out)' }, { name: 'X', kind: 'max', vector: 'vm(out)' }], '/1/name'],
    [Array.from({ length: 101 }, (_, i) => ({ name: `x${i}`, kind: 'min', vector: 'vm(out)' })), ''],
  ])('rejects invalid AC measurements at exact path', async (entries, suffix) => {
    const input = request(); setMeasurements(input, entries);
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: `/input/document/analyses/0/measurements${suffix}` } } });
    if (suffix !== '/1/name' && suffix !== '/0/to' && suffix !== '/0/at') expect(schema().validate(requestSchema, input)).toBe(false);
  });
  it('preserves measurement failure diagnostics', async () => {
    const input = request(); setMeasurements(input, [{ name: 'missing', kind: 'find', vector: 'vm(absent)', at: 1000 }, { name: 'outside', kind: 'find', vector: 'vm(out)', at: 1e9 }]);
    const result = await simulateProtocolV1(input);
    expect(result.analyses[0]).toMatchObject({ measurements: [{ name: 'missing', diagnostic: { code: 'MEASUREMENT_FAILED' } }, { name: 'outside', diagnostic: { code: 'MEASUREMENT_FAILED' } }] });
    expect(JSON.stringify(result)).not.toContain('NaN');
  });

  it('honors cancellation between AC measurements', async () => {
    const input = request(); setMeasurements(input, [{ name: 'a', kind: 'find', vector: 'vm(out)', at: 1000 }, { name: 'b', kind: 'max', vector: 'vm(out)' }]);
    const signal = { aborted: false }; let count = 0;
    await expect(simulateProtocolV1(input, { signal, onSafePoint(point) { if (point === 'solve:measurement' && ++count === 2) signal.aborted = true; } })).rejects.toMatchObject({ apiError: { code: 'CANCELLED', phase: 'solve', details: { safePoint: 'solve:measurement' } } });
    expect(count).toBe(2);
  });
  it('enforces serialization quotas after measurements', async () => {
    const input = request(); input.options = { limits: { maxSerializedResultBytes: 100 } };
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', phase: 'serialize' } });
  });

});
