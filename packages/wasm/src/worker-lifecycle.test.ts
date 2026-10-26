import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createSpiceEngine, type WorkerLike } from './index.js';

// Use real module workers: terminate() only requests shutdown; its promise
// resolves once the thread and its MessagePort have actually been released.
describe('module worker shutdown', () => {
  it.each([false, true])('reports failed shutdown (factory pending: %s)', async factoryPending => {
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>(resolve => { releaseFactory = resolve; });
    let reply!: (event: MessageEvent) => void;
    const engine = await createSpiceEngine({
      backend: 'spice-ts-wasm',
      workerFactory: async () => {
        if (factoryPending) await factoryGate;
        return {
          postMessage(message: unknown) {
            reply({ data: { id: (message as { id: number }).id, ok: false, error: {
              code: 'CANCELLED', message: 'cancelled', retryable: true, phase: 'solve', details: {},
            } } } as MessageEvent);
          },
          onMessage(listener: (event: MessageEvent) => void) { reply = listener; return () => {}; },
          onError: () => () => {},
          terminate: () => Promise.reject(new Error('shutdown failed')),
        };
      },
    });
    const simulation = engine.simulate({
      apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 1\nR1 out 0 1k\n.op' },
    }, { requestId: 'failed-shutdown' });
    if (factoryPending) {
      const closing = expect(engine.close()).rejects.toThrow('terminated');
      // Attach before releasing the factory to catch unexpected rejections.
      const response = expect(simulation).resolves.toMatchObject({ ok: false, error: { code: 'BACKEND_UNAVAILABLE' } });
      releaseFactory();
      await Promise.all([closing, response]);
    } else {
      await expect(simulation).resolves.toMatchObject({ ok: false, error: { code: 'BACKEND_UNAVAILABLE' } });
      await expect(engine.close()).rejects.toThrow('terminated');
    }
    await expect(engine.close()).rejects.toThrow('terminated');
  });
  it.each([false, true])('close waits for cancellation shutdown (factory pending: %s)', async factoryPending => {
    let releaseFactory!: () => void;
    let releaseTermination!: (code: number) => void;
    let notifyTermination!: () => void;
    const factoryGate = new Promise<void>(resolve => { releaseFactory = resolve; });
    const terminated = new Promise<number>(resolve => { releaseTermination = resolve; });
    const terminationStarted = new Promise<void>(resolve => { notifyTermination = resolve; });
    const engine = await createSpiceEngine({
      backend: 'spice-ts-wasm',
      workerFactory: async () => {
        if (factoryPending) await factoryGate;
        return {
          postMessage() {},
          onMessage: () => () => {},
          onError: () => () => {},
          terminate() { notifyTermination(); return terminated; },
        };
      },
    });
    const simulation = engine.simulate({
      apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 1\nR1 out 0 1k\n.op' },
    }, { requestId: 'cancel-shutdown' });
    // Let an immediately available factory finish before closing its request.
    await Promise.resolve();
    let closed = false;
    const closing = engine.close().then(() => { closed = true; });
    releaseFactory();
    try {
      await terminationStarted;
      expect(closed).toBe(false);
    } finally {
      releaseTermination(0);
      await closing;
    }
    expect(await simulation).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(closed).toBe(true);
  });
  it.each(['spice-ts-js', 'spice-ts-wasm'] as const)('%s close waits for completed request workers to exit', async backend => {
    const workers: Worker[] = [];
    const engine = await createSpiceEngine({
      backend,
      workerFactory(url): WorkerLike {
        const worker = new Worker(url);
        workers.push(worker);
        return {
          postMessage: message => worker.postMessage(message),
          onMessage(listener) {
            const handler = (data: unknown): void => listener({ data } as MessageEvent);
            worker.on('message', handler);
            return () => { worker.off('message', handler); };
          },
          onError(listener) {
            const handler = (error: Error): void => listener({ message: error.message } as ErrorEvent);
            worker.on('error', handler);
            return () => { worker.off('error', handler); };
          },
          terminate: () => worker.terminate(),
        };
      },
    });
    try {
      const result = await engine.simulate({
        apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 1\nR1 out 0 1k\n.op' },
      }, { requestId: 'shutdown' });
      expect(result.ok).toBe(true);
      await engine.close();
      expect(workers).toHaveLength(1);
      expect(workers.map(worker => worker.threadId)).toEqual([-1]);
    } finally {
      await engine.close();
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  });
});
