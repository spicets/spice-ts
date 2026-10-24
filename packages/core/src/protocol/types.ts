export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface OperatingPointAnalysisV1 { type: 'op' }
export interface DcAnalysisV1 { type: 'dc'; source: string; start: number; stop: number; step: number }
export interface TransientAnalysisV1 { type: 'tran'; timestep: number; stopTime: number; startTime?: number; maxTimestep?: number }
export interface AcAnalysisV1 { type: 'ac'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number }
export type AnalysisV1 = OperatingPointAnalysisV1 | DcAnalysisV1 | TransientAnalysisV1 | AcAnalysisV1;
export type { PoleZeroAnalysisV1 } from './wire/types.js';

export interface CircuitPortV1 { name: string; net: string }
export interface CircuitComponentV1 {
  type: string;
  id: string;
  name: string;
  ports: CircuitPortV1[];
  params: JsonObject;
  model?: string;
  subcircuit?: string;
}
export interface CircuitModelV1 { name: string; type: string; params: JsonObject }
export interface SubcircuitV1 {
  name: string;
  ports: string[];
  components: CircuitComponentV1[];
  models?: CircuitModelV1[];
}
export interface SpiceTsCircuitDocumentV1 {
  format: 'spice-ts';
  schemaVersion: '1.0';
  circuit: { components: CircuitComponentV1[]; nets: string[] };
  analyses: AnalysisV1[];
  poleZeroAnalyses?: import('./wire/types.js').PoleZeroAnalysisV1[];
  models: CircuitModelV1[];
  subcircuits: SubcircuitV1[];
}

export type SimulationInputV1 =
  | { format: 'spice'; source: string; virtualFiles?: Record<string, string> }
  | { format: 'spice-ts'; document: SpiceTsCircuitDocumentV1 }
  | { format: 'circuit-json'; circuit: JsonValue[]; analyses: AnalysisV1[]; poleZeroAnalyses?: import('./wire/types.js').PoleZeroAnalysisV1[] };

export interface ResourceLimitsV1 {
  maxSourceBytes?: number;
  maxVirtualFiles?: number;
  maxIncludeDepth?: number;
  maxComponents?: number;
  maxSubcircuitDepth?: number;
  maxAnalyses?: number;
  maxResultPoints?: number;
  maxSerializedResultBytes?: number;
  maxWallTimeMs?: number;
}
export interface SimulationOptionsV1 {
  backend?: 'spice-ts-js' | 'spice-ts-wasm' | 'ngspice-wasm';
  determinism?: 'strict' | 'relaxed';
  limits?: ResourceLimitsV1;
  abstol?: number;
  vntol?: number;
  reltol?: number;
  maxIterations?: number;
  maxTransientIterations?: number;
  maxTimestep?: number;
  integrationMethod?: 'euler' | 'trapezoidal' | 'gear2';
  trtol?: number;
  gmin?: number;
}
export interface SimulationRequestV1 { apiVersion: '1'; input: SimulationInputV1; options?: SimulationOptionsV1 }

export interface StepCoordinateV1 { index: number; parameter: string; value: number }
export interface OperatingPointResultV1 {
  type: 'op'; analysisIndex: number; step?: StepCoordinateV1;
  voltagesV: Record<string, number>; currentsA: Record<string, number>;
}
export interface DcResultV1 {
  type: 'dc'; analysisIndex: number; step?: StepCoordinateV1;
  axis: { name: string; unit: 'V' | 'A'; values: number[] };
  voltagesV: Record<string, number[]>; currentsA: Record<string, number[]>;
}
export interface TransientResultV1 {
  type: 'tran'; analysisIndex: number; step?: StepCoordinateV1;
  timeS: number[]; voltagesV: Record<string, number[]>; currentsA: Record<string, number[]>;
}
export interface ComplexPolarV1 { magnitude: number; phaseDegrees: number }
export interface AcResultV1 {
  type: 'ac'; analysisIndex: number; step?: StepCoordinateV1;
  frequencyHz: number[];
  voltagePhasors: Record<string, ComplexPolarV1[]>;
  currentPhasors: Record<string, ComplexPolarV1[]>;
}
export type AnalysisResultV1 = OperatingPointResultV1 | DcResultV1 | TransientResultV1 | AcResultV1;
export interface SimulationResultV1 { status: 'complete'; analyses: AnalysisResultV1[] }

export type ProtocolCompletionV1 = 'complete' | 'failed' | 'limited' | 'cancelled';
export type ProtocolLimitNameV1 = keyof ResourceLimitsV1;
export interface ProtocolCapabilityAnalysisV1 {
  id: `analysis:${AnalysisV1['type']}`;
  type: AnalysisV1['type'];
}
export interface ProtocolCapabilityInputV1 {
  id: 'input:spice' | 'input:spice-ts';
  format: 'spice' | 'spice-ts';
}
export interface ProtocolCapabilityLimitV1 {
  id: `limit:${ProtocolLimitNameV1}`;
  name: ProtocolLimitNameV1;
  unit: 'bytes' | 'count' | 'depth' | 'milliseconds';
}
export interface ProtocolCapabilitiesV1 {
  apiVersion: '1';
  kind: 'capabilities';
  capabilityId: 'protocol-v1';
  analyses: ProtocolCapabilityAnalysisV1[];
  inputFormats: ProtocolCapabilityInputV1[];
  limits: ProtocolCapabilityLimitV1[];
  completions: ProtocolCompletionV1[];
}
export interface ProtocolExecutionMetadataV1 {
  protocolVersion: '1';
  executionId: `execution:${string}`;
  inputId: `input:${string}`;
  resultId?: `result:${string}`;
  completion: ProtocolCompletionV1;
  partial: boolean;
  timing: { startedAtMs: number; finishedAtMs: number; durationMs: number };
  counts: { requestedAnalyses: number; completedAnalyses: number; resultPoints: number };
}
export interface PartialSimulationResultV1 { status: 'partial'; analyses: AnalysisResultV1[] }
export interface ProtocolSuccessEnvelopeV1 {
  apiVersion: '1'; kind: 'terminal'; ok: true; requestId: string;
  data: SimulationResultV1; metadata: ProtocolExecutionMetadataV1 & { completion: 'complete'; partial: false; resultId: `result:${string}` };
}
export interface ProtocolFailureEnvelopeV1 {
  apiVersion: '1'; kind: 'terminal'; ok: false; requestId: string;
  error: SpiceApiErrorV1; partial: PartialSimulationResultV1;
  metadata: ProtocolExecutionMetadataV1 & { completion: Exclude<ProtocolCompletionV1, 'complete'> };
}
export type ProtocolTerminalEnvelopeV1 = ProtocolSuccessEnvelopeV1 | ProtocolFailureEnvelopeV1;

export type SpiceApiErrorCodeV1 =
  | 'INVALID_REQUEST' | 'PARSE_ERROR' | 'INVALID_CIRCUIT' | 'UNSUPPORTED_FEATURE'
  | 'SINGULAR_MATRIX' | 'CONVERGENCE_FAILED' | 'TIMESTEP_TOO_SMALL' | 'RESOURCE_LIMIT'
  | 'CANCELLED' | 'BACKEND_UNAVAILABLE' | 'INTERNAL_ERROR';
export interface SpiceApiErrorV1 {
  code: SpiceApiErrorCodeV1;
  message: string;
  retryable: boolean;
  phase: 'validation' | 'parse' | 'compile' | 'solve' | 'serialize' | 'transport';
  details: JsonObject;
}
