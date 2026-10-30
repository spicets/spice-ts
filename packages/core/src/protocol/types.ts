export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface OperatingPointAnalysisV1 { type: 'op' }
export interface DcAnalysisV1 { type: 'dc'; source: string; start: number; stop: number; step: number; secondary?: { source: string; start: number; stop: number; step: number }; measurements?: DcMeasurementV1[] }
export interface FourierAnalysisV1 { fundamentalHz: number; outputs: string[]; harmonics?: number }
export interface FourierResultV1 {
  vector: string; fundamental: number | null; gridSize: number; degree: number; periods: number; thd: number | null;
  harmonics: { harmonic: number; frequency: number | null; magnitude: number | null; phase: number | null; normalizedMagnitude: number | null; normalizedPhase: number | null }[];
}
export interface MeasurementCrossingV1 { vector: string; value: number; rise?: number | 'last'; fall?: number | 'last'; cross?: number | 'last'; td?: number }
export type TransientMeasurementV1 =
  | { name: string; kind: 'trig'; trig: MeasurementCrossingV1; targ: MeasurementCrossingV1 }
  | ({ name: string; kind: 'find'; vector: string } & ({ at: number; when?: never } | { when: MeasurementCrossingV1; at?: never }))
  | { name: string; kind: 'avg' | 'min' | 'max' | 'pp' | 'rms' | 'integ'; vector: string; from?: number; to?: number };
export type AcMeasurementV1 =
  | { name: string; kind: 'find'; vector: string; at: number }
  | { name: string; kind: 'avg' | 'min' | 'max' | 'pp' | 'rms' | 'integ'; vector: string; from?: number; to?: number };
export type DcMeasurementV1 = Exclude<TransientMeasurementV1, { kind: 'trig' }>;
export type DcMeasurementResultV1 = TransientMeasurementResultV1;
export type TransientMeasurementResultV1 = { name: string; value: number; unit?: string } | { name: string; diagnostic: { code: 'MEASUREMENT_FAILED'; message: string } };
export interface TransientAnalysisV1 { type: 'tran'; timestep: number; stopTime: number; startTime?: number; maxTimestep?: number; uic?: true; fourier?: FourierAnalysisV1; measurements?: TransientMeasurementV1[] }
export interface AcAnalysisV1 { type: 'ac'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number; measurements?: AcMeasurementV1[] }
export type AnalysisV1 = OperatingPointAnalysisV1 | DcAnalysisV1 | TransientAnalysisV1 | AcAnalysisV1;
export type { PoleZeroAnalysisV1 } from './wire/types.js';

export interface SParameterAnalysisV1 { type: 'sp'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number }
/** Bounded DEC distortion sweep; F2 is fixed at startFreq * f2OverF1. */
export interface DistoAnalysisV1 { type: 'disto'; variation: 'dec'; points: number; startFreq: number; stopFreq: number; f2OverF1?: number }
/** Independent-source params.distortionF1 / distortionF2 (DISTOF1 / DISTOF2). */
export interface DistortionExcitationV1 { magnitude: number; phase?: number }
/** DC or AC sensitivity; outputNode names a voltage source for current output. Defaults to voltage. */
export type SensitivityAnalysisV1 = {
  type: 'sens'; outputNode: string; outputReferenceNode?: string; outputType?: 'voltage' | 'current';
} & ({ mode: 'dc' } | { mode: 'ac'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number });
export type { TfAnalysisV1, TfResultV1 } from './wire/types.js';
export type NativeAnalysisV1 = AnalysisV1 | SParameterAnalysisV1 | DistoAnalysisV1 | SensitivityAnalysisV1 | import('./wire/types.js').TfAnalysisV1;

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
  globalNodes?: string[];
  /** One OP-only temperature list in degrees Celsius. */
  temperatureSweep?: { values: number[] };
  /** One OP-only component value list. */
  componentSweep?: { component: string; values: number[] };
  initialConditions?: Record<string, number>;
  nodesets?: Record<string, number>;
  circuit: { components: CircuitComponentV1[]; nets: string[] };
  analyses: NativeAnalysisV1[];
  poleZeroAnalyses?: import('./wire/types.js').PoleZeroAnalysisV1[];
  noiseAnalyses?: import('./wire/types.js').NoiseAnalysisV1[];
  models: CircuitModelV1[];
  subcircuits: SubcircuitV1[];
}

