import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

type Polarity = 'NJF' | 'PJF';
function requests(polarity: Polarity, scaled = false): [SimulationRequestV1, SimulationRequestV1] {
  const sign = polarity === 'NJF' ? 1 : -1;
  const document: SpiceTsCircuitDocumentV1 = {
    format: 'spice-ts', schemaVersion: '1.0',
    models: [{ name: 'JM', type: polarity, params: { LEVEL: 2, VTO: -2, BETA: 0.001, CGS: 1e-9, CGD: 2e-10 } }], subcircuits: [],
    circuit: { nets: ['supply', 'd', 'g'], components: [
      { type: 'V', id: 'Vd', name: 'Vd', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: '0' }], params: { dc: sign * 3 } },
      { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'supply' }, { name: 'n', net: 'd' }], params: { resistance: 100 } },
      { type: 'V', id: 'Vg', name: 'Vg', ports: [{ name: 'p', net: 'g' }, { name: 'n', net: '0' }], params: { waveform: 'pulse', v1: -sign, v2: -sign * 0.5, delay: 0, rise: 0.00001, fall: 0.00001, width: 0.0001, period: 0.0004 } },
      { type: 'J', id: 'J1', name: 'J1', ports: [{ name: 'source', net: '0' }, { name: 'drain', net: 'd' }, { name: 'gate', net: 'g' }], params: scaled ? { AREA: 2, M: 3, ICVDS: sign * 2, ICVGS: -sign } : {}, model: 'JM' },
    ] }, analyses: [{ type: 'tran', timestep: 0.00001, stopTime: 0.0008, ...(scaled ? { uic: true as const } : {}) }],
  };
  const native: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice-ts', document } };
  const text: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: `Vd supply 0 ${sign * 3}\nR1 supply d 100\nVg g 0 PULSE(${-sign} ${-sign * 0.5} 0 0.00001 0.00001 0.0001 0.0004)\nJ1 d g 0 JM ${scaled ? `AREA=2 M=3 IC=${sign * 2},${-sign}` : ''}\n.model JM ${polarity} LEVEL=2 VTO=-2 BETA=0.001 CGS=1e-9 CGD=2e-10\n.tran 0.00001 0.0008${scaled ? ' UIC' : ''}\n.end` } };
  return [native, text];
}

