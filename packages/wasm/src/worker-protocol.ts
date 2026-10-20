import type { SimulationRequestV1 } from '@spice-ts/core/protocol';

export type WorkerOperation = 'validate' | 'simulate';

export interface WorkerRequest {
  id: number;
  operation: WorkerOperation;
  backend: 'spice-ts-js' | 'spice-ts-wasm';
  request: SimulationRequestV1;
  wasmBytes?: Uint8Array;
  maxPoints?: number;
}

export interface WorkerSuccess {
  id: number;
  ok: true;
  data: unknown;
}

export interface WorkerFailure {
  id: number;
  ok: false;
  error: unknown;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;
