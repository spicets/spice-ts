import { mapProtocolErrorV1, simulateProtocolV1 } from './adapter.js';
import { CanonicalJsonError, sha256CanonicalJson } from './canonical-json.js';
import type { ProtocolExecutionOptionsV1 } from './execution-guard.js';
import type {
  AnalysisResultV1,
  ProtocolCapabilitiesV1,
  ProtocolCompletionV1,
  ProtocolExecutionMetadataV1,
  ProtocolTerminalEnvelopeV1,
  SimulationRequestV1,
} from './types.js';

export interface ProtocolEnvelopeExecutionOptionsV1 extends ProtocolExecutionOptionsV1 {
  /** Caller correlation id. Defaults to a deterministic id derived from the request. */
  requestId?: string;
}

const CAPABILITIES: ProtocolCapabilitiesV1 = {
  apiVersion: '1',
  kind: 'capabilities',
  capabilityId: 'protocol-v1',
  analyses: [
    { id: 'analysis:op', type: 'op' },
    { id: 'analysis:dc', type: 'dc' },
    { id: 'analysis:tran', type: 'tran', features: ['measurements:tran'] },
    { id: 'analysis:ac', type: 'ac' },
    { id: 'analysis:tf', type: 'tf' },
  ],
  inputFormats: [
    { id: 'input:spice', format: 'spice' },
    { id: 'input:spice-ts', format: 'spice-ts' },
  ],
  limits: [
    { id: 'limit:maxSourceBytes', name: 'maxSourceBytes', unit: 'bytes' },
    { id: 'limit:maxVirtualFiles', name: 'maxVirtualFiles', unit: 'count' },
    { id: 'limit:maxIncludeDepth', name: 'maxIncludeDepth', unit: 'depth' },
    { id: 'limit:maxComponents', name: 'maxComponents', unit: 'count' },
    { id: 'limit:maxSubcircuitDepth', name: 'maxSubcircuitDepth', unit: 'depth' },
    { id: 'limit:maxAnalyses', name: 'maxAnalyses', unit: 'count' },
    { id: 'limit:maxResultPoints', name: 'maxResultPoints', unit: 'count' },
    { id: 'limit:maxSerializedResultBytes', name: 'maxSerializedResultBytes', unit: 'bytes' },
    { id: 'limit:maxWallTimeMs', name: 'maxWallTimeMs', unit: 'milliseconds' },
  ],
  completions: ['complete', 'failed', 'limited', 'cancelled'],
};

/** Return a fresh JSON-safe capability document with stable protocol ordering. */
export function protocolCapabilitiesV1(): ProtocolCapabilitiesV1 {
  return structuredClone(CAPABILITIES);
}

/** Execute a bounded request and always resolve to a terminal protocol envelope. */
export async function executeProtocolV1(
  request: SimulationRequestV1,
  options: ProtocolEnvelopeExecutionOptionsV1 = {},
): Promise<ProtocolTerminalEnvelopeV1> {
  const now = options.now ?? (() => performance.now());
  const startedAtMs = sampleTime(now);
  let inputHash = '';
  let requestId = options.requestId;
  const completed: AnalysisResultV1[] = [];
  const execution: ProtocolExecutionOptionsV1 = {
    signal: options.signal,
    now,
    onSafePoint: options.onSafePoint,
    onAnalysisComplete: analysis => {
      completed.push(analysis);
      options.onAnalysisComplete?.(analysis);
    },
  };

  try {
    inputHash = sha256CanonicalJson(request);
    requestId ??= `request:${inputHash}`;
    const result = normalizeNegativeZero(await simulateProtocolV1(request, execution));
    const resultHash = sha256CanonicalJson(result);
    const metadata = metadataFor(
      inputHash, startedAtMs, now, 'complete', false,
      safeRequestedAnalysisCount(request), result.analyses, resultHash,
    );
    return {
      apiVersion: '1', kind: 'terminal', ok: true, requestId,
      data: result, metadata,
    } as ProtocolTerminalEnvelopeV1;
  } catch (cause) {
    if (!inputHash) inputHash = invalidInputHash(cause);
    requestId ??= `request:${inputHash}`;
    const error = protocolError(cause);
    const completion: Exclude<ProtocolCompletionV1, 'complete'> = error.code === 'CANCELLED'
      ? 'cancelled'
      : error.code === 'RESOURCE_LIMIT' ? 'limited' : 'failed';
    const partialAnalyses = normalizeNegativeZero(completed);
    const metadata = metadataFor(
      inputHash, startedAtMs, now, completion, partialAnalyses.length > 0,
      safeRequestedAnalysisCount(request), partialAnalyses,
    );
    return {
      apiVersion: '1', kind: 'terminal', ok: false, requestId,
      error, partial: { status: 'partial', analyses: partialAnalyses }, metadata,
    } as ProtocolTerminalEnvelopeV1;
  }
}

function protocolError(cause: unknown): ReturnType<typeof mapProtocolErrorV1> {
  if (cause instanceof CanonicalJsonError) {
    return {
      code: 'INVALID_REQUEST',
      message: 'Request is not canonical JSON',
      retryable: false,
      phase: 'validation',
      details: { reason: cause.code, path: cause.path || '/' },
    };
  }
  return mapProtocolErrorV1(cause);
}

function invalidInputHash(cause: unknown): string {
  const marker = cause instanceof CanonicalJsonError
    ? { code: cause.code, path: cause.path || '/' }
    : { code: 'INVALID_REQUEST', path: '/' };
  return sha256CanonicalJson({ invalidRequest: marker });
}

function metadataFor(
  inputHash: string,
  startedAtMs: number,
  now: () => number,
  completion: ProtocolCompletionV1,
  partial: boolean,
  requestedAnalyses: number,
  analyses: AnalysisResultV1[],
  resultHash?: string,
): ProtocolExecutionMetadataV1 {
  const finishedAtMs = sampleTime(now);
  return {
    protocolVersion: '1',
    executionId: `execution:${inputHash}`,
    inputId: `input:${inputHash}`,
    ...(resultHash ? { resultId: `result:${resultHash}` as const } : {}),
    completion,
    partial,
    timing: {
      startedAtMs,
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    },
    counts: {
      requestedAnalyses,
      completedAnalyses: new Set(analyses.map(analysis => analysis.analysisIndex)).size,
      resultPoints: pointCount(analyses),
    },
  };
}

function requestedAnalysisCount(request: SimulationRequestV1): number {
  if (request.input.format === 'spice-ts') return request.input.document.analyses.length;
  if (request.input.format === 'circuit-json') return request.input.analyses.length;
  return Array.from(request.input.source.matchAll(/^\s*\.(?:op|dc|tran|ac|noise|tf|sens)\b/gim)).length;
}

function safeRequestedAnalysisCount(request: SimulationRequestV1): number {
  try {
    return requestedAnalysisCount(request);
  } catch {
    return 0;
  }
}

function pointCount(analyses: AnalysisResultV1[]): number {
  return analyses.reduce((total, analysis) => {
    switch (analysis.type) {
      case 'op':
      case 'tf': return total + 1;
      case 'dc': return total + analysis.axis.values.length;
      case 'tran': return total + analysis.timeS.length;
      case 'ac': return total + analysis.frequencyHz.length;
    }
  }, 0);
}

function sampleTime(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : 0;
  } catch {
    return 0;
  }
}

function normalizeNegativeZero<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeNegativeZero) as T;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, entry]) => [key, normalizeNegativeZero(entry)]);
    return Object.fromEntries(entries) as T;
  }
  return (Object.is(value, -0) ? 0 : value) as T;
}
