import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeProtocolV1, protocolCapabilitiesV1 } from './envelopes.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import { canonicalJson } from './wire/canonical-json.js';
import { parseTitleless } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1 } from './types.js';

const kinds = ['avg', 'min', 'max', 'pp', 'rms', 'integ'];
const measurements = [
  { name: 'sample', kind: 'find', vector: 'v(out)', at: 4 },
  { name: 'crossing', kind: 'find', vector: 'v(in)', when: { vector: 'v(out)', value: 2, rise: 1 } },
  ...kinds.map(kind => ({ name: kind, kind, vector: 'v(out)', from: 2, to: 8 })),
];
function request(): SimulationRequestV1 {
  const component = (type: string, name: string, nets: string[], params: Record<string, number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
  return { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'out'], components: [component('V', 'V1', ['in', '0'], { dc: 0 }), component('R', 'R1', ['in', 'out'], { resistance: 1000 }), component('R', 'R2', ['out', '0'], { resistance: 1000 })] }, analyses: [{ type: 'dc', source: 'V1', start: 0, stop: 10, step: 0.25, measurements } as never] } } };
}
describe('native DC measurements', () => {
  it('matches SPICE text and the analytic divider', async () => {
    const cards = ['.meas dc sample find v(out) at=4', '.meas dc crossing find v(in) when v(out)=2 rise=1', ...kinds.map(kind => `.meas dc ${kind} ${kind} v(out) from=2 to=8`)];
    const text = await simulate(parseTitleless(`V1 in 0 0\nR1 in out 1k\nR2 out 0 1k\n.dc V1 0 10 0.25\n${cards.join('\n')}`));
    const input = request();
    const ajv = new Ajv2020({ strict: true });
    for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', input)).toBe(true);
    expect(JSON.parse(canonicalJson(input))).toEqual(input);
    expect(protocolCapabilitiesV1().analyses.find(a => a.type === 'dc')?.features).toContain('measurements:dc');
    const actual = await simulateProtocolV1(input);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', actual)).toBe(true);
    expect(JSON.parse(canonicalJson(actual))).toEqual(actual);
    const dc = actual.analyses[0] as { measurements: { name: string; value: number; unit?: string }[] };
    expect(text.measurements?.every(m => m.status === 'ok')).toBe(true);
    expect(dc.measurements).toEqual(text.measurements?.map(m => ({ name: m.name, value: m.value })));
    const difference = Math.max(...dc.measurements.map((m, i) => Math.abs(m.value - text.measurements![i]!.value!)));
    expect(difference).toBe(0);
    console.log('DC JSON/text max absolute difference:', difference);
    expect(dc.measurements.find(m => m.name === 'sample')!.value).toBeCloseTo(2, 12);
    expect(dc.measurements.find(m => m.name === 'min')!.value).toBeCloseTo(1, 12);
    expect(dc.measurements.find(m => m.name === 'max')!.value).toBeCloseTo(4, 12);
  });
  it('returns an individual diagnostic when a crossing is absent', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'dc') throw new Error('dc');
    analysis.measurements = [{ name: 'missing', kind: 'find', vector: 'v(in)', when: { vector: 'v(out)', value: 20 } }];
    const response = await simulateProtocolV1(input);
    expect(response.analyses[0]).toMatchObject({ type: 'dc', measurements: [{ name: 'missing', diagnostic: { code: 'MEASUREMENT_FAILED' } }] });
  });
  it.each([
    [[{ name: 'x', kind: 'wat' }], '/0/kind'],
    [[{ name: 'x', kind: 'find', vector: 'bad', at: 1 }], '/0/vector'],
    [[{ name: 'x', kind: 'min', vector: 'v(out)' }, { name: 'X', kind: 'max', vector: 'v(out)' }], '/1/name'],
    [Array.from({ length: 101 }, (_, i) => ({ name: `x${i}`, kind: 'min', vector: 'v(out)' })), ''],
    [[{ name: 'x', kind: 'trig' }], '/0/kind'],
  ])('rejects invalid DC measurements', async (entries, suffix) => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'dc') throw new Error('dc');
    analysis.measurements = entries as never;
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: `/input/document/analyses/0/measurements${suffix}` } } });
  });
  it('rejects measurements on nested DC', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'dc') throw new Error('dc');
    input.input.document.circuit.components.push({ type: 'V', name: 'V2', id: 'V2', ports: [{ name: '0', net: 'aux' }, { name: '1', net: '0' }], params: { dc: 0 } });
    analysis.secondary = { source: 'V2', start: 0, stop: 1, step: 1 };
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: '/input/document/analyses/0/measurements' } } });
  });
});