describe('native level-2 JFET transient', () => {
  it.each(['NJF', 'PJF'] as const)('%s matches the text transient', async polarity => {
    for (const scaled of [false, true]) {
      const [native, text] = requests(polarity, scaled);
      const envelope = await executeProtocolV1(native);
      if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
      const actual = (await simulateProtocolV1(native)).analyses[0];
      const expected = (await simulateProtocolV1(text)).analyses[0];
      if (actual?.type !== 'tran' || expected?.type !== 'tran') throw new Error('transient required');
      expect(envelope.data.analyses[0]).toEqual(actual);
      expect(actual.timeS.length).toBeGreaterThan(1);
      expect(actual.timeS).toEqual(expected.timeS);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(expected[field]).sort());
        for (const [name, values] of Object.entries(actual[field])) {
          const reference = expected[field][name]!;
          expect(values.length).toBe(actual.timeS.length);
          expect(reference.length).toBe(values.length);
          values.forEach((value, i) => {
            expect(Number.isFinite(value) && Number.isFinite(reference[i]!)).toBe(true);
            expect(Math.abs(value - reference[i]!)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(reference[i]!)));
          });
        }
      }
      const drain = actual.voltagesV.d!;
      const min = Math.min(...drain); const max = Math.max(...drain);
      console.info(`${polarity} scaled=${scaled} samples=${drain.length} drainMin=${min} drainMax=${max}`);
      expect(max - min).toBeGreaterThan(1e-5);
    }
  });

  it.each(['NJF', 'PJF'] as const)('%s applies explicit instance IC under UIC', async polarity => {
    const [withIc] = requests(polarity, true);
    const [withoutIc] = requests(polarity, true);
    if (withoutIc.input.format !== 'spice-ts') throw new Error('native required');
    delete withoutIc.input.document.circuit.components[3]!.params.ICVDS;
    delete withoutIc.input.document.circuit.components[3]!.params.ICVGS;
    const a = (await simulateProtocolV1(withIc)).analyses[0];
    const b = (await simulateProtocolV1(withoutIc)).analyses[0];
    if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('transient required');
    expect(Math.abs(a.voltagesV.d![0]! - b.voltagesV.d![0]!)).toBeGreaterThan(1e-8);
  });

  it.each([
    ['timestep', 0], ['timestep', Infinity], ['stopTime', 0], ['stopTime', NaN],
    ['startTime', -1], ['startTime', Infinity], ['startTime', 0.001],
    ['maxTimestep', 0], ['maxTimestep', Infinity],
  ])('rejects invalid transient %s=%s on both paths', async (field, value) => {
    const [request] = requests('NJF');
    if (request.input.format !== 'spice-ts') throw new Error('native required');
    Object.assign(request.input.document.analyses[0]!, { [field]: value });
    const error = { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/analyses/0/${field}` } };
    await expect(simulateProtocolV1(request)).rejects.toMatchObject({ apiError: error });
    expect(await executeProtocolV1(request)).toMatchObject({ ok: false, error });
  });

  it.each([
    ['dc', 'dc'], ['ac', 'dc'], ['ac', 'magnitude'], ['ac', 'phase'],
    ['pulse', 'v1'], ['pulse', 'v2'], ['pulse', 'delay'], ['pulse', 'rise'], ['pulse', 'fall'], ['pulse', 'width'], ['pulse', 'period'],
    ['sin', 'offset'], ['sin', 'amplitude'], ['sin', 'frequency'], ['sin', 'delay'], ['sin', 'damping'], ['sin', 'phase'],
    ['am', 'carrierAmplitude'], ['sffm', 'modulationIndex'], ['exp', 'tau1'],
  ])('rejects nonfinite %s source %s on both paths', async (waveform, field) => {
    for (const sourceType of ['V', 'I']) for (const value of [Infinity, -Infinity, NaN]) {
      const [request] = requests('PJF');
      if (request.input.format !== 'spice-ts') throw new Error('native required');
      const source = request.input.document.circuit.components[2]!;
      source.type = sourceType;
      source.params = { ...source.params, waveform, [field]: value };
      const error = { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/circuit/components/2/params/${field}` } };
      await expect(simulateProtocolV1(request)).rejects.toMatchObject({ apiError: error });
      expect(await executeProtocolV1(request)).toMatchObject({ ok: false, error });
    }
  });

  it.each(['time', 'value'])('rejects a nonfinite PWL point %s', async field => {
    const [request] = requests('NJF');
    if (request.input.format !== 'spice-ts') throw new Error('native required');
    request.input.document.circuit.components[2]!.params = { waveform: 'pwl', points: [{ time: 0, value: 0 }, { time: 1, value: 1, [field]: Infinity }] };
    const error = { code: 'INVALID_REQUEST', phase: 'validation', details: { path: `/input/document/circuit/components/2/params/points/1/${field}` } };
    await expect(simulateProtocolV1(request)).rejects.toMatchObject({ apiError: error });
    expect(await executeProtocolV1(request)).toMatchObject({ ok: false, error });
  });

  it('rejects nonfinite PWL string points with a field path', async () => {
    const [request] = requests('NJF');
    if (request.input.format !== 'spice-ts') throw new Error('native required');
    request.input.document.circuit.components[2]!.params = { waveform: 'pwl', points: '0:0,1:Infinity' };
    const error = { code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/circuit/components/2/params/points' } };
    await expect(simulateProtocolV1(request)).rejects.toMatchObject({ apiError: error });
    expect(await executeProtocolV1(request)).toMatchObject({ ok: false, error });
  });
});
