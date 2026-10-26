import { describe, expect, it } from 'vitest';
import { circuitFromDocument, simulateNoiseProtocolV1 } from './adapter.js';
import type { SpiceTsCircuitDocumentV1 } from './types.js';

const noise = { type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 10, startFreq: 1, stopFreq: 1e6 };
const document = {
  format: 'spice-ts', schemaVersion: '1.0',
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'ac', dc: 0, magnitude: 1 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { capacitance: 1e-9 } },
  ] }, analyses: [], models: [], subcircuits: [], noiseAnalyses: [noise],
};
const native = (value: unknown) => value as SpiceTsCircuitDocumentV1;

describe('native protocol noise', () => {
  it('preserves the noise directive', () => {
    expect(circuitFromDocument(native(document)).analyses).toEqual([noise]);
  });
  it.each([
    ['type', 'ac'], ['outputNode', ''], ['outputReferenceNode', 0], ['inputSource', ''],
    ['variation', 'bad'], ['points', 0], ['points', 1.5], ['startFreq', 0], ['stopFreq', Infinity], ['stopFreq', 0.5], ['extra/key', 1],
  ])('rejects invalid %s with a pointer', (field, value) => {
    expect(() => circuitFromDocument(native({ ...document, noiseAnalyses: [{ ...noise, [field]: value }] })))
      .toThrowError(expect.objectContaining({ apiError: expect.objectContaining({ code: 'INVALID_REQUEST', details: { path: `/input/document/noiseAnalyses/0/${field.replaceAll('/', '~1')}` } }) }));
  });
  it.each([null, {}, 'noise'])('rejects a malformed noise array: %j', noiseAnalyses => {
    expect(() => circuitFromDocument(native({ ...document, noiseAnalyses }))).toThrowError(expect.objectContaining({ apiError: expect.objectContaining({ code: 'INVALID_REQUEST', details: { path: '/input/document/noiseAnalyses' } }) }));
  });
  it.each(['dec', 'oct', 'lin'])('matches text spectra exactly for %s', async variation => {
    const analysis = { ...noise, variation, outputReferenceNode: '0' };
    const input = { format: 'spice-ts' as const, document: native({ ...document, noiseAnalyses: [analysis] }) };
    const text = `V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n.noise V(out,0) V1 ${variation} 10 1 1e6`;
    expect(await simulateNoiseProtocolV1({ apiVersion: '1', input }))
      .toEqual(await simulateNoiseProtocolV1({ apiVersion: '1', input: { format: 'spice', source: text } }));
  });
  it('rejects two noise directives', async () => {
    await expect(simulateNoiseProtocolV1({ apiVersion: '1', input: { format: 'spice-ts', document: native({ ...document, noiseAnalyses: [noise, noise] }) } }))
      .rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', message: 'Expected exactly one .noise analysis' } });
  });
});
