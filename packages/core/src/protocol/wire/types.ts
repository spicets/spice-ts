export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProtocolVersionV1 = '1';
export type NativeSchemaVersionV1 = '1.0';
export type BackendV1 = 'spice-ts-js' | 'spice-ts-wasm' | 'ngspice-wasm';
export type DeterminismV1 = 'strict' | 'relaxed';
export type IntegrationMethodV1 = 'euler' | 'trapezoidal' | 'gear2';

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
  | ({ name: string; kind: 'find'; vector: string } & ({ at: number; when?: never } | { when: MeasurementCrossingV1; at?: never }))
  | { name: string; kind: 'avg' | 'min' | 'max' | 'pp' | 'rms' | 'integ'; vector: string; from?: number; to?: number };
export type DcMeasurementV1 = Exclude<TransientMeasurementV1, { kind: 'trig' }>;
export type DcMeasurementResultV1 = TransientMeasurementResultV1;
export type TransientMeasurementResultV1 = { name: string; value: number; unit?: string } | { name: string; diagnostic: { code: 'MEASUREMENT_FAILED'; message: string } };
export interface TransientAnalysisV1 { type: 'tran'; timestep: number; stopTime: number; startTime?: number; maxTimestep?: number; uic?: true; fourier?: FourierAnalysisV1; measurements?: TransientMeasurementV1[] }
export interface AcAnalysisV1 { type: 'ac'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number; measurements?: AcMeasurementV1[] }
export type AnalysisV1 = OperatingPointAnalysisV1 | DcAnalysisV1 | TransientAnalysisV1 | AcAnalysisV1;
/** Scalar pole-zero request, separate from the v1 result/stream union. */
export interface PoleZeroAnalysisV1 {
  type: 'pz';
  inputPositive: string;
  inputNegative: string;
  outputPositive: string;
  outputNegative: string;
  inputType: 'cur' | 'vol';
  mode: 'pol' | 'zer' | 'pz';
}

/** Scalar noise request, separate from the v1 result/stream union. */
export interface NoiseAnalysisV1 {
  type: 'noise';
  outputNode: string;
  outputReferenceNode?: string;
  inputSource: string;
  variation: 'dec' | 'oct' | 'lin';
  points: number;
  startFreq: number;
  stopFreq: number;
}
export interface SParameterAnalysisV1 { type: 'sp'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number }
/** Bounded DEC distortion sweep; F2 is fixed at startFreq * f2OverF1. */
export interface DistoAnalysisV1 { type: 'disto'; variation: 'dec'; points: number; startFreq: number; stopFreq: number; f2OverF1?: number }
/** Independent-source params.distortionF1 / distortionF2 (DISTOF1 / DISTOF2). */
export interface DistortionExcitationV1 { magnitude: number; phase?: number }
/** DC or AC sensitivity; outputNode names a voltage source for current output. Defaults to voltage. */
export type SensitivityAnalysisV1 = {
  type: 'sens'; outputNode: string; outputReferenceNode?: string; outputType?: 'voltage' | 'current';
} & ({ mode: 'dc' } | { mode: 'ac'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: number; stopFreq: number });
export interface TfAnalysisV1 { type: 'tf'; output: string; source: string }
export type NativeAnalysisV1 = AnalysisV1 | SParameterAnalysisV1 | DistoAnalysisV1 | SensitivityAnalysisV1 | TfAnalysisV1;

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
  poleZeroAnalyses?: PoleZeroAnalysisV1[];
  noiseAnalyses?: NoiseAnalysisV1[];
  models: CircuitModelV1[];
  subcircuits: SubcircuitV1[];
}

export type SimulationInputV1 =
  | { format: 'spice'; source: string; virtualFiles?: Record<string, string> }
  | { format: 'spice-ts'; document: SpiceTsCircuitDocumentV1 }
  | { format: 'circuit-json'; circuit: JsonValue[]; analyses: AnalysisV1[]; poleZeroAnalyses?: PoleZeroAnalysisV1[]; noiseAnalyses?: NoiseAnalysisV1[] };

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
  backend?: BackendV1;
  determinism?: DeterminismV1;
  limits?: ResourceLimitsV1;
  abstol?: number;
  vntol?: number;
  reltol?: number;
  maxIterations?: number;
  maxTransientIterations?: number;
  maxTimestep?: number;
  integrationMethod?: IntegrationMethodV1;
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
export interface TfResultV1 {
  type: 'tf'; analysisIndex: number; step?: StepCoordinateV1;
  transferFunction: number; inputResistanceOhm: number; outputResistanceOhm: number;
}
export type AnalysisResultV1 = OperatingPointResultV1 | DcResultV1 | TransientResultV1 | AcResultV1 | TfResultV1;
export interface SimulationResultV1 { status: 'complete'; analyses: AnalysisResultV1[] }

