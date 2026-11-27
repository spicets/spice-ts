import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import type { ComplexPolarV1, SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

type Polarity = 'NJF' | 'PJF';
type Grid = 'lin' | 'dec' | 'oct';
function requests(polarity: Polarity, grid: Grid, scaled: boolean): [SimulationRequestV1, SimulationRequestV1] {
  const sign = polarity === 'NJF' ? 1 : -1;
  const document: SpiceTsCircuitDocumentV1 = {
    format: 'spice-ts', schemaVersion: '1.0',
    models: [{ name: 'JM', type: polarity, params: { LEVEL: 2, VTO: -2, BETA: 0.001, CGS: 1e-9, CGD: 2e-10 } }], subcircuits: [],
    circuit: { nets: ['supply', 'd', 'g'], components: [
      { type: 'V', id: 'Vd', name: 'Vd', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: '0' }], params: { dc: sign * 3 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: 'd' }], params: { resistance: 100 } },
      { type: 'V', id: 'Vg', name: 'Vg', ports: [{ name: 'p', net: 'g' }, { name: 'n', net: '0' }], params: { waveform: 'ac', dc: -sign, magnitude: 2, phase: 30 } },
      { type: 'J', id: 'J1', name: 'J1', ports: scaled ? [{ name: '2', net: '0' }, { name: '0', net: 'd' }, { name: '1', net: 'g' }] : [{ name: 'source', net: '0' }, { name: 'drain', net: 'd' }, { name: 'gate', net: 'g' }], params: scaled ? { AREA: 2, M: 3 } : {}, model: 'JM' },
    ] }, analyses: [{ type: 'ac', variation: grid, points: 5, startFreq: 1, stopFreq: 1024 }],
  };
  const native: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document } };
  const text: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: `Vd supply 0 ${sign * 3}\nR1 supply d 100\nVg g 0 DC ${-sign} AC 2 30\nJ1 d g 0 JM ${scaled ? 'AREA=2 M=3' : ''}\n.model JM ${polarity} LEVEL=2 VTO=-2 BETA=0.001 CGS=1e-9 CGD=2e-10\n.ac ${grid} 5 1 1024` } };
  return [native, text];
}
function compare(label: string, actual: number[], expected: number[]) {
  expect(actual.length).toBeGreaterThan(0);
  expect(actual.length).toBe(expected.length);
  let max = 0; let sum = 0;
  for (let i = 0; i < actual.length; i++) {
    expect(Number.isFinite(actual[i]!) && Number.isFinite(expected[i]!)).toBe(true);
    const delta = Math.abs(actual[i]! - expected[i]!);
    expect(delta).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected[i]!)));
    max = Math.max(max, delta); sum += delta * delta;
  }
  console.info(`${label} maxAbs=${max} rmsAbs=${Math.sqrt(sum / actual.length)} points=${actual.length}`);
}
const cartesian = (values: ComplexPolarV1[], part: 'real' | 'imag') => values.map(({ magnitude, phaseDegrees }) => magnitude * (part === 'real' ? Math.cos : Math.sin)(phaseDegrees * Math.PI / 180));

describe('native level-2 JFET AC', () => {
  it.each(['NJF', 'PJF'] as const)('%s matches text over all grids and instance forms', async polarity => {
    for (const grid of ['lin', 'dec', 'oct'] as const) for (const scaled of [false, true]) {
      const [native, text] = requests(polarity, grid, scaled);
      const envelope = await executeProtocolV1(native);
      if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
      expect(envelope.ok).toBe(true);
      const actual = (await simulateProtocolV1(native)).analyses[0];
      const expected = (await simulateProtocolV1(text)).analyses[0];
      if (actual?.type !== 'ac' || expected?.type !== 'ac') throw new Error('expected AC');
      expect(envelope.data.analyses[0]).toEqual(actual);
      compare(`${polarity} ${grid} scaled=${scaled} frequency`, actual.frequencyHz, expected.frequencyHz);
      for (const [name, a, b] of [['drain', actual.voltagePhasors.d!, expected.voltagePhasors.d!], ['supply', actual.currentPhasors.Vd!, expected.currentPhasors.Vd!]] as const) {
        expect(a.length).toBe(actual.frequencyHz.length);
        for (const part of ['real', 'imag'] as const) compare(`${polarity} ${grid} scaled=${scaled} ${name} ${part}`, cartesian(a, part), cartesian(b, part));
      }
      const input = actual.voltagePhasors.g![0]!;
      const output = actual.voltagePhasors.d![0]!;
      expect(input.magnitude).toBeCloseTo(2, 10);
      expect(input.phaseDegrees).toBeCloseTo(30, 8);
      expect(output.magnitude / input.magnitude).toBeGreaterThan(0.01);
      expect(output.magnitude / input.magnitude).toBeLessThan(2);
      const phaseDifference = (output.phaseDegrees - input.phaseDegrees) * Math.PI / 180;
      expect(Math.cos(phaseDifference)).toBeLessThan(-0.95);
    }
  });

  it.each([
    ['variation', 'bad'], ['points', 0], ['points', 1.5], ['startFreq', 0], ['stopFreq', 0],
  ])('rejects malformed AC %s=%s', async (field, value) => {
    const [request] = requests('NJF', 'dec', false);
    if (request.input.format !== 'spice-ts') throw new Error('native');
    Object.assign(request.input.document.analyses[0]!, { [field]: value });
    const result = await executeProtocolV1(request);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/analyses/0/${field}` } } });
  });

  it('rejects a reversed AC frequency range', async () => {
    const [request] = requests('NJF', 'dec', false);
    if (request.input.format !== 'spice-ts') throw new Error('native');
    Object.assign(request.input.document.analyses[0]!, { stopFreq: 0.5 });
    const result = await executeProtocolV1(request);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/analyses/0/stopFreq' } } });
  });

  it.each(['magnitude', 'phase', 'dc'])('rejects nonfinite AC source %s', async field => {
    const [request] = requests('PJF', 'lin', false);
    if (request.input.format !== 'spice-ts') throw new Error('native');
    request.input.document.circuit.components[2]!.params[field] = Infinity;
    const result = await executeProtocolV1(request);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
  });
});