export type SimulationInputV1 =
  | { format: 'spice'; source: string; virtualFiles?: Record<string, string> }
  | { format: 'spice-ts'; document: SpiceTsCircuitDocumentV1 }
  | { format: 'circuit-json'; circuit: JsonValue[]; analyses: AnalysisV1[]; poleZeroAnalyses?: import('./wire/types.js').PoleZeroAnalysisV1[]; noiseAnalyses?: import('./wire/types.js').NoiseAnalysisV1[] };

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
  /** Circuit and model nominal temperatures in degrees Celsius. */
  temperature?: number;
  nominalTemperature?: number;
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
export interface SimulationRequestV1 { apiVersion: '1'; input: SimulationInputV1; options?: SimulationOptionsV1; outputs?: string[] }

export interface StepCoordinateV1 { index: number; parameter: string; value: number }
export interface OperatingPointResultV1 {
  type: 'op'; analysisIndex: number; step?: StepCoordinateV1;
  voltagesV: Record<string, number>; currentsA: Record<string, number>;
}
export interface DcResultV1 {
  type: 'dc'; analysisIndex: number; step?: StepCoordinateV1;
  axis: { name: string; unit: 'V' | 'A'; values: number[] };
  /** Point-aligned outer sweep coordinates for nested DC sweeps. */
  secondaryAxis?: { name: string; unit: 'V' | 'A'; values: number[] };
  measurements?: DcMeasurementResultV1[];
  voltagesV: Record<string, number[]>; currentsA: Record<string, number[]>;
}
export interface TransientResultV1 {
  type: 'tran'; analysisIndex: number; step?: StepCoordinateV1;
  timeS: number[]; voltagesV: Record<string, number[]>; currentsA: Record<string, number[]>;
  fourier?: FourierResultV1[];
  measurements?: TransientMeasurementResultV1[];
}
export interface ComplexPolarV1 { magnitude: number; phaseDegrees: number }
export interface AcResultV1 {
  type: 'ac'; analysisIndex: number; step?: StepCoordinateV1;
  frequencyHz: number[];
  measurements?: TransientMeasurementResultV1[];
  voltagePhasors: Record<string, ComplexPolarV1[]>;
  currentPhasors: Record<string, ComplexPolarV1[]>;
}
export type AnalysisResultV1 = OperatingPointResultV1 | DcResultV1 | TransientResultV1 | AcResultV1 | import('./wire/types.js').TfResultV1;
export interface SimulationResultV1 { status: 'complete'; analyses: AnalysisResultV1[] }

export type ProtocolCompletionV1 = 'complete' | 'failed' | 'limited' | 'cancelled';
export type ProtocolLimitNameV1 = keyof ResourceLimitsV1;
export interface ProtocolCapabilityAnalysisV1 {
  id: `analysis:${AnalysisV1['type'] | 'tf'}`;
  type: AnalysisV1['type'] | 'tf';
  features?: ('measurements:tran' | 'measurements:dc' | 'measurements:ac')[];
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
  | 'INVALID_REQUEST' | 'INVALID_INPUT' | 'PARSE_ERROR' | 'INVALID_CIRCUIT' | 'UNSUPPORTED_FEATURE'
  | 'SINGULAR_MATRIX' | 'CONVERGENCE_FAILED' | 'TIMESTEP_TOO_SMALL' | 'RESOURCE_LIMIT'
  | 'CANCELLED' | 'BACKEND_UNAVAILABLE' | 'INTERNAL_ERROR';
export interface SpiceApiErrorV1 {
  code: SpiceApiErrorCodeV1;
  message: string;
  retryable: boolean;
  phase: 'validation' | 'parse' | 'compile' | 'solve' | 'serialize' | 'transport';
  details: JsonObject;
}
