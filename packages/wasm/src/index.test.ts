import { describe, expect, it } from 'vitest';
import positive from '../../core/protocol/fixtures/positive-v1.json';
import negative from '../../core/protocol/fixtures/negative-v1.json';
import { checkConformanceV1, sha256CanonicalJson, type SimulationEventV1, type SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine, SpiceEngineError, type SpiceEngine } from './index.js';

const request = positive.requests.spice as SimulationRequestV1;

async function withEngine(run: (engine: SpiceEngine) => Promise<void>): Promise<void> {
  const engine = await createSpiceEngine({ backend: 'spice-ts-js' });
  try {
    await run(engine);
  } finally {
    await engine.close();
  }
}

describe('protocol-v1 worker facade', () => {
  it('exposes deterministic capabilities without reserved or internal backends', async () => {
    await withEngine(async engine => {
      expect(engine.capabilities).toEqual({
        protocolVersions: ['1'],
        nativeSchemaVersions: ['1.0'],
        backends: ['spice-ts-js'],
        analyses: ['op', 'dc', 'tran', 'ac'],
        determinism: ['strict', 'relaxed'],
        streamChunkPoints: 256,
        engineBuildId: expect.stringMatching(/^spice-ts-js-[0-9a-f]{16}$/),
      });
    });
  });

  it('runs validation and simulation in a Node module worker', async () => {
    await withEngine(async engine => {
      const validation = await engine.validate(request, { requestId: 'validate-1' });
      expect(validation).toMatchObject({ apiVersion: '1', ok: true, requestId: 'validate-1', data: { status: 'valid', analysisCount: 1 } });

      const simulation = await engine.simulate(request, { requestId: 'simulate-1' });
      expect(simulation).toMatchObject({
        apiVersion: '1', ok: true, requestId: 'simulate-1',
        data: { status: 'complete', analyses: [{ type: 'op', analysisIndex: 0 }] },
        metadata: { backend: 'spice-ts-js', resolvedOptions: { backend: 'spice-ts-js' } },
      });
      if (simulation.ok) {
        expect(checkConformanceV1('simulation-result', simulation.data)).toEqual([]);
        expect(simulation.metadata.resultSha256).toBe(sha256CanonicalJson(simulation.data));
      }
    });
  });

  it('runs every shared positive input fixture with explicit unsupported handling', async () => {
    await withEngine(async engine => {
      for (const [name, fixture] of Object.entries(positive.requests)) {
        const fixtureRequest = fixture as SimulationRequestV1;
        const validation = await engine.validate(fixtureRequest, { requestId: `validate-${name}` });
        const simulation = await engine.simulate(fixtureRequest, { requestId: `simulate-${name}` });
        if (name === 'circuitJson') {
          expect(validation).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
          expect(simulation).toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
        } else {
          expect(validation).toMatchObject({ ok: true });
          expect(simulation).toMatchObject({ ok: true });
          if (simulation.ok) {
            expect(checkConformanceV1('simulation-result', simulation.data)).toEqual([]);
            const analysis = simulation.data.analyses[0];
            expect(analysis).toMatchObject({ type: 'op' });
            if (analysis?.type === 'op') {
              expect(analysis.voltagesV.in).toBeCloseTo(5, 12);
              expect(analysis.currentsA.V1).toBeCloseTo(-0.005, 12);
            }
          }
        }
      }
    });
  });

  it('rejects a worker checksum mismatch before constructing a worker', async () => {
    let workerConstructions = 0;
    await expect(createSpiceEngine({
      backend: 'spice-ts-js',
      manifest: {
        schemaVersion: 1,
        engineBuildId: 'spice-ts-js-0000000000000000',
        worker: { url: 'data:text/javascript,export%20{}', sha256: '0'.repeat(64) },
      },
      workerFactory: () => { workerConstructions++; throw new Error('must not execute'); },
    })).rejects.toMatchObject({ error: { code: 'BACKEND_UNAVAILABLE', phase: 'transport' } });
    expect(workerConstructions).toBe(0);
  });

  it('rejects the internal backend ID without executing JavaScript', async () => {
    let workerConstructions = 0;
    for (const backend of ['spice-ts'] as const) {
      try {
        await createSpiceEngine({
          backend: backend as 'spice-ts-js',
          workerFactory: () => { workerConstructions++; throw new Error('must not execute'); },
        });
        expect.fail('engine creation should fail');
      } catch (error) {
        expect(error).toBeInstanceOf(SpiceEngineError);
        expect(error).toMatchObject({ error: { code: 'BACKEND_UNAVAILABLE', retryable: false, phase: 'transport' } });
      }
    }
    expect(workerConstructions).toBe(0);
    expect(negative.internalBackend.options.backend).toBe('spice-ts');
  });

  it('rejects reserved and internal request backends before constructing a worker', async () => {
    let workerConstructions = 0;
    const engine = await createSpiceEngine({
      backend: 'spice-ts-js',
      workerFactory: () => { workerConstructions++; throw new Error('must not execute'); },
    });
    try {
      for (const backend of ['spice-ts-wasm', 'spice-ts'] as const) {
        const response = await engine.simulate({
          ...request,
          options: { backend: backend as 'spice-ts-js' },
        }, { requestId: `reject-${backend}` });
        expect(response).toMatchObject(backend === 'spice-ts-wasm' ? {
          ok: false,
          error: { code: 'BACKEND_UNAVAILABLE', retryable: false, phase: 'transport', details: { backend } },
          metadata: { backend: 'spice-ts-js' },
        } : {
          ok: false,
          error: { code: 'INVALID_REQUEST', retryable: false, phase: 'validation' },
        });
      }
      expect(workerConstructions).toBe(0);
    } finally {
      await engine.close();
    }
  });

  it('rejects every negative request fixture before constructing a worker', async () => {
    let workerConstructions = 0;
    const engine = await createSpiceEngine({
      backend: 'spice-ts-js',
      workerFactory: () => { workerConstructions++; throw new Error('must not execute'); },
    });
    try {
      for (const [name, fixture] of Object.entries({
        unsupportedVersion: negative.unsupportedVersion,
        invalidUnion: negative.invalidUnion,
        internalBackend: negative.internalBackend,
      })) {
        const response = await engine.simulate(fixture as unknown as SimulationRequestV1, { requestId: `negative-${name}` });
        expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation' } });
      }
      expect(workerConstructions).toBe(0);
    } finally {
      await engine.close();
    }
  });

  it('uses deterministic chunks and returns the exact partial cancellation hash', async () => {
    const transient: SimulationRequestV1 = {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1m' },
    };
    await withEngine(async engine => {
      const stream = engine.simulateStream(transient, { requestId: 'stream-1', chunkPoints: 4 });
      const first = await stream.next();
      expect(first.value).toMatchObject({ status: 'running', events: expect.any(Array), nextCursor: '4' });
      const emitted = first.value?.events ?? [];
      expect(emitted).toHaveLength(5);
      expect(checkConformanceV1('simulation-events', emitted)).toEqual([]);

      expect(await engine.cancel('stream-1')).toEqual({ requestId: 'stream-1', status: 'cancelling' });
      const cancelled = await stream.next();
      expect(cancelled.value).toMatchObject({
        status: 'cancelled', nextCursor: null,
        terminal: {
          apiVersion: '1', ok: false, requestId: 'stream-1',
          error: { code: 'CANCELLED', retryable: true },
          partial: { status: 'partial', analyses: [{ analysis: 'tran', analysisIndex: 0, emittedPointCount: 4, complete: false }] },
        },
      });
      const points = emitted.filter((event: SimulationEventV1) => event.type === 'point');
      expect(cancelled.value?.terminal && !cancelled.value.terminal.ok
        ? cancelled.value.terminal.partial.partialEventSha256 : '').toBe(sha256CanonicalJson(points));
      expect('resultSha256' in (cancelled.value?.terminal?.metadata ?? {})).toBe(false);
    });
  });

  it('registers cancellation before asynchronous worker construction completes', async () => {
    const longRequest: SimulationRequestV1 = {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1n 10m' },
    };
    await withEngine(async engine => {
      const pending = engine.simulate(longRequest, { requestId: 'cancel-before-worker' });
      expect(await engine.cancel('cancel-before-worker')).toEqual({
        requestId: 'cancel-before-worker', status: 'cancelling',
      });
      await expect(pending).resolves.toMatchObject({
        apiVersion: '1', ok: false, requestId: 'cancel-before-worker',
        error: { code: 'CANCELLED', retryable: true },
      });
    });
  });

  it('reserves a streaming request id through worker-to-chunk handoff', async () => {
    const transient: SimulationRequestV1 = {
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1m' },
    };
    await withEngine(async engine => {
      const stream = engine.simulateStream(transient, { requestId: 'exclusive-stream', chunkPoints: 4 });
      const firstChunk = stream.next();
      const duplicate = await engine.simulate(request, { requestId: 'exclusive-stream' });
      expect(duplicate).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect((await firstChunk).value).toMatchObject({ status: 'running', nextCursor: '4' });
      expect(await engine.cancel('exclusive-stream')).toMatchObject({ status: 'cancelling' });
      expect((await stream.next()).value).toMatchObject({ status: 'cancelled' });
    });
  });
});