export interface DiagnosticSourceV1 { file: string; line: number; column?: number; excerpt?: string }
export interface RelatedDiagnosticV1 { path?: string; message: string }
export interface DiagnosticSuggestionV1 { action: string; replacement?: JsonValue }
export interface DiagnosticV1 {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
  source?: DiagnosticSourceV1;
  related?: RelatedDiagnosticV1[];
  suggestions?: DiagnosticSuggestionV1[];
}
export type SpiceApiErrorCodeV1 =
  | 'INVALID_REQUEST' | 'INVALID_INPUT' | 'PARSE_ERROR' | 'INVALID_CIRCUIT' | 'UNSUPPORTED_FEATURE' | 'UNSUPPORTED_ELEMENT'
  | 'SINGULAR_MATRIX' | 'CONVERGENCE_FAILED' | 'TIMESTEP_TOO_SMALL' | 'RESOURCE_LIMIT'
  | 'CANCELLED' | 'BACKEND_UNAVAILABLE' | 'INTERNAL_ERROR';
export interface SpiceApiErrorV1 {
  code: SpiceApiErrorCodeV1;
  message: string;
  retryable: boolean;
  phase: 'validation' | 'parse' | 'compile' | 'solve' | 'serialize' | 'transport';
  details: JsonObject;
}

export interface ResolvedOptionsV1 {
  temperature?: number;
  nominalTemperature?: number;
  backend: BackendV1;
  abstol: number;
  vntol: number;
  reltol: number;
  maxIterations: number;
  maxTransientIterations: number;
  maxTimestep: number;
  integrationMethod: IntegrationMethodV1;
  trtol: number;
  gmin: number;
  determinism: DeterminismV1;
  limits?: ResourceLimitsV1;
}
export interface RunMetadataV1 {
  protocolVersion: '1';
  nativeSchemaVersion?: '1.0';
  spiceTsVersion: string;
  engineBuildId: string;
  backend: BackendV1;
  backendVersion: string;
  resolvedOptions: ResolvedOptionsV1;
  inputSha256: string;
  resultSha256: string;
  runtime: { family: string; version: string };
  architecture: string;
  determinism: DeterminismV1;
}
export type PartialRunMetadataV1 = Partial<Omit<RunMetadataV1, 'resultSha256'>>;
export interface SuccessEnvelopeV1<T extends JsonValue | SimulationResultV1 = SimulationResultV1> {
  apiVersion: '1'; ok: true; requestId: string; data: T;
  diagnostics: DiagnosticV1[]; metadata: RunMetadataV1;
}
export interface FailureEnvelopeV1 {
  apiVersion: '1'; ok: false; requestId: string; error: SpiceApiErrorV1;
  diagnostics: DiagnosticV1[]; metadata?: PartialRunMetadataV1;
}

export type StreamPointV1 =
  | { type: 'dc'; axis: { name: string; unit: 'V' | 'A'; value: number }; voltagesV: Record<string, number>; currentsA: Record<string, number> }
  | { type: 'tran'; timeS: number; voltagesV: Record<string, number>; currentsA: Record<string, number> }
  | { type: 'ac'; frequencyHz: number; voltagePhasors: Record<string, ComplexPolarV1>; currentPhasors: Record<string, ComplexPolarV1> };
export type SimulationEventV1 =
  | { type: 'analysis-start'; analysis: 'op' | 'dc' | 'tran' | 'ac' | 'tf'; analysisIndex: number; step?: StepCoordinateV1 }
  | { type: 'point'; analysisIndex: number; step?: StepCoordinateV1; pointIndex: number; point: StreamPointV1 }
  | { type: 'analysis-end'; analysis: 'op' | 'dc' | 'tran' | 'ac' | 'tf'; analysisIndex: number; step?: StepCoordinateV1; pointCount: number }
  | { type: 'diagnostic'; diagnostic: DiagnosticV1 };
export interface PartialAnalysisV1 {
  analysis: 'dc' | 'tran' | 'ac'; analysisIndex: number; step?: StepCoordinateV1;
  emittedPointCount: number; complete: boolean;
}
export interface PartialSimulationResultV1 {
  status: 'partial'; analyses: PartialAnalysisV1[]; partialEventSha256: string;
}
export type StreamTerminalV1 =
  | SuccessEnvelopeV1<SimulationResultV1>
  | (FailureEnvelopeV1 & { partial: PartialSimulationResultV1 });
export type SimulationReadDataV1 =
  | { status: 'running'; events: SimulationEventV1[]; nextCursor: string }
  | { status: 'complete'; events: SimulationEventV1[]; nextCursor: null; terminal: SuccessEnvelopeV1<SimulationResultV1> }
  | { status: 'failed' | 'cancelled'; events: SimulationEventV1[]; nextCursor: null; terminal: FailureEnvelopeV1 & { partial: PartialSimulationResultV1 } };
