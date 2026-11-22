import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { protocolSchemasV1 } from './wire/schemas.js';
import { sha256CanonicalJson } from './canonical-json.js';
import { describe, expect, it } from 'vitest';
import { executeProtocolV1 } from './envelopes.js';
import { simulateNoiseProtocolV1 } from './adapter.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const noise = { type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 10, startFreq: 1, stopFreq: 1e6 } as const;
const component = (type: string, name: string, p: string, n: string, params: Record<string, string | number>) => ({ type, id: name, name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params });
const request = (filter: boolean): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice-ts', document: {
  format: 'spice-ts', schemaVersion: '1.0', circuit: { nets: ['in', 'out'], components: [
    component('V', 'V1', 'in', '0', { waveform: 'ac', dc: 0, magnitude: 1 }),
    component('R', 'R1', 'in', 'out', { resistance: 1000 }),
    ...(filter ? [component('C', 'C1', 'out', '0', { capacitance: 1e-9 })] : []),
  ] }, analyses: [], models: [], subcircuits: [], noiseAnalyses: [noise],
} as SpiceTsCircuitDocumentV1 } });

describe('native batch noise result', () => {
  it.each([false, true])('returns the exact core spectrum for filter=%s', async filter => {
    const input = request(filter);
    const direct = await simulateNoiseProtocolV1(input);
    const text = `V1 in 0 AC 1\nR1 in out 1k\n${filter ? 'C1 out 0 1n\n' : ''}.noise V(out) V1 dec 10 1 1e6`;
    expect(await simulateNoiseProtocolV1({ apiVersion: '1', input: { format: 'spice', source: text } })).toEqual(direct);
    const terminal = await executeProtocolV1(input);
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) throw new Error(terminal.error.message);
    expect(terminal.data.analyses[0]).toMatchObject({ type: 'noise', analysisIndex: 0,
      frequencyHz: direct.frequencies, outputNoiseDensity: direct.outputNoiseDensity,
      inputNoiseDensity: direct.inputNoiseDensity, integratedOutputNoise: direct.integratedOutputNoise,
      integratedInputNoise: direct.integratedInputNoise, outputNoiseDensityUnit: 'V/sqrt(Hz)', inputNoiseDensityUnit: 'V/sqrt(Hz)', integratedOutputNoiseUnit: 'V', integratedInputNoiseUnit: 'V' });
  });
  it('labels current-source input noise in amperes without changing values', async () => {
    const input = request(true);
    if (input.input.format !== 'spice-ts') throw new Error('expected native');
    input.input.document.circuit.components[0] = component('I', 'I1', 'in', '0', { waveform: 'ac', dc: 0, magnitude: 1 });
    input.input.document.circuit.components.push(component('R', 'R2', 'in', '0', { resistance: 1000 }));
    input.input.document.noiseAnalyses = [{ ...noise, inputSource: 'I1' }];
    const direct = await simulateNoiseProtocolV1(input);
    const result = await executeProtocolV1(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.analyses[0]).toMatchObject({ frequencyHz: direct.frequencies, inputNoiseDensity: direct.inputNoiseDensity,
      inputNoiseDensityUnit: 'A/sqrt(Hz)', integratedInputNoiseUnit: 'A' });
  });
  it('validates the generated result schema and repeats the canonical hash', async () => {
    const first = await executeProtocolV1(request(true));
    const second = await executeProtocolV1(request(true));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('noise failed');
    expect(first.data).toEqual(second.data);
    expect(sha256CanonicalJson(first.data)).toBe(sha256CanonicalJson(second.data));
    expect(first.metadata.resultId).toBe(second.metadata.resultId);
    const ajv = new Ajv2020({ strict: true });
    for (const name of Object.keys(protocolSchemasV1)) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../protocol/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', first.data)).toBe(true);
  });
  it.each(['maxResultPoints', 'maxSerializedResultBytes'] as const)('enforces %s', async limit => {
    const result = await executeProtocolV1({ ...request(true), options: { limits: { [limit]: 1 } } });
    expect(result).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit } } });
  });
  it.each(['inputSource', 'outputNode'] as const)('rejects an unknown %s', async field => {
    const input = request(true);
    if (input.input.format !== 'spice-ts') throw new Error('expected native');
    input.input.document.noiseAnalyses = [{ ...noise, [field]: 'missing' }];
    const result = await executeProtocolV1(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe('INTERNAL_ERROR');
  });
  it('rejects repeated and mixed analyses rather than dropping them', async () => {
    const input = request(true);
    if (input.input.format !== 'spice-ts') throw new Error('expected native');
    input.input.document.noiseAnalyses = [noise, noise];
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
    input.input.document.noiseAnalyses = [noise];
    input.input.document.analyses = [{ type: 'op' }];
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
  });
});
