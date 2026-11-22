import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { protocolSchemasV1, type SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const request = { apiVersion: '1' as const, input: { format: 'spice-ts' as const, document: {
  format: 'spice-ts' as const, schemaVersion: '1.0' as const,
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'ac', dc: 0, magnitude: 1 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
  ] }, analyses: [], models: [], subcircuits: [],
  noiseAnalyses: [{ type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 1, startFreq: 1, stopFreq: 10 }],
} } } as SimulationRequestV1;
const noiseResult = { status: 'complete', analyses: [{
  type: 'noise', analysisIndex: 0, frequencyHz: [1, 10], outputNoiseDensity: [1, 1], inputNoiseDensity: [1, 1],
  outputNoiseDensityUnit: 'V/sqrt(Hz)', inputNoiseDensityUnit: 'V/sqrt(Hz)',
  integratedOutputNoiseUnit: 'V', integratedInputNoiseUnit: 'V',
}] };

describe('noise at the streaming boundary', () => {
  it('returns a structured failure for a native noise request through the real worker', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-js' });
    try {
      const batch = await engine.simulate(request, { requestId: 'real-batch' });
      expect(batch).toMatchObject({ ok: true, data: { analyses: [{ type: 'noise' }] } });
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
      const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/success-envelope.schema.json')!;
      expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
      const reads = [];
      for await (const read of engine.simulateStream(request, { requestId: 'native-stream' })) reads.push(read);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ status: 'failed', events: [], terminal: { ok: false, error: {
        code: 'UNSUPPORTED_FEATURE', retryable: false,
      } } });
    } finally {
      await engine.close();
    }
  });

  // Exercise the post-batch guard independently of worker request validation.
  it('preserves batch results but rejects streaming noise as a structured failure', async () => {
    let reply!: (event: MessageEvent) => void;
    const engine = await createSpiceEngine({ backend: 'spice-ts-js', workerFactory: () => ({
      postMessage(message: unknown) {
        reply({ data: { id: (message as { id: number }).id, ok: true, data: noiseResult } } as MessageEvent);
      },
      onMessage(listener) { reply = listener; return () => {}; },
      onError: () => () => {},
      terminate: () => {},
    }) });
    try {
      const batch = await engine.simulate(request, { requestId: 'batch' });
      expect(batch).toMatchObject({ ok: true, data: noiseResult });
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
      const validate = ajv.getSchema('https://spice-ts.dev/schemas/v1/success-envelope.schema.json')!;
      expect(validate(batch), JSON.stringify(validate.errors)).toBe(true);
      const reads = [];
      for await (const read of engine.simulateStream(request, { requestId: 'stream' })) reads.push(read);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ status: 'failed', events: [], terminal: { ok: false, error: {
        code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
      } } });
    } finally {
      await engine.close();
    }
  });
});
