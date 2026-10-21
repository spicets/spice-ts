import { mapProtocolErrorV1, simulateProtocolV1, validateProtocolV1 } from '@spice-ts/core';
import {
  NumericBackendError,
  simulateLinearOpWasmV1,
  validateLinearOpWasmV1,
} from './numeric-wasm.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

type MessagePortLike = {
  postMessage(value: WorkerResponse): void;
  on?(event: 'message', listener: (value: WorkerRequest) => void): void;
};

async function execute(message: WorkerRequest): Promise<void> {
  try {
    const data = message.backend === 'spice-ts-wasm'
      ? message.operation === 'validate'
        ? validateLinearOpWasmV1(message.request)
        : await simulateLinearOpWasmV1(message.request, requiredWasmBytes(message), message.maxPoints)
      : message.operation === 'validate'
        ? await validateProtocolV1(message.request)
        : await simulateProtocolV1(message.request);
    post({ id: message.id, ok: true, data });
  } catch (error) {
    post({
      id: message.id,
      ok: false,
      error: error instanceof NumericBackendError ? error.error : mapProtocolErrorV1(error),
    });
  }
}

function requiredWasmBytes(message: WorkerRequest): Uint8Array {
  if (message.wasmBytes) return message.wasmBytes;
  throw new NumericBackendError({
    code: 'BACKEND_UNAVAILABLE',
    message: 'The verified numeric WebAssembly artifact was not provided',
    retryable: false,
    phase: 'transport',
    details: {},
  });
}

let parentPort: MessagePortLike | null = null;

function post(message: WorkerResponse): void {
  if (parentPort) parentPort.postMessage(message);
  else globalThis.postMessage(message);
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('message', (event: MessageEvent<WorkerRequest>) => { void execute(event.data); });
} else {
  const workerThreads = await import('node:worker_threads');
  parentPort = workerThreads.parentPort;
  parentPort?.on?.('message', (message: WorkerRequest) => { void execute(message); });
}
