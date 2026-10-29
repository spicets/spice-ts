import type { AnalysisResultV1, ResourceLimitsV1, SpiceApiErrorV1 } from './types.js';

/**
 * Stable cooperative boundaries for bounded protocol execution.
 *
 * Parsing checks once per preprocessed and parsed line; compilation checks once
 * per instantiated device; Newton checks before each iteration; transient and
 * AC check before each output point; native Fourier checks before each operand's
 * allocation/transform; serialization checks after each analysis.
 */
export type ProtocolSafePointV1 =
  | 'parse:line'
  | 'compile:device'
  | 'solve:newton-iteration'
  | 'solve:transient-step'
  | 'solve:ac-point'
  | 'solve:fourier-output'
  | 'serialize:analysis';

export interface ProtocolAbortSignalV1 {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface ProtocolExecutionOptionsV1 {
  signal?: ProtocolAbortSignalV1;
  /** Monotonic clock override for deterministic hosts and tests. */
  now?: () => number;
  /** Observability hook invoked immediately before each cooperative check. */
  onSafePoint?: (safePoint: ProtocolSafePointV1) => void;
  /** Receives each fully serialized analysis before the following cooperative check. */
  onAnalysisComplete?: (analysis: AnalysisResultV1) => void;
}

export class ProtocolExecutionError extends Error {
  constructor(readonly apiError: SpiceApiErrorV1) {
    super(apiError.message);
    this.name = 'ProtocolExecutionError';
  }
}

/** Shared synchronous guard used by protocol parsing, compilation, solving, and serialization. */
export class ProtocolExecutionGuard {
  private readonly startedAt: number;
  private readonly now: () => number;
  private resultPoints = 0;

  constructor(
    readonly limits: Readonly<ResourceLimitsV1>,
    private readonly execution: Readonly<ProtocolExecutionOptionsV1> = {},
  ) {
    this.now = execution.now ?? (() => performance.now());
    this.startedAt = this.now();
  }

  checkpoint(safePoint: ProtocolSafePointV1): void {
    this.execution.onSafePoint?.(safePoint);
    if (this.execution.signal?.aborted) {
      throw new ProtocolExecutionError({
        code: 'CANCELLED',
        message: 'The protocol request was cancelled',
        retryable: false,
        phase: phaseOf(safePoint),
        details: { safePoint },
      });
    }

    const configured = this.limits.maxWallTimeMs;
    if (configured !== undefined) {
      const observed = this.now() - this.startedAt;
      if (observed > configured) {
        throw resourceError('maxWallTimeMs', configured, observed, phaseOf(safePoint), safePoint);
      }
    }
  }

  maximum(
    limit: keyof ResourceLimitsV1,
    observed: number,
    phase: SpiceApiErrorV1['phase'],
  ): void {
    const configured = this.limits[limit];
    if (configured !== undefined && observed > configured) {
      throw resourceError(limit, configured, observed, phase);
    }
  }

  recordResultPoint(): void {
    this.resultPoints++;
    this.maximum('maxResultPoints', this.resultPoints, 'solve');
  }
}

function phaseOf(safePoint: ProtocolSafePointV1): SpiceApiErrorV1['phase'] {
  if (safePoint.startsWith('parse:')) return 'parse';
  if (safePoint.startsWith('compile:')) return 'compile';
  if (safePoint.startsWith('serialize:')) return 'serialize';
  return 'solve';
}

function resourceError(
  limit: keyof ResourceLimitsV1,
  configured: number,
  observed: number,
  phase: SpiceApiErrorV1['phase'],
  safePoint?: ProtocolSafePointV1,
): ProtocolExecutionError {
  return new ProtocolExecutionError({
    code: 'RESOURCE_LIMIT',
    message: 'A configured protocol resource limit was exceeded',
    retryable: false,
    phase,
    details: { limit, configured, observed, ...(safePoint ? { safePoint } : {}) },
  });
}
