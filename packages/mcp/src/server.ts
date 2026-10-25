import { Circuit, circuitFromDocument, SpiceError, parseTitleless, mapProtocolErrorV1, simulateProtocolV1, validateProtocolV1 } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from '@spice-ts/circuit-json';
import type { CircuitJSON, ConversionDiagnosticV1 } from '@spice-ts/circuit-json';
import { commonSchemaV1, sha256CanonicalJson } from '@spice-ts/core/protocol';
import type {
  AnalysisResultV1,
  JsonObject,
  JsonValue,
  PartialAnalysisV1,
  RunMetadataV1,
  SimulationEventV1,
  SimulationReadDataV1 as ProtocolReadDataV1,
  SimulationRequestV1,
  SimulationResultV1,
  SpiceApiErrorV1 as ProtocolApiErrorV1,
  SuccessEnvelopeV1,
} from '@spice-ts/core/protocol';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { estimatedResultPoints, requestPlan, resolvedOptions } from './request-plan.js';
import type { RequestPlan } from './request-plan.js';
import { measurementListSchema, measureResult } from './measure.js';
import { dcMetricsInput, dcMetricsOutputSchema, dcMetricsProperties, dcMetricsResult } from './dc-metrics.js';
import { compareInputSchema, compareOutputSchema, compareSignals } from './compare.js';
import { overrideParameters, parameterOverrides, ParameterOverrideError, paramsSchema } from './params.js';
import type { ParameterOverrideApiError } from './params.js';
import { runSweep, sweepProperties } from './sweep.js';
import { runOptimize, optimizeProperties } from './optimize.js';
import { runCorners, cornersProperties } from './corners.js';
import { runMonteCarlo, monteCarloProperties } from './monte-carlo.js';
import { acMetrics, acMetricsArgs, acMetricsOutputSchema, acMetricsProperties } from './ac-metrics.js';
import { tranMetrics, tranMetricsArgs, tranMetricsOutputSchemas, tranMetricsProperties } from './tran-metrics.js';
import { powerMetrics, powerMetricsArgs, powerMetricsProperties, powerMetricsOutputSchema, powerMetricsErrorSchema, powerPlan } from './power-metrics.js';
import { fourierMetrics, fourierArgs, fourierOutputSchemas, fourierProperties } from './fourier.js';
import { noiseMetrics, noiseMetricsArgs, noiseMetricsOutputSchema, noiseMetricsProperties } from './noise-metrics.js';
import type { NoiseResult, PoleZeroResult } from '@spice-ts/core';
import { pzMetrics, pzMetricsOutputSchema } from './pz-metrics.js';
import { distoMetrics, distoOutput, distoMetricsOutputSchema, distoUnsupportedSchema, unsupportedDisto, validateDistoJsonInput } from './disto-metrics.js';
import type { DistoSpectrum } from './disto-metrics.js';
import type { OperatingPointReport } from '@spice-ts/core';
import type { SensitivityResult } from '@spice-ts/core';
import type { TransferFunctionResult } from '@spice-ts/core';
import { tfArgs, tfReport, tfInputSchema, tfOutputSchema } from './tf.js';
import { sparamsArgs, sparamsReport, sparamsInputSchema, sparamsOutputSchema } from './sparams.js';
import type { SparamsArgs } from './sparams.js';
import type { SParameterResult } from '@spice-ts/core';
import { impedanceArgs, impedanceInvalid, impedancePlan, impedanceReport, impedanceProperties, impedanceOutputSchema, impedanceFailureSchema, impedanceErrorCodes } from './impedance.js';
import type { ImpedanceSelectors, ImpedanceSpectrum } from './impedance.js';
import { sensitivityArgs, sensitivityReport, sensitivityInputSchema, sensitivityOutputSchema } from './sensitivity.js';

export interface McpLimits {
  maxDocumentBytes: number;
  maxAnalyses: number;
  maxResultPoints: number;
  maxSerializedResultBytes: number;
  maxWallTimeMs: number;
}

export interface McpStreamLimits {
  /** Jobs solving at once per server: live stream jobs plus in-flight `spice_simulate` calls. */
  maxConcurrentJobs: number;
  runningJobTtlMs: number;
  terminalJobTtlMs: number;
  maxUnreadEvents: number;
  maxUnreadBytes: number;
}

export interface StreamClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ToolExecutionOptions {
  limits?: McpLimits;
  signal?: AbortSignal;
  validate?: typeof validateProtocolV1;
  simulate?: typeof simulateProtocolV1;
  workerFactory?: () => ExecutionWorker;
}

export interface ToolExecutorOptions extends ToolExecutionOptions {
  clock?: StreamClock;
  streamLimits?: Partial<McpStreamLimits>;
}

export type ToolExecutor = (
  name: string,
  args: unknown,
  options?: ToolExecutionOptions,
) => Promise<CallToolResult>;

export interface ExecutionWorker {
  postMessage(message: unknown): void;
  terminate(): Promise<number> | number;
  on(event: 'message', listener: (message: WorkerReply) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  off(event: 'message', listener: (message: WorkerReply) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
}

interface WorkerReply {
  type: 'result' | 'error' | 'events';
  result?: unknown;
  error?: SpiceApiErrorV1;
  events?: SimulationEventV1[];
}

interface WorkerRequest {
  operation: 'validate' | 'simulate' | 'stream' | 'noise' | 'pz' | 'op-report' | 'sensitivity' | 'tf' | 'disto' | 'impedance' | 'sparams';
  sparamsSelector?: SparamsArgs;
  impedanceSelector?: ImpedanceSelectors;
  request: SimulationRequestV1;
  coreModulePath: string;
  sensitivityOutput?: string;
  tfSelector?: { output: string; inputSource: string };
}

export const DEFAULT_MCP_LIMITS: Readonly<McpLimits> = Object.freeze({
  maxDocumentBytes: 256 * 1024,
  maxAnalyses: 8,
  maxResultPoints: 100_000,
  maxSerializedResultBytes: 4 * 1024 * 1024,
  maxWallTimeMs: 10_000,
});

export const DEFAULT_STREAM_CHUNK_POINTS = 256;
export const MAX_STREAM_CHUNK_POINTS = 1024;
export const MAX_RETAINED_STREAM_JOBS = 16;
/**
 * Server stream/job defaults, mirrored in docs/architecture/ai-native-api.md section 8
 * (a test parses that table and compares it with `spice_capabilities`).
 */
export const DEFAULT_MCP_STREAM_LIMITS: Readonly<McpStreamLimits> = Object.freeze({
  maxConcurrentJobs: 2,
  runningJobTtlMs: 30_000,
  terminalJobTtlMs: 300_000,
  maxUnreadEvents: 256,
  maxUnreadBytes: 1024 * 1024,
});
const PACKAGE_VERSION = '0.3.0';
const ENGINE_BUILD_ID = 'mcp-node-v1';

const requestInputSchema = {
  type: 'object',
  required: ['request'],
  properties: { request: { $ref: '#/$defs/simulationRequest' } },
  additionalProperties: false,
  $defs: commonSchemaV1.$defs,
};

const capabilitiesOutputSchema = {
  type: 'object',
  required: ['protocolVersion', 'analyses', 'inputFormats', 'limits', 'streaming'],
  properties: {
    protocolVersion: { const: '1' },
    analyses: { type: 'array', items: { enum: ['op', 'dc', 'tran', 'ac'] } },
    inputFormats: { type: 'array', items: { enum: ['spice', 'spice-ts', 'circuit-json'] } },
    tools: { type: 'array', items: { type: 'string' } },
    sensitivity: { type: 'object', required: ['tool', 'analyses'], additionalProperties: false,
      properties: { tool: { const: 'spice_sensitivity' }, analyses: { type: 'array', items: { enum: ['dc', 'ac'] } } } },
    tf: { type: 'object', required: ['tool', 'analyses'], additionalProperties: false,
      properties: { tool: { const: 'spice_tf' }, analyses: { type: 'array', items: { const: 'tf' } } } },
    impedance: { type: 'object', required: ['tool', 'analyses'], additionalProperties: false,
      properties: { tool: { const: 'spice_impedance' }, analyses: { type: 'array', items: { const: 'ac' } } } },
    parameterOverrides: { type: 'object', properties: {
      tools: { type: 'array', items: { type: 'string' } }, input: { type: 'string' },
      valueType: { type: 'string' }, scope: { type: 'string' }, caseSensitive: { type: 'boolean' },
      unknownParameterCode: { const: 'UNKNOWN_PARAMETER' },
    } },
    limits: {
      type: 'object',
      required: Object.keys(DEFAULT_MCP_LIMITS),
      properties: Object.fromEntries(Object.keys(DEFAULT_MCP_LIMITS).map(key => [key, { type: 'integer', minimum: 0 }])),
      additionalProperties: false,
    },
    streaming: {
      type: 'object',
      required: [
        'defaultChunkPoints', 'maxChunkPoints', 'maxRetainedJobs', 'maxConcurrentJobs',
        'runningJobTtlMs', 'terminalJobTtlMs', 'maxUnreadEvents', 'maxUnreadBytes',
      ],
      properties: {
        defaultChunkPoints: { const: DEFAULT_STREAM_CHUNK_POINTS },
        maxChunkPoints: { const: MAX_STREAM_CHUNK_POINTS },
        maxRetainedJobs: { const: MAX_RETAINED_STREAM_JOBS },
        maxConcurrentJobs: { type: 'integer', minimum: 0 },
        runningJobTtlMs: { type: 'integer', minimum: 0 },
        terminalJobTtlMs: { type: 'integer', minimum: 0 },
        maxUnreadEvents: { type: 'integer', minimum: 0 },
        maxUnreadBytes: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const validationOutputSchema = {
  type: 'object',
  required: ['status', 'nodeCount', 'branchCount', 'analysisCount'],
  properties: {
    status: { const: 'valid' },
    nodeCount: { type: 'integer', minimum: 0 },
    branchCount: { type: 'integer', minimum: 0 },
    analysisCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const streamStartOutputSchema = {
  type: 'object',
  required: ['jobId', 'status', 'cursor'],
  properties: {
    jobId: { type: 'string', minLength: 1 },
    status: { const: 'running' },
    cursor: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const toolFailureOutputSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { $ref: '#/$defs/apiError' } },
  additionalProperties: false,
};

const streamStartToolOutputSchema = {
  type: 'object',
  oneOf: [streamStartOutputSchema, toolFailureOutputSchema],
  $defs: commonSchemaV1.$defs,
};

const streamReadInputSchema = {
  type: 'object',
  required: ['jobId', 'cursor'],
  properties: {
    jobId: { type: 'string', minLength: 1 },
    cursor: { type: 'string', minLength: 1 },
    maxPoints: { type: 'integer', minimum: 1, maximum: MAX_STREAM_CHUNK_POINTS },
  },
  additionalProperties: false,
};

const streamCancelInputSchema = {
  type: 'object',
  required: ['jobId'],
  properties: { jobId: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};

const streamToolOutputSchema = {
  type: 'object',
  oneOf: [
    { $ref: '#/$defs/simulationReadData' },
    toolFailureOutputSchema,
  ],
  $defs: commonSchemaV1.$defs,
};

export const MCP_TOOLS = Object.freeze([
  {
    name: 'spice_sparams',
    description: 'Run one unstepped .sp sweep. Return S-parameter magnitudes, dB, phase degrees, reflection return loss/VSWR and transmission insertion loss. Optional one-based portPair [output,input] and explicit frequenciesHz. Infinite/undefined metrics are null. Reject conflicting analyses and control blocks.',
    inputSchema: sparamsInputSchema,
    outputSchema: { type: 'object', oneOf: [sparamsOutputSchema, toolFailureOutputSchema], $defs: commonSchemaV1.$defs },
  },
  {
    name: 'spice_impedance',
    description: 'Measure differential port impedance versus frequency with a 1 A AC current injected from negative to positive. Suppress AC excitation of all other independent sources, preserve DC bias and dependent sources. Accept a protocol request (SPICE or circuit-json), port, optional sweep override and SPICE params. Return ohms, degrees, sampled extrema and interpolated phase-zero resonance estimates.',
    inputSchema: { ...requestInputSchema, required: ['request', 'port'], properties: { ...requestInputSchema.properties, ...impedanceProperties } },
    outputSchema: { type: 'object', oneOf: [impedanceOutputSchema, toolFailureOutputSchema, impedanceFailureSchema], $defs: commonSchemaV1.$defs },
  },
  {
    name: 'spice_tf',
    description: 'Run native small-signal .tf for v(node) or i(vsrc) and an independent voltage/current input source. Return gain and port resistances with units. Accept exactly one legacy netlist or protocol-v1 request (spice, spice-ts or circuit-json). Optional params overrides require SPICE input. Reject conflicting analyses, steps and control blocks.',
    inputSchema: { ...requestInputSchema, required: ['output', 'input_source'],
      properties: { ...requestInputSchema.properties, ...tfInputSchema.properties },
      oneOf: [{ required: ['netlist'] }, { required: ['request'] }] },
    outputSchema: { type: 'object', oneOf: [tfOutputSchema, toolFailureOutputSchema], $defs: commonSchemaV1.$defs },
  },
  {
    name: 'spice_sensitivity',
    description: 'Run native DC or AC sensitivity for v(node), v(a,b) or i(vsrc). Return absolute derivatives and value*dOut/dParam, ranked by descending normalised magnitude, with optional top per frequency for AC. AC requires a dec/oct/lin sweep and returns complex derivatives. Accept exactly one legacy netlist or protocol-v1 request (spice, spice-ts or circuit-json). Replaces deck analyses; steps, control blocks and pole-zero analyses are rejected.',
    inputSchema: { ...requestInputSchema, required: ['output'],
      properties: { ...requestInputSchema.properties, ...sensitivityInputSchema.properties },
      oneOf: [{ required: ['netlist'] }, { required: ['request'] }],
      allOf: [{ oneOf: sensitivityInputSchema.oneOf }] },
    outputSchema: { type: 'object', oneOf: [sensitivityOutputSchema, toolFailureOutputSchema], $defs: commonSchemaV1.$defs },
  },
  {
    name: 'spice_capabilities',
    description: 'Describe the deterministic bounded spice-ts protocol-v1 tool surface.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: capabilitiesOutputSchema,
  },
  {
    name: 'spice_validate',
    description: 'Parse, compile, and validate one bounded protocol-v1 simulation request without solving it.',
    inputSchema: requestInputSchema,
    outputSchema: validationOutputSchema,
  },
  {
    name: 'spice_convert',
    description: 'Convert a bounded SPICE circuit to circuit-json or circuit-json to a SPICE netlist. Exactly one input is required. Analyses and simulator directives are not part of circuit-json. Unsupported or lossy conversions fail with diagnostics.',
    inputSchema: {
      type: 'object',
      properties: { netlist: { type: 'string' }, circuitJson: { type: 'array', items: { type: 'object' } } },
      oneOf: [{ required: ['netlist'] }, { required: ['circuitJson'] }],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        netlist: { type: 'string' }, circuitJson: { type: 'array', items: { type: 'object' } },
        diagnostics: { type: 'array', items: { type: 'object' } }, lossy: { const: false },
      },
      required: ['diagnostics', 'lossy'],
      oneOf: [{ required: ['netlist'] }, { required: ['circuitJson'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'spice_simulate',
    description: 'Execute one bounded protocol-v1 simulation request. Optional params: Record<string, number> overrides top-level .param values before elaboration (SPICE text only, case-insensitive, finite numbers). Unknown names return UNKNOWN_PARAMETER with available names.',
    inputSchema: { ...requestInputSchema, properties: { ...requestInputSchema.properties, params: paramsSchema } },
    outputSchema: { ...commonSchemaV1.$defs.simulationResult, $defs: commonSchemaV1.$defs },
  },
  {
    name: 'spice_monte_carlo',
    description: 'Seeded tolerance statistics for 1–1000 sequential SPICE-text runs under one shared wall-time budget. Perturb literal positive top-level R/C/L scalars independently using relative sigma (0 <= sigma < 0.5); uniform has half-width sqrt(3)*sigma, gaussian is untruncated. Explicit unsigned 32-bit seed. Uses spice_measure selectors, including at=0 for OP. Returns sample std and linearly interpolated p5/p95. Aborts on any failed run or measure, never silently drops samples.',
    inputSchema: {
      ...requestInputSchema, required: ['request', 'runs', 'seed', 'tolerances', 'measurements'],
      properties: { ...requestInputSchema.properties, ...monteCarloProperties },
    },
  },
  {
    name: 'spice_optimize',
    description: 'Deterministic bounded search over one to three top-level SPICE .param values toward a scalar spice_measure objective. Golden-section search for one parameter, coordinate descent for two or three. Absolute objective tolerance, default 40 and hard maximum 100 evaluations. Returns best parameters, achieved value and ordered history; TARGET_NOT_REACHED means no convergence, not proof of global infeasibility. One shared wall-time budget.',
    inputSchema: {
      ...requestInputSchema, required: ['request', 'parameters', 'objective', 'target'],
      properties: { ...requestInputSchema.properties, ...optimizeProperties },
    },
  },
  {
    name: 'spice_sweep',
    description: 'Sequential bounded parameter sweep. Target a top-level .param (SPICE only) or R/C/L component scalar value (SPICE or native JSON IR). Supply exactly one of values or range. lin points is total samples; dec points is samples per decade including exact stop. Returns ordered statuses and optional spice_measure-style measurements; individual simulation failures do not abort other points. Maximum 100 points and one shared wall-time budget.',
    inputSchema: {
      ...requestInputSchema, required: ['request', 'parameter'],
      properties: { ...requestInputSchema.properties, ...sweepProperties },
      oneOf: [{ required: ['values'], not: { required: ['range'] } }, { required: ['range'], not: { required: ['values'] } }],
    },
  },
  {
    name: 'spice_corners',
    description: 'Run SPICE text across up to 64 uniquely named deterministic corners with optional top-level .param overrides and/or temp in Celsius. Apply one spice_measure-style measurement. Returns ordered per-corner values or errors and successful min/max names and absolute spread (null summary if all fail). First corner wins ties. Shares one wall-time budget.',
    inputSchema: {
      ...requestInputSchema, required: ['request', 'corners', 'measurement'],
      properties: { ...requestInputSchema.properties, ...cornersProperties },
    },
  },
  {
    name: 'spice_ac_metrics',
    description: 'Simulate and reduce one AC sweep to gain, half-power bandwidth, sampled peaking and loop margins. dcGainDb is the lowest-frequency sample, not an extrapolation to DC. Uses first descending crossings with log-frequency interpolation; absent metrics have null values and reason codes.',
    inputSchema: {
      ...requestInputSchema,
      required: ['request', 'output'],
      properties: { ...requestInputSchema.properties, ...acMetricsProperties },
    },
    outputSchema: {
      type: 'object', oneOf: [acMetricsOutputSchema, toolFailureOutputSchema],
      $defs: commonSchemaV1.$defs,
    },
  },
  {
    name: 'spice_power_metrics',
    description: 'Summarize one transient: signed average absorbed power (W), RMS current (A), maximum signed instantaneous power and time (s) per two-terminal element. Optional window in seconds and input/output lists; efficiency is output absorption / input delivery, or null without positive input delivery. Accepts exactly one legacy netlist or protocol-v1 request (SPICE, native spice-ts, circuit-json). Uses zero-volt current probes; flat unstepped circuits only.',
    inputSchema: {
      ...requestInputSchema,
      required: [],
      oneOf: [{ required: ['netlist'] }, { required: ['request'] }],
      properties: { ...requestInputSchema.properties, ...powerMetricsProperties },
    },
    outputSchema: { type: 'object', oneOf: [powerMetricsOutputSchema, powerMetricsErrorSchema, toolFailureOutputSchema], $defs: commonSchemaV1.$defs },
  },
  {
    name: 'spice_tran_metrics',
    description: 'Simulate one transient step response. Returns interpolated 10-90% rise/fall time, overshoot/undershoot, directional peak and settling time in seconds. Endpoint levels default to first/last samples; supply known initialValue/finalValue for truncated traces. Settling requires the final 10% of sampled duration in band (default 2% of step amplitude).',
    inputSchema: {
      ...requestInputSchema,
      required: ['request', 'signal'],
      properties: { ...requestInputSchema.properties, ...tranMetricsProperties },
    },
    outputSchema: {
      type: 'object', oneOf: [...tranMetricsOutputSchemas, toolFailureOutputSchema],
      $defs: commonSchemaV1.$defs,
    },
  },
  {
    name: 'spice_fourier',
    description: 'Simulate one transient and return DC, harmonics and THD percent using ngspice .four last-period semantics (200-point linear interpolation). fundamentalHz is in Hz; harmonicCount counts positive harmonics (default 9, max 64). Optional windowStartS is a lower bound that must leave the full last period available. Phases are sine-referenced degrees.',
    inputSchema: {
      ...requestInputSchema,
      required: ['request', 'signal', 'fundamentalHz'],
      properties: { ...requestInputSchema.properties, ...fourierProperties },
    },
    outputSchema: {
      type: 'object', oneOf: [...fourierOutputSchemas, toolFailureOutputSchema],
      $defs: commonSchemaV1.$defs,
    },
  },
  {
    name: 'spice_disto_metrics',
    description: 'Run exactly one unstepped .disto from SPICE text for output v(node). JSON requests (spice-ts and circuit-json) return UNSUPPORTED_FEATURE naming missing DISTOF1/DISTOF2 source fields; their adapters cannot represent these excitations. Use SPICE text, not AC amplitude inference. Return HD2/HD3 or SIM2/DIM2/DIM3 complex voltages, absolute magnitude, dBV (not dBc) and phase in degrees at each swept F1 frequency. F2 is fixed at start-F1 times F2OVERF1. Zero magnitude has null dBV and phase. Core supports bounded diodes and ideal linear devices, not BJT distortion.',
    inputSchema: { ...requestInputSchema, required: ['request', 'output'], properties: { ...requestInputSchema.properties, output: { type: 'string', pattern: '^[vV]\\([^\\s(),]+\\)$' } },
      // Tool-local recognition for actionable errors, not a protocol-wide analysis extension.
      $defs: { ...commonSchemaV1.$defs, analysis: { anyOf: [
        commonSchemaV1.$defs.analysis,
        { type: 'object', required: ['type', 'variation', 'points', 'startFreq', 'stopFreq'], additionalProperties: false,
          properties: { type: { const: 'disto' }, variation: { const: 'dec' }, points: { type: 'integer', minimum: 1 },
            startFreq: { type: 'number', exclusiveMinimum: 0 }, stopFreq: { type: 'number', exclusiveMinimum: 0 },
            f2OverF1: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 } } },
      ] } },
    },
    outputSchema: { type: 'object', oneOf: [distoMetricsOutputSchema, toolFailureOutputSchema, distoUnsupportedSchema], $defs: commonSchemaV1.$defs },
  },
  {
    name: 'spice_pz_metrics',
    description: 'Run exactly one unstepped pole-zero analysis (mode pol or pz) from SPICE text, spice-ts JSON or circuit-json. Return finite poles/zeros, conjugate-pair natural frequency, damping and signed Q, dominant pole and strict left-half-plane stability. Root frequencyHz is magnitude/(2*pi); Q is null at zero damping. Other analyses are not executed.',
    inputSchema: requestInputSchema,
    outputSchema: {
      type: 'object', oneOf: [pzMetricsOutputSchema, toolFailureOutputSchema],
      $defs: commonSchemaV1.$defs,
    },
  },
  {
    name: 'spice_noise_metrics',
    description: 'Simulate exactly one unstepped .noise analysis. Integrate PSD by linear-frequency trapezoids over optional bandHz; interpolate spotFrequenciesHz densities in log-frequency without extrapolation. SPICE text input; native JSON IR does not yet support noise directives.',
    inputSchema: {
      ...requestInputSchema,
      properties: { ...requestInputSchema.properties, ...noiseMetricsProperties },
    },
    outputSchema: {
      type: 'object', oneOf: [noiseMetricsOutputSchema, toolFailureOutputSchema],
      $defs: commonSchemaV1.$defs,
    },
  },
  {
    name: 'spice_measure',
    description: 'Simulate once and return up to 128 scalar measurements. Analysis is a zero-based index; optional step selects the zero-based SimulationResultV1 step.index (required for multiple steps). Unstepped analyses accept step 0 only. Signals are v(node), i(branch), mag(v(node)), or db(v(node)). Cross/when return the first matching axis coordinate.',
    inputSchema: {
      ...requestInputSchema,
      required: ['request', 'measurements'],
      properties: { ...requestInputSchema.properties, measurements: measurementListSchema },
    },
    outputSchema: {
      type: 'object', required: ['measurements'], additionalProperties: false,
      properties: {
        measurements: {
          type: 'array', minItems: 1, maxItems: 128,
          items: {
            oneOf: [
              { type: 'object', required: ['value', 'unit'], additionalProperties: false, properties: { value: { type: 'number' }, unit: { type: 'string' } } },
              { type: 'object', required: ['error'], additionalProperties: false, properties: { error: { type: 'object', required: ['code', 'message'], additionalProperties: false, properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
            ],
          },
        },
      },
    },
  },
  {
    name: 'spice_dc_metrics',
    description: 'Simulate a DC voltage transfer sweep and return gain, switching threshold, unity-gain points and noise margins. Expressions are v(node); input defaults to the swept voltage source. Undefined metrics include null and a reason.',
    inputSchema: {
      ...requestInputSchema,
      required: ['request', 'sweptSource', 'output'],
      properties: { ...requestInputSchema.properties, ...dcMetricsProperties },
    },
    outputSchema: dcMetricsOutputSchema,
  },
  {
    name: 'spice_op_report',
    description: 'Run one DC operating point from exactly one of a titleless SPICE netlist or a protocol-v1 request (SPICE text, spice-ts JSON or circuit-json). Return node voltages, terminal currents entering devices (A), absorbed power (W), delivered/absorbed totals and top dissipators. Ignores analysis/control commands; rejects parameter steps. Negative device power means delivery.',
    inputSchema: {
      ...requestInputSchema,
      required: [], oneOf: [{ required: ['netlist'] }, { required: ['request'] }],
      properties: { ...requestInputSchema.properties, netlist: { type: 'string', minLength: 1 }, topN: { type: 'integer', minimum: 0, maximum: 10000 } },
    },
    outputSchema: {
      type: 'object', required: ['nodeVoltages', 'devices', 'sourceDeliveredPowerW', 'dissipatedPowerW', 'topDissipators'],
      properties: {
        nodeVoltages: { type: 'object', additionalProperties: { type: 'number' } },
        devices: { type: 'array', items: { type: 'object', required: ['name', 'terminalCurrents', 'powerW'], properties: {
          name: { type: 'string' }, terminalCurrents: { type: 'object', additionalProperties: { type: 'number' } }, powerW: { type: 'number' },
        } } },
        sourceDeliveredPowerW: { type: 'number' }, dissipatedPowerW: { type: 'number' },
        topDissipators: { type: 'array', items: { type: 'object', required: ['name', 'powerW'], properties: { name: { type: 'string' }, powerW: { type: 'number' } } } },
      },
    },
  },
  {
    name: 'spice_compare',
    description: 'Compare inline waveforms, protocol-v1 results, or completed jobs on the union axis within their overlap. Errors are relative to the reference peak. AC compares magnitude and wrapped phase in degrees.',
    inputSchema: { ...compareInputSchema, $defs: commonSchemaV1.$defs },
    outputSchema: compareOutputSchema,
  },
  {
    name: 'spice_simulation_start',
    description: 'Start one bounded protocol-v1 simulation job and return its first opaque cursor. Optional params: Record<string, number> overrides top-level .param values before elaboration (SPICE text only, case-insensitive, finite numbers). Unknown names return UNKNOWN_PARAMETER with available names.',
    inputSchema: { ...requestInputSchema, properties: { ...requestInputSchema.properties, params: paramsSchema } },
    outputSchema: streamStartToolOutputSchema,
  },
  {
    name: 'spice_simulation_read',
    description: 'Read one deterministic point-bounded chunk from a simulation job.',
    inputSchema: streamReadInputSchema,
    outputSchema: streamToolOutputSchema,
  },
  {
    name: 'spice_simulation_cancel',
    description: 'Cancel a simulation job and return its protocol-v1 partial terminal.',
    inputSchema: streamCancelInputSchema,
    outputSchema: streamToolOutputSchema,
  },
]) as readonly Tool[];

const capabilities = Object.freeze({
  protocolVersion: '1',
  analyses: Object.freeze(['op', 'dc', 'tran', 'ac']),
  inputFormats: Object.freeze(['spice', 'spice-ts', 'circuit-json']),
  tools: Object.freeze(MCP_TOOLS.map(tool => tool.name)),
  sensitivity: Object.freeze({ tool: 'spice_sensitivity', analyses: Object.freeze(['dc', 'ac']) }),
  tf: Object.freeze({ tool: 'spice_tf', analyses: Object.freeze(['tf']) }),
  impedance: Object.freeze({ tool: 'spice_impedance', analyses: Object.freeze(['ac']) }),
  parameterOverrides,
  limits: DEFAULT_MCP_LIMITS,
  streaming: Object.freeze({
    defaultChunkPoints: DEFAULT_STREAM_CHUNK_POINTS,
    maxChunkPoints: MAX_STREAM_CHUNK_POINTS,
    maxRetainedJobs: MAX_RETAINED_STREAM_JOBS,
    ...DEFAULT_MCP_STREAM_LIMITS,
  }),
});

export async function executeTool(
  name: string,
  args: unknown,
  options: ToolExecutionOptions = {},
): Promise<CallToolResult> {
  return executeToolWithStore(name, args, options, defaultStreamStore);
}

export function createToolExecutor(baseOptions: ToolExecutorOptions = {}): ToolExecutor {
  const { clock, streamLimits, ...executionOptions } = baseOptions;
  const store = new StreamStore(streamLimits, clock);
  return (name, args, options = {}) => executeToolWithStore(
    name,
    args,
    { ...executionOptions, ...options },
    store,
  );
}

async function executeToolWithStore(
  name: string,
  args: unknown,
  options: ToolExecutionOptions,
  streamStore: StreamStore,
): Promise<CallToolResult> {
  const limits = options.limits ?? DEFAULT_MCP_LIMITS;
  try {
    if (name === 'spice_capabilities') return success(streamStore.capabilities());
    if (name === 'spice_sparams') {
      enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      const selectors = sparamsArgs(args);
      enforceMaximum('maxAnalyses', limits.maxAnalyses, 1, 'validation');
      const release = streamStore.acquireOneShotSlot();
      try {
        const request: SimulationRequestV1 = { apiVersion: '1', input: { format: 'spice', source: selectors.netlist } };
        const raw = await runInWorker<SParameterResult[]>('sparams', boundedRequest(request, limits), limits.maxWallTimeMs,
          options, undefined, undefined, undefined, selectors);
        enforceMaximum('maxResultPoints', limits.maxResultPoints, raw.reduce((n, r) => n + r.frequencies.length * r.ports.length ** 2, 0), 'transport');
        const result = sparamsReport(raw, selectors);
        enforceMaximum('maxSerializedResultBytes', limits.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'transport');
        return success(result);
      } finally { release(); }
    }
    if (name === 'spice_impedance') {
      enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      const selectors = impedanceArgs(args);
      let original = toolRequest(args);
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      original = overrideParameters(original, (args as Record<string, unknown>).params);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(original)), 'validation');
      throwIfCancelled(options.signal);
      const { request, diagnostics } = convertRequest(original);
      const plan = await requestPlan(request);
      if (plan.analyses.some(a => a.type !== 'ac') || plan.analyses.length > 1) impedanceInvalid('Impedance requires one AC sweep without conflicting analyses');
      const sweep = selectors.sweep ?? plan.analyses.find(a => a.type === 'ac');
      if (!sweep) impedanceInvalid('Provide an AC sweep or one .ac directive', 'MISSING_AC_SWEEP');
      selectors.sweep = sweep;
      await boundedRequestPlan(impedancePlan(request, sweep), effective);
      const release = streamStore.acquireOneShotSlot();
      try {
        const spectrum = await runInWorker<ImpedanceSpectrum>('impedance', boundedRequest(request, effective), effective.maxWallTimeMs, options, undefined, undefined, selectors);
        enforceMaximum('maxResultPoints', effective.maxResultPoints, spectrum.frequencyHz.length, 'transport');
        const report = impedanceReport(spectrum, selectors);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(report)), 'transport');
        return success(report, diagnostics);
      } finally { release(); }
    }
    if (name === 'spice_tf') {
      enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      if (!isRecord(args) || ('netlist' in args) === ('request' in args)) {
        throw apiError('INVALID_REQUEST', 'Expected exactly one of netlist or request', 'validation', {});
      }
      const { request: rawRequest, ...selectorArgs } = args;
      const selectors = tfArgs('netlist' in args ? selectorArgs : { ...selectorArgs, netlist: 'protocol request' });
      const original = toolRequest('netlist' in args ? {
        request: { apiVersion: '1', input: { format: 'spice', source: selectors.netlist } },
      } : { request: rawRequest });
      if (!validateMetricsRequest(original).valid) {
        throw apiError('INVALID_REQUEST', 'Invalid transfer-function request', 'validation', {});
      }
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      const overridden = overrideParameters(original, selectors.params);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(overridden)), 'validation');
      throwIfCancelled(options.signal);
      const { request, diagnostics } = convertRequest(overridden);
      enforceMaximum('maxAnalyses', effective.maxAnalyses, 1, 'validation');
      const release = streamStore.acquireOneShotSlot();
      try {
        const raw = await runInWorker<TransferFunctionResult>('tf', boundedRequest(request, effective), effective.maxWallTimeMs, options, undefined,
          { output: selectors.output, inputSource: selectors.input_source });
        enforceMaximum('maxResultPoints', effective.maxResultPoints, 3, 'transport');
        const result = tfReport(raw, selectors);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'transport');
        return success(result, diagnostics);
      } finally { release(); }
    }
    if (name === 'spice_sensitivity') {
      enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      if (!isRecord(args) || ('netlist' in args) === ('request' in args)) {
        throw apiError('INVALID_REQUEST', 'Expected exactly one of netlist or request', 'validation', {});
      }
      const { request: rawRequest, ...selectorArgs } = args;
      const selectors = sensitivityArgs('netlist' in args ? selectorArgs : { ...selectorArgs, netlist: 'protocol request' });
      const original = toolRequest('netlist' in args ? {
        request: { apiVersion: '1', input: { format: 'spice', source: selectors.netlist } },
      } : { request: rawRequest });
      if (!validateMetricsRequest(original).valid) {
        throw apiError('INVALID_REQUEST', 'Invalid sensitivity request', 'validation', {});
      }
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      throwIfCancelled(options.signal);
      const { request, diagnostics } = convertRequest(original);
      enforceMaximum('maxAnalyses', effective.maxAnalyses, 1, 'validation');
      const release = streamStore.acquireOneShotSlot();
      try {
        const raw = await runInWorker<SensitivityResult>('sensitivity', boundedRequest(request, effective), effective.maxWallTimeMs, options, selectors.sweep
          ? `${selectors.output} ac ${selectors.sweep.type} ${selectors.sweep.points} ${selectors.sweep.fstart} ${selectors.sweep.fstop}`
          : selectors.output);
        enforceMaximum('maxResultPoints', effective.maxResultPoints, raw.entries.length * Math.max(1, raw.frequencies?.length ?? 0), 'transport');
        const result = sensitivityReport(raw, selectors);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'transport');
        return success(result, diagnostics);
      } finally { release(); }
    }
    if (name === 'spice_power_metrics') {
      if (!isRecord(args) || (('netlist' in args) === ('request' in args))) {
        throw apiError('INVALID_REQUEST', 'Expected exactly one of netlist or request', 'validation', {});
      }
      const { request: rawRequest, ...rawSelectors } = args;
      // Validate selectors before conversion, while retaining the legacy argument contract.
      const selectors = powerMetricsArgs('netlist' in args ? rawSelectors : { ...rawSelectors, netlist: 'pending' });
      const original = toolRequest('netlist' in args ? {
        request: { apiVersion: '1', input: { format: 'spice', source: selectors.netlist } },
      } : { request: rawRequest });
      if (!validateMetricsRequest(original).valid) {
        throw apiError('INVALID_REQUEST', 'Invalid power metrics request', 'validation', {});
      }
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      throwIfCancelled(options.signal);
      const { request, diagnostics } = convertRequest(original);
      await boundedRequestPlan(request, effective);
      const netlist = request.input.format === 'spice' ? request.input.source
        : request.input.format === 'spice-ts' ? circuitFromDocument(request.input.document).toNetlist()
        : selectors.netlist;
      const plan = powerPlan({ ...selectors, netlist });
      if ('error' in plan) return { ...success(plan, diagnostics), isError: true };
      const response = await executeToolWithStore('spice_simulate', {
        request: { ...request, input: { format: 'spice', source: plan.netlist } },
      }, { ...options, limits: effective }, streamStore);
      if (response.isError) return response;
      const report = powerMetrics(response.structuredContent as unknown as SimulationResultV1, plan);
      enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(report)), 'transport');
      return success(report, diagnostics);
    }
    if (name === 'spice_op_report') {
      if (!isRecord(args) || Object.keys(args).some(key => !['netlist', 'request', 'topN'].includes(key))
        || (('netlist' in args) === ('request' in args))
        || ('netlist' in args && (typeof args.netlist !== 'string' || !args.netlist.trim()))
        || (args.topN !== undefined && (!Number.isInteger(args.topN) || (args.topN as number) < 0 || (args.topN as number) > 10000))) {
        throw apiError('INVALID_REQUEST', 'Expected exactly one of netlist or request and optional integer topN (0–10000)', 'validation', {});
      }
      const original = toolRequest('netlist' in args ? { request: { apiVersion: '1', input: { format: 'spice', source: args.netlist } } } : args);
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      if (!validateMetricsRequest(original).valid) {
        throw apiError('INVALID_REQUEST', 'Invalid operating-point request', 'validation', {});
      }
      throwIfCancelled(options.signal);
      const { request } = convertRequest(original);
      const release = streamStore.acquireOneShotSlot();
      try {
        const report = await runInWorker<OperatingPointReport>('op-report', request, effective.maxWallTimeMs, options);
        enforceMaximum('maxResultPoints', effective.maxResultPoints, report.devices.length, 'transport');
        const result = { ...report, topDissipators: report.devices.filter(device => device.powerW > 0)
          .sort((a, b) => b.powerW - a.powerW || a.name.localeCompare(b.name))
          .slice(0, (args.topN as number | undefined) ?? 10).map(({ name, powerW }) => ({ name, powerW })) };
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'transport');
        return success(result);
      } finally { release(); }
    }
    if (name === 'spice_corners') {
      const original = toolRequest(args);
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      const deadline = Date.now() + effective.maxWallTimeMs;
      const result = await runCorners(args, original, (request, measurements) => executeToolWithStore(
        'spice_measure', { request, measurements },
        { ...options, limits: { ...effective, maxWallTimeMs: Math.max(1, deadline - Date.now()) } }, streamStore,
      ), result => {
        throwIfCancelled(options.signal);
        enforceMaximum('maxWallTimeMs', effective.maxWallTimeMs, effective.maxWallTimeMs - (deadline - Date.now()), 'solve');
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'transport');
      });
      return success(result);
    }
    if (name === 'spice_monte_carlo') {
      const original = toolRequest(args);
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      const deadline = Date.now() + effective.maxWallTimeMs;
      const result = await runMonteCarlo(args, original, (request, measurements) => executeToolWithStore(
        'spice_measure', { request, measurements },
        { ...options, limits: { ...effective, maxWallTimeMs: Math.max(1, deadline - Date.now()) } }, streamStore,
      ), () => {
        throwIfCancelled(options.signal);
        enforceMaximum('maxWallTimeMs', effective.maxWallTimeMs, effective.maxWallTimeMs - (deadline - Date.now()), 'solve');
      });
      enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'transport');
      return success(result);
    }
    if (name === 'spice_optimize') {
      const original = toolRequest(args);
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      const deadline = Date.now() + effective.maxWallTimeMs;
      const result = await runOptimize(args, original, (request, measurements) => executeToolWithStore(
        'spice_measure', { request, measurements },
        { ...options, limits: { ...effective, maxWallTimeMs: Math.max(1, deadline - Date.now()) } }, streamStore,
      ), history => {
        throwIfCancelled(options.signal);
        enforceMaximum('maxWallTimeMs', effective.maxWallTimeMs, effective.maxWallTimeMs - (deadline - Date.now()), 'solve');
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(history)), 'transport');
      });
      enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'transport');
      return { ...success(result), ...('error' in result ? { isError: true } : {}) };
    }
    if (name === 'spice_sweep') {
      const original = toolRequest(args);
      const effective = effectiveLimits(original, limits);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      const deadline = Date.now() + effective.maxWallTimeMs;
      const result = await runSweep(args, original, (request, measurements) => executeToolWithStore(
        measurements === undefined ? 'spice_simulate' : 'spice_measure',
        { request, ...(measurements === undefined ? {} : { measurements }) },
        { ...options, limits: { ...effective, maxWallTimeMs: Math.max(1, deadline - Date.now()) } }, streamStore,
      ), points => {
        throwIfCancelled(options.signal);
        enforceMaximum('maxWallTimeMs', effective.maxWallTimeMs, effective.maxWallTimeMs - (deadline - Date.now()), 'solve');
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify({ parameter: isRecord(args) ? args.parameter : undefined, points })), 'transport');
      });
      return success(result);
    }
    if (name === 'spice_convert') return convertTool(args, limits, options.signal);
    if (name === 'spice_compare') {
      throwIfCancelled(options.signal);
      enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args) ?? ''), 'validation');
      const compared = compareSignals(args, id => streamStore.comparisonResult(id), limits.maxResultPoints);
      enforceMaximum('maxSerializedResultBytes', limits.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(compared)), 'transport');
      return { ...success(compared), ...('error' in compared ? { isError: true } : {}) };
    }
    if (name === 'spice_simulation_read') return success(streamStore.read(streamReadArgs(args)));
    if (name === 'spice_simulation_cancel') return success(streamStore.cancel(streamCancelArgs(args)));
    if (name !== 'spice_validate' && name !== 'spice_simulate' && name !== 'spice_measure' && name !== 'spice_dc_metrics' && name !== 'spice_ac_metrics' && name !== 'spice_tran_metrics' && name !== 'spice_fourier' && name !== 'spice_pz_metrics' && name !== 'spice_noise_metrics' && name !== 'spice_disto_metrics' && name !== 'spice_simulation_start') {
      return failure(apiError('INVALID_REQUEST', 'Unknown tool', 'transport', {}));
    }

    const selectors = name === 'spice_ac_metrics' ? acMetricsArgs(args) : undefined;
    const tranSelectors = name === 'spice_tran_metrics' ? tranMetricsArgs(args) : undefined;
    const fourierSelectors = name === 'spice_fourier' ? fourierArgs(args) : undefined;
    const noiseSelectors = name === 'spice_noise_metrics' ? noiseMetricsArgs(args) : undefined;
    const distoSelector = name === 'spice_disto_metrics' ? distoOutput(args) : undefined;
    const measurements = name === 'spice_measure' && isRecord(args) ? args.measurements : undefined;
    if (name === 'spice_measure' && (!Array.isArray(measurements) || measurements.length < 1 || measurements.length > 128)) {
      throw apiError('INVALID_REQUEST', 'Expected 1 through 128 measurements', 'validation', {});
    }
    if (name === 'spice_measure') enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, Buffer.byteLength(JSON.stringify(measurements)), 'validation');
    const dcInput = name === 'spice_dc_metrics' ? dcMetricsInput(args) : undefined;
    let original = toolRequest(args);
    const effective = effectiveLimits(original, limits);
    enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(original.input)), 'validation');
    if (distoSelector) validateDistoJsonInput(original.input);
    if (name === 'spice_pz_metrics' && original.input.format !== 'spice' && !validatePoleZeroInput(original.input).valid) {
      throw apiError('INVALID_REQUEST', 'Invalid pole-zero JSON input', 'validation', {});
    }
    if ((name === 'spice_simulate' || name === 'spice_simulation_start') && isRecord(args) && args.params !== undefined) {
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
      original = overrideParameters(original, args.params);
      enforceMaximum('maxDocumentBytes', effective.maxDocumentBytes, Buffer.byteLength(JSON.stringify(original.input)), 'validation');
    }
    throwIfCancelled(options.signal);
    const { request, diagnostics } = convertRequest(original);
    const plan = await boundedRequestPlan(request, effective);
    if (distoSelector) {
      if (plan.analyses.length !== 1 || plan.analyses[0].type !== 'disto') unsupportedDisto();
      const analysis = plan.analyses[0];
      // Match core distortion's index-based DEC grid exactly, stopping at the resource ceiling.
      let points = 0;
      while (analysis.startFreq * Math.pow(10, points / analysis.points) <= analysis.stopFreq) {
        enforceMaximum('maxResultPoints', effective.maxResultPoints, ++points, 'validation');
      }
    }
    throwIfCancelled(options.signal);

    if (name === 'spice_validate') {
      const bounded = boundedRequest(request, effective);
      const result = options.validate
        ? await boundedCall(() => options.validate!(bounded, { topologyWarnings: true }), effective.maxWallTimeMs, options.signal)
        : await runInWorker<Record<string, unknown>>(
          'validate', bounded, effective.maxWallTimeMs, options,
        );
      return success(result, diagnostics);
    }

    const bounded = boundedRequest(request, effective);
    if (name === 'spice_simulation_start') {
      return success(streamStore.start(bounded, plan, effective, options), diagnostics);
    }
    const release = streamStore.acquireOneShotSlot();
    try {
      if (distoSelector) {
        const spectrum = await runInWorker<DistoSpectrum>('disto', bounded, effective.maxWallTimeMs, options);
        const metrics = distoMetrics(spectrum, distoSelector);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(metrics)), 'transport');
        return success(metrics, diagnostics);
      }
      if (name === 'spice_pz_metrics') {
        const result = await runInWorker<PoleZeroResult>('pz', bounded, effective.maxWallTimeMs, options);
        const metrics = pzMetrics(result);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(metrics)), 'transport');
        return success(metrics, diagnostics);
      }
      if (noiseSelectors) {
        const spectrum = await runInWorker<NoiseResult>('noise', bounded, effective.maxWallTimeMs, options);
        const metrics = noiseMetrics(spectrum, noiseSelectors);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(metrics)), 'transport');
        return success(metrics, diagnostics);
      }
      const result = options.simulate
        ? await boundedCall(() => options.simulate!(bounded), effective.maxWallTimeMs, options.signal)
        : await runInWorker<SimulationResultV1>('simulate', bounded, effective.maxWallTimeMs, options);
      enforceResultBounds(result, effective);
      if (dcInput) {
        const measured = dcMetricsResult(result, dcInput);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(measured)), 'transport');
        return success(measured, diagnostics);
      }
      if (selectors || tranSelectors || fourierSelectors) {
        const metrics = fourierSelectors ? fourierMetrics(result, fourierSelectors) : tranSelectors ? tranMetrics(result, tranSelectors) : acMetrics(result, selectors!);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(metrics)), 'transport');
        return { ...success(metrics, diagnostics), ...('error' in metrics ? { isError: true } : {}) };
      }
      if (name === 'spice_measure') {
        const measured = measureResult(result, measurements as unknown[]);
        enforceMaximum('maxSerializedResultBytes', effective.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(measured)), 'transport');
        return success(measured, diagnostics);
      }
      return success(result, diagnostics);
    } finally {
      release();
    }
  } catch (error) {
    if (isApiError(error) && impedanceErrorCodes.includes(error.details.impedanceCode as typeof impedanceErrorCodes[number])) {
      const local = { error: { ...error, code: error.details.impedanceCode } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(local) }], structuredContent: local };
    }
    if (error instanceof ParameterOverrideError) return failure(error.apiError);
    return failure(publicError(error));
  }
}

interface StreamReadArgs {
  jobId: string;
  cursor: string;
  maxPoints: number;
}

interface StreamJob {
  request: SimulationRequestV1;
  plan: RequestPlan;
  state:
    | { status: 'pending' }
    | { status: 'ready'; result: SimulationResultV1 }
    | { status: 'failed'; error: SpiceApiErrorV1 };
  controller: AbortController;
  cursorOffsets: Map<string, number>;
  replay: Map<string, SimulationReadDataV1>;
  events: SimulationEventV1[];
  eventBaseOffset: number;
  unreadBytes: number;
  emitted: SimulationEventV1[];
  producedPointCount: number;
  liveEventsProduced: boolean;
  /**
   * Events of a finished, non-live result not yet admitted to the unread window. They are
   * produced lazily and admitted in cap-sized batches as reads drain `events` (#794).
   */
  backlog?: { source: Iterator<SimulationEventV1>; pending?: { event: SimulationEventV1; bytes: number } };
  releaseBatch?: () => void;
  batchEndOffset?: number;
  terminal?: SimulationReadDataV1;
  startedAt: number;
  terminalAt?: number;
  runningTimer?: unknown;
  terminalTimer?: unknown;
}

class StreamStore {
  private readonly jobs = new Map<string, StreamJob>();
  private nextJobId = 1;
  private runningOneShots = 0;

  private readonly limits: McpStreamLimits;

  constructor(
    limits: Partial<McpStreamLimits> = {},
    private readonly clock: StreamClock = systemClock,
  ) {
    this.limits = { ...DEFAULT_MCP_STREAM_LIMITS, ...limits };
  }

  capabilities(): typeof capabilities {
    return {
      ...capabilities,
      streaming: { ...capabilities.streaming, ...this.limits },
    } as typeof capabilities;
  }

  start(
    request: SimulationRequestV1,
    plan: RequestPlan,
    limits: McpLimits,
    options: ToolExecutionOptions,
  ): JsonObject {
    const evictable = this.jobs.size >= MAX_RETAINED_STREAM_JOBS
      ? [...this.jobs].find(([, job]) => job.terminal !== undefined)
      : undefined;
    if (this.jobs.size >= MAX_RETAINED_STREAM_JOBS && !evictable) {
      throw apiError('RESOURCE_LIMIT', 'The retained stream-job limit was exceeded', 'transport', {
        limit: 'maxRetainedStreamJobs', maximum: MAX_RETAINED_STREAM_JOBS,
        actual: this.jobs.size + 1,
      });
    }
    // Check the running quota before evicting, so a rejected start leaves retained jobs intact.
    this.enforceConcurrentJobs();
    if (evictable) this.delete(evictable[0], evictable[1]);
    const jobId = `job-${this.nextJobId++}`;
    const cursor = streamCursor(jobId, 0);
    const job: StreamJob = {
      request,
      plan,
      state: { status: 'pending' },
      controller: new AbortController(),
      cursorOffsets: new Map([[cursor, 0]]),
      replay: new Map(),
      events: [],
      eventBaseOffset: 0,
      unreadBytes: 0,
      emitted: [],
      producedPointCount: 0,
      liveEventsProduced: false,
      startedAt: this.clock.now(),
    };
    this.jobs.set(jobId, job);
    job.runningTimer = this.clock.setTimeout(
      () => this.expireRunning(jobId, job),
      this.limits.runningJobTtlMs,
    );
    void this.solve(jobId, job, limits, options);
    return { jobId, status: 'running', cursor };
  }

  /** Reserve a running slot for a one-shot `spice_simulate`; call the returned release exactly once. */
  acquireOneShotSlot(): () => void {
    this.enforceConcurrentJobs();
    this.runningOneShots++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.runningOneShots--;
    };
  }

  /**
   * A job holds a running slot from start until it turns terminal (completion, failure,
   * cancellation or running-TTL expiry); unread terminal data does not hold a slot.
   */
  private runningJobs(): number {
    let running = this.runningOneShots;
    for (const job of this.jobs.values()) if (job.terminalAt === undefined) running++;
    return running;
  }

  private enforceConcurrentJobs(): void {
    const configured = this.limits.maxConcurrentJobs;
    const observed = this.runningJobs() + 1;
    if (observed > configured) {
      throw {
        ...apiError('RESOURCE_LIMIT', 'The concurrent running-job limit was exceeded', 'transport', {
          limit: 'maxConcurrentJobs', configured, observed, maximum: configured, actual: observed,
        }),
        retryable: true,
      } satisfies SpiceApiErrorV1;
    }
  }

  read(args: StreamReadArgs): SimulationReadDataV1 {
    const job = this.job(args.jobId);
    const offset = job.cursorOffsets.get(args.cursor);
    if (offset === undefined) {
      throw apiError('INVALID_REQUEST', 'The stream cursor is invalid for this job', 'validation', {});
    }
    const replay = job.replay.get(args.cursor);
    if (replay) return replay;
    if (job.terminal) return job.terminal;
    const eventEndOffset = job.eventBaseOffset + job.events.length;
    if (job.state.status === 'pending' && offset >= eventEndOffset) {
      return { status: 'running', events: [], nextCursor: args.cursor };
    }

    const events: SimulationEventV1[] = [];
    let pointCount = 0;
    let nextOffset = offset;
    while (nextOffset < eventEndOffset) {
      const event = job.events[nextOffset - job.eventBaseOffset]!;
      if (event.type === 'point' && pointCount >= args.maxPoints) break;
      events.push(event);
      nextOffset++;
      if (event.type === 'point') {
        pointCount++;
        if (pointCount === args.maxPoints) break;
      }
    }
    job.emitted.push(...events);
    const consumedCount = nextOffset - job.eventBaseOffset;
    if (consumedCount > 0) {
      const consumed = job.events.splice(0, consumedCount);
      job.unreadBytes -= serializedEventBytes(consumed);
      job.eventBaseOffset = nextOffset;
    }
    if (job.backlog && consumedCount > 0) {
      try {
        this.admitBacklog(job);
      } catch (error) {
        job.backlog = undefined;
        job.state = { status: 'failed', error: publicError(error) };
      }
    }
    if (events.length > 0 && job.batchEndOffset !== undefined && nextOffset >= job.batchEndOffset) {
      job.releaseBatch?.();
      job.releaseBatch = undefined;
      job.batchEndOffset = undefined;
    }

    let data: SimulationReadDataV1;
    if (nextOffset < job.eventBaseOffset + job.events.length || job.state.status === 'pending') {
      const nextCursor = streamCursor(args.jobId, nextOffset);
      job.cursorOffsets.set(nextCursor, nextOffset);
      data = { status: 'running', events, nextCursor };
    } else if (job.state.status === 'failed') {
      data = failureRead(args.jobId, job.emitted, job.state.error, events);
      job.terminal = data;
    } else {
      data = {
        status: 'complete', events, nextCursor: null,
        terminal: successTerminal(args.jobId, job.request, job.plan, job.state.result),
      };
      job.terminal = data;
    }
    job.replay.set(args.cursor, data);
    return data;
  }

  comparisonResult(jobId: string): SimulationResultV1 {
    const job = this.job(jobId);
    if (job.terminal && job.terminal.status !== 'complete') throw apiError('INVALID_REQUEST', 'Job did not complete successfully', 'validation', {});
    if (job.state.status !== 'ready') throw apiError('INVALID_REQUEST', 'Job result is not ready; read the job to completion first', 'validation', {});
    return job.state.result;
  }

  cancel(jobId: string): SimulationReadDataV1 {
    const job = this.job(jobId);
    if (job.terminal) return job.terminal;
    job.controller.abort();
    job.releaseBatch?.();
    job.releaseBatch = undefined;
    job.backlog = undefined;
    job.events = [];
    job.unreadBytes = 0;
    const data = failureRead(jobId, job.emitted, {
      code: 'CANCELLED', message: 'The simulation job was cancelled',
      retryable: true, phase: 'solve', details: {},
    });
    job.terminal = data;
    this.enterTerminal(jobId, job);
    return data;
  }

  private async solve(
    jobId: string,
    job: StreamJob,
    limits: McpLimits,
    options: ToolExecutionOptions,
  ): Promise<void> {
    const solveOptions = { ...options, signal: job.controller.signal };
    try {
      const result = options.simulate
        ? await boundedCall(() => options.simulate!(job.request), limits.maxWallTimeMs, job.controller.signal)
        : await runStreamingWorker(job.request, limits.maxWallTimeMs, solveOptions, events => {
          const producedPointCount = job.producedPointCount
            + events.filter(event => event.type === 'point').length;
          enforceMaximum(
            'maxResultPoints', limits.maxResultPoints, producedPointCount, 'solve',
          );
          this.retainEvents(events, job);
          job.liveEventsProduced = true;
          job.producedPointCount = producedPointCount;
          job.batchEndOffset = job.eventBaseOffset + job.events.length;
          return new Promise<void>(resolve => { job.releaseBatch = resolve; });
        });
      enforceResultBounds(result, limits);
      if (!job.terminal) {
        if (!job.liveEventsProduced) {
          job.backlog = { source: resultEvents(result) };
          this.admitBacklog(job);
        }
        job.state = { status: 'ready', result };
        this.enterTerminal(jobId, job);
      }
    } catch (error) {
      if (!job.terminal) {
        const publicFailure = publicError(error);
        job.state = { status: 'failed', error: publicFailure };
        if (job.events.length === 0) job.terminal = failureRead(jobId, job.emitted, publicFailure);
        this.enterTerminal(jobId, job);
      }
    }
  }

  private retainEvents(events: SimulationEventV1[], job: StreamJob): void {
    const unreadEvents = job.events.length + events.length;
    enforceStreamMaximum('maxUnreadEvents', this.limits.maxUnreadEvents, unreadEvents);
    const unreadBytes = job.unreadBytes + serializedEventBytes(events);
    enforceStreamMaximum('maxUnreadBytes', this.limits.maxUnreadBytes, unreadBytes);
    job.events.push(...events);
    job.unreadBytes = unreadBytes;
  }

  /**
   * Move backlog events into the unread window while both unread caps still hold. A finished
   * result is already bounded by `maxResultPoints`/`maxSerializedResultBytes`; the caps here only
   * bound how much of it is materialised as unread events at once. An event that cannot fit even
   * into an empty window fails the job, as an over-limit live batch does.
   */
  private admitBacklog(job: StreamJob): void {
    const backlog = job.backlog;
    if (!backlog) return;
    for (;;) {
      let pending = backlog.pending;
      if (!pending) {
        const next = backlog.source.next();
        if (next.done) {
          job.backlog = undefined;
          return;
        }
        pending = { event: next.value, bytes: serializedEventBytes([next.value]) };
      }
      const fits = job.events.length + 1 <= this.limits.maxUnreadEvents
        && job.unreadBytes + pending.bytes <= this.limits.maxUnreadBytes;
      if (!fits) {
        if (job.events.length === 0) this.retainEvents([pending.event], job);
        backlog.pending = pending;
        return;
      }
      backlog.pending = undefined;
      job.events.push(pending.event);
      job.unreadBytes += pending.bytes;
    }
  }

  private expireRunning(jobId: string, job: StreamJob): void {
    if (this.jobs.get(jobId) !== job || job.terminalAt !== undefined) return;
    job.controller.abort();
    job.releaseBatch?.();
    job.releaseBatch = undefined;
    job.backlog = undefined;
    job.events = [];
    job.unreadBytes = 0;
    const error = apiError(
      'RESOURCE_LIMIT', 'The simulation job TTL was exceeded', 'transport',
      {
        limit: 'runningJobTtlMs', maximum: this.limits.runningJobTtlMs,
        actual: this.clock.now() - job.startedAt,
      },
    );
    job.state = { status: 'failed', error };
    job.terminal = failureRead(jobId, job.emitted, error);
    this.enterTerminal(jobId, job);
  }

  private enterTerminal(jobId: string, job: StreamJob): void {
    if (job.terminalAt !== undefined) return;
    job.terminalAt = this.clock.now();
    if (job.runningTimer !== undefined) this.clock.clearTimeout(job.runningTimer);
    job.runningTimer = undefined;
    job.terminalTimer = this.clock.setTimeout(
      () => this.delete(jobId, job),
      this.limits.terminalJobTtlMs,
    );
  }

  private delete(jobId: string, job: StreamJob): void {
    if (this.jobs.get(jobId) !== job) return;
    if (job.runningTimer !== undefined) this.clock.clearTimeout(job.runningTimer);
    if (job.terminalTimer !== undefined) this.clock.clearTimeout(job.terminalTimer);
    job.controller.abort();
    job.releaseBatch?.();
    this.jobs.delete(jobId);
  }

  private job(jobId: string): StreamJob {
    const job = this.jobs.get(jobId);
    if (!job) throw apiError('INVALID_REQUEST', 'The simulation job was not found', 'validation', {});
    return job;
  }
}

type McpFailedReadV1 = Omit<Extract<ProtocolReadDataV1, { status: 'failed' | 'cancelled' }>, 'terminal'> & {
  terminal: Omit<Extract<ProtocolReadDataV1, { status: 'failed' | 'cancelled' }>['terminal'], 'error'> & {
    error: SpiceApiErrorV1;
  };
};
type SimulationReadDataV1 = Exclude<ProtocolReadDataV1, { status: 'failed' | 'cancelled' }> | McpFailedReadV1;

function failureRead(
  jobId: string,
  emitted: SimulationEventV1[],
  error: SpiceApiErrorV1,
  events: SimulationEventV1[] = [],
): McpFailedReadV1 {
  const terminal: McpFailedReadV1['terminal'] = {
    apiVersion: '1', ok: false, requestId: jobId,
    error,
    diagnostics: [],
    partial: {
      status: 'partial',
      analyses: partialAnalyses(emitted),
      partialEventSha256: sha256CanonicalJson(emitted.filter(event => event.type === 'point')),
    },
  };
  return {
    status: error.code === 'CANCELLED' ? 'cancelled' : 'failed',
    events, nextCursor: null, terminal,
  };
}

const systemClock: StreamClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function serializedEventBytes(events: SimulationEventV1[]): number {
  return events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
}

function enforceStreamMaximum(
  limit: 'maxUnreadEvents' | 'maxUnreadBytes',
  maximum: number,
  actual: number,
): void {
  if (actual > maximum) {
    throw apiError('RESOURCE_LIMIT', 'A configured stream retention limit was exceeded', 'transport', {
      limit, maximum, actual,
    });
  }
}

const defaultStreamStore = new StreamStore();

function streamReadArgs(args: unknown): StreamReadArgs {
  if (!isRecord(args) || typeof args.jobId !== 'string' || typeof args.cursor !== 'string') {
    throw apiError('INVALID_REQUEST', "Expected 'jobId' and 'cursor' strings", 'validation', {});
  }
  const maxPoints = args.maxPoints ?? DEFAULT_STREAM_CHUNK_POINTS;
  if (!Number.isInteger(maxPoints) || (maxPoints as number) <= 0) {
    throw apiError('INVALID_REQUEST', "'maxPoints' must be a positive integer", 'validation', {});
  }
  enforceMaximum('maxStreamChunkPoints', MAX_STREAM_CHUNK_POINTS, maxPoints as number, 'transport');
  return { jobId: args.jobId, cursor: args.cursor, maxPoints: maxPoints as number };
}

function streamCancelArgs(args: unknown): string {
  if (!isRecord(args) || typeof args.jobId !== 'string') {
    throw apiError('INVALID_REQUEST', "Expected a 'jobId' string", 'validation', {});
  }
  return args.jobId;
}

function streamCursor(jobId: string, offset: number): string {
  return Buffer.from(`${jobId}:${offset}`, 'utf8').toString('base64url');
}

/** Lazily derive the stream events of a finished result, so only the unread window is materialised. */
function* resultEvents(result: SimulationResultV1): Generator<SimulationEventV1, void, undefined> {
  for (const analysis of result.analyses) {
    const common = { analysisIndex: analysis.analysisIndex, ...(analysis.step ? { step: analysis.step } : {}) };
    yield { type: 'analysis-start', analysis: analysis.type, ...common };
    let pointCount = 0;
    if (analysis.type !== 'op') {
      pointCount = analysisPointCount(analysis);
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        yield { type: 'point', ...common, pointIndex, point: analysisPoint(analysis, pointIndex) };
      }
    }
    yield { type: 'analysis-end', analysis: analysis.type, ...common, pointCount };
  }
}

type PointAnalysisV1 = Exclude<AnalysisResultV1, { type: 'op' }>;

function analysisPointCount(analysis: PointAnalysisV1): number {
  switch (analysis.type) {
    case 'dc': return analysis.axis.values.length;
    case 'tran': return analysis.timeS.length;
    case 'ac': return analysis.frequencyHz.length;
  }
}

function analysisPoint(
  analysis: PointAnalysisV1,
  index: number,
): Extract<SimulationEventV1, { type: 'point' }>['point'] {
  switch (analysis.type) {
    case 'dc': return {
      type: 'dc', axis: { name: analysis.axis.name, unit: analysis.axis.unit, value: analysis.axis.values[index]! },
      voltagesV: indexedRecord(analysis.voltagesV, index), currentsA: indexedRecord(analysis.currentsA, index),
    };
    case 'tran': return {
      type: 'tran', timeS: analysis.timeS[index]!,
      voltagesV: indexedRecord(analysis.voltagesV, index), currentsA: indexedRecord(analysis.currentsA, index),
    };
    case 'ac': return {
      type: 'ac', frequencyHz: analysis.frequencyHz[index]!,
      voltagePhasors: indexedRecord(analysis.voltagePhasors, index),
      currentPhasors: indexedRecord(analysis.currentPhasors, index),
    };
  }
}

function indexedRecord<T>(record: Record<string, T[]>, index: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, values]) => [key, values[index]!]));
}

function partialAnalyses(events: SimulationEventV1[]): PartialAnalysisV1[] {
  const analyses = new Map<string, PartialAnalysisV1>();
  for (const event of events) {
    if (event.type === 'diagnostic') continue;
    const key = `${event.analysisIndex}:${event.step?.index ?? ''}`;
    if (event.type === 'analysis-start' && event.analysis !== 'op') {
      analyses.set(key, {
        analysis: event.analysis, analysisIndex: event.analysisIndex,
        ...(event.step ? { step: event.step } : {}), emittedPointCount: 0, complete: false,
      });
    } else if (event.type === 'point') {
      const analysis = analyses.get(key);
      if (analysis) analysis.emittedPointCount++;
    } else if (event.type === 'analysis-end') {
      const analysis = analyses.get(key);
      if (analysis) analysis.complete = true;
    }
  }
  return [...analyses.values()];
}

function successTerminal(
  requestId: string,
  request: SimulationRequestV1,
  plan: RequestPlan,
  result: SimulationResultV1,
): SuccessEnvelopeV1<SimulationResultV1> {
  return {
    apiVersion: '1', ok: true, requestId, data: result, diagnostics: [],
    metadata: runMetadata(request, plan, sha256CanonicalJson(result)),
  };
}

function runMetadata(request: SimulationRequestV1, plan: RequestPlan, resultSha256: string): RunMetadataV1 {
  return {
    protocolVersion: '1',
    ...(request.input.format === 'spice-ts' ? { nativeSchemaVersion: '1.0' as const } : {}),
    spiceTsVersion: PACKAGE_VERSION,
    engineBuildId: ENGINE_BUILD_ID,
    backend: 'spice-ts-js',
    backendVersion: PACKAGE_VERSION,
    resolvedOptions: resolvedOptions(request, plan),
    inputSha256: sha256CanonicalJson(request.input),
    resultSha256,
    runtime: { family: 'node', version: process.versions.node },
    architecture: process.arch,
    determinism: request.options?.determinism ?? 'strict',
  };
}

function effectiveLimits(request: SimulationRequestV1, configured: McpLimits): McpLimits {
  const requested = request.options?.limits;
  return {
    maxDocumentBytes: Math.min(requested?.maxSourceBytes ?? configured.maxDocumentBytes, configured.maxDocumentBytes),
    maxAnalyses: Math.min(requested?.maxAnalyses ?? configured.maxAnalyses, configured.maxAnalyses),
    maxResultPoints: Math.min(requested?.maxResultPoints ?? configured.maxResultPoints, configured.maxResultPoints),
    maxSerializedResultBytes: Math.min(requested?.maxSerializedResultBytes ?? configured.maxSerializedResultBytes, configured.maxSerializedResultBytes),
    maxWallTimeMs: Math.min(requested?.maxWallTimeMs ?? configured.maxWallTimeMs, configured.maxWallTimeMs),
  };
}

const validatePoleZeroInput = new AjvJsonSchemaValidator().getValidator({
  ...commonSchemaV1.$defs.simulationInput, $defs: commonSchemaV1.$defs,
});
const validateMetricsRequest = new AjvJsonSchemaValidator().getValidator({
  ...commonSchemaV1.$defs.simulationRequest, $defs: commonSchemaV1.$defs,
});

function toolRequest(args: unknown): SimulationRequestV1 {
  if (!isRecord(args) || !isRecord(args.request)) {
    throw apiError('INVALID_REQUEST', "Expected an object containing 'request'", 'validation', {});
  }
  const request = args.request;
  if (request.apiVersion !== '1' || !isRecord(request.input)) {
    throw apiError('INVALID_REQUEST', 'Expected a protocol-v1 simulation request', 'validation', {});
  }
  const format = request.input.format;
  if (format !== 'spice' && format !== 'spice-ts' && format !== 'circuit-json') {
    throw apiError('UNSUPPORTED_FEATURE', 'The requested input format is unavailable', 'validation', {});
  }
  if (isRecord(request.options) && request.options.backend !== undefined && request.options.backend !== 'spice-ts-js') {
    throw apiError('BACKEND_UNAVAILABLE', 'The requested simulation backend is unavailable', 'validation', {});
  }
  if (isRecord(request.options) && !validMaxTimestep(request.options.maxTimestep)) {
    throw apiError('INVALID_REQUEST', "'maxTimestep' must be a positive finite number or 0 (unset)", 'validation', {
      option: 'maxTimestep',
    });
  }
  return request as unknown as SimulationRequestV1;
}

/** Standalone circuit conversion does not solve or infer missing device models. */
function convertTool(args: unknown, limits: McpLimits, signal?: AbortSignal): CallToolResult {
  if (!isRecord(args) || Object.keys(args).length !== 1
    || !(typeof args.netlist === 'string' || Array.isArray(args.circuitJson))) {
    throw apiError('INVALID_REQUEST', 'Expected exactly one of netlist (string) or circuitJson (array)', 'validation', {});
  }
  enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, Buffer.byteLength(JSON.stringify(args)), 'validation');
  throwIfCancelled(signal);
  let output: object;
  if (typeof args.netlist === 'string') {
    const converted = toCircuitJSON(parseTitleless(args.netlist).toIR());
    const diagnostics = converted.diagnostics.map(diagnostic => ({
      ...diagnostic,
      severity: 'error' as const,
      code: diagnostic.path.includes('/params/') ? 'UNSUPPORTED_PARAMETER' as const : 'UNSUPPORTED_ELEMENT' as const,
    }));
    requireConversion(converted.value, diagnostics);
    output = { circuitJson: converted.value, diagnostics, lossy: false };
  } else {
    const converted = fromCircuitJSON(args.circuitJson as CircuitJSON);
    requireConversion(converted.value, converted.diagnostics);
    const circuit = new Circuit();
    for (const component of converted.value!.components) {
      // Circuit JSON has no SPICE model cards. Never invent transistor models.
      if (component.type !== 'R' && component.type !== 'C' && component.type !== 'V') {
        throw apiError('UNSUPPORTED_ELEMENT', 'SPICE export requires a model unavailable in circuit-json', 'validation', {
          diagnostics: [{ severity: 'error', code: 'UNSUPPORTED_ELEMENT', message: 'SPICE export requires an explicit model', path: '/', elementId: component.id, simulationRelevant: true }],
        });
      }
      if (!new RegExp(`^${component.type}[^\\s;*$()=,]*$`, 'i').test(component.name)
        || component.ports.some(port => !/^[^\s;*$()=,]+$/.test(port.net))) {
        throw apiError('INVALID_CIRCUIT', 'Circuit identifiers cannot be serialized as SPICE tokens', 'validation', {
          diagnostics: [{ severity: 'error', code: 'UNSUPPORTED_PARAMETER', message: 'Invalid SPICE identifier', path: '/', elementId: component.id, simulationRelevant: true }],
        });
      }
      const port = (name: string) => component.ports.find(port => port.name === name)!.net;
      if (component.type === 'R') circuit.addResistor(component.name, port('p'), port('n'), component.params.resistance as number);
      else if (component.type === 'C') circuit.addCapacitor(component.name, port('p'), port('n'), component.params.capacitance as number);
      else if (component.params.waveform === 'sin') {
        circuit.addVoltageSource(component.name, port('p'), port('n'), {
          type: 'sin', offset: component.params.offset as number,
          amplitude: component.params.amplitude as number, frequency: component.params.frequency as number,
          delay: 0, damping: 0, phase: component.params.phase as number,
        });
      } else circuit.addVoltageSource(component.name, port('p'), port('n'), { dc: component.params.dc as number });
    }
    output = { netlist: circuit.toNetlist(), diagnostics: converted.diagnostics, lossy: false };
  }
  enforceMaximum('maxSerializedResultBytes', limits.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(output)), 'serialize');
  return success(output);
}

function requireConversion(value: unknown, diagnostics: ConversionDiagnosticV1[]): void {
  if (value !== undefined) return;
  const first = diagnostics.find(diagnostic => diagnostic.severity === 'error')!;
  throw apiError(first.code === 'UNSUPPORTED_ELEMENT' ? 'UNSUPPORTED_ELEMENT' : 'INVALID_CIRCUIT', first.message, 'validation', {
    diagnostics: diagnostics.map(diagnostic => ({ ...diagnostic })),
  });
}

/** Convert once at the MCP boundary; core and isolated workers consume native documents. */
function convertRequest(request: SimulationRequestV1): {
  request: SimulationRequestV1;
  diagnostics?: ConversionDiagnosticV1[];
} {
  if (request.input.format !== 'circuit-json') return { request };
  if (!Array.isArray(request.input.circuit) || !Array.isArray(request.input.analyses)) {
    throw apiError('INVALID_REQUEST', 'circuit-json requires circuit and analyses arrays', 'validation', {});
  }
  const converted = fromCircuitJSON(request.input.circuit as CircuitJSON);
  requireConversion(converted.value, converted.diagnostics);
  return {
    request: {
      ...request,
      input: {
        format: 'spice-ts',
        document: {
          format: 'spice-ts', schemaVersion: '1.0', circuit: converted.value!,
          analyses: request.input.analyses, models: [], subcircuits: [],
          ...(request.input.poleZeroAnalyses !== undefined ? { poleZeroAnalyses: request.input.poleZeroAnalyses } : {}),
        },
      },
    },
    diagnostics: converted.diagnostics,
  };
}

/** Core's rule for `maxTimestep`: unset, 0 (unset, as in ngspice), or positive and finite. */
function validMaxTimestep(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function boundedRequest(request: SimulationRequestV1, limits: McpLimits): SimulationRequestV1 {
  const requested = request.options?.limits;
  return {
    ...request,
    options: {
      ...request.options,
      backend: 'spice-ts-js',
      limits: {
        ...requested,
        maxSourceBytes: Math.min(requested?.maxSourceBytes ?? limits.maxDocumentBytes, limits.maxDocumentBytes),
        maxAnalyses: Math.min(requested?.maxAnalyses ?? limits.maxAnalyses, limits.maxAnalyses),
        maxResultPoints: Math.min(requested?.maxResultPoints ?? limits.maxResultPoints, limits.maxResultPoints),
        maxSerializedResultBytes: Math.min(requested?.maxSerializedResultBytes ?? limits.maxSerializedResultBytes, limits.maxSerializedResultBytes),
        maxWallTimeMs: Math.min(requested?.maxWallTimeMs ?? limits.maxWallTimeMs, limits.maxWallTimeMs),
      },
    },
  };
}

async function boundedRequestPlan(request: SimulationRequestV1, limits: McpLimits): Promise<RequestPlan> {
  const documentBytes = Buffer.byteLength(JSON.stringify(request.input));
  enforceMaximum('maxDocumentBytes', limits.maxDocumentBytes, documentBytes, 'validation');

  const plan = await requestPlan(request);
  enforceMaximum('maxAnalyses', limits.maxAnalyses, plan.analyses.length, 'validation');
  enforceMaximum('maxResultPoints', limits.maxResultPoints, estimatedResultPoints(request, plan), 'validation');
  return plan;
}

function enforceResultBounds(result: SimulationResultV1, limits: McpLimits): void {
  let points = 0;
  for (const analysis of result.analyses) {
    switch (analysis.type) {
      case 'op': points += 1; break;
      case 'dc': points += analysis.axis.values.length; break;
      case 'tran': points += analysis.timeS.length; break;
      case 'ac': points += analysis.frequencyHz.length; break;
    }
  }
  enforceMaximum('maxResultPoints', limits.maxResultPoints, points, 'serialize');
  enforceMaximum('maxSerializedResultBytes', limits.maxSerializedResultBytes, Buffer.byteLength(JSON.stringify(result)), 'serialize');
}

function enforceMaximum(
  limit: keyof McpLimits | 'maxStreamChunkPoints',
  maximum: number,
  actual: number,
  phase: SpiceApiErrorV1['phase'],
): void {
  if (actual > maximum) {
    throw apiError('RESOURCE_LIMIT', 'A configured resource limit was exceeded', phase, { limit, maximum, actual });
  }
}

async function boundedCall<T>(operation: () => Promise<T>, wallTimeMs: number, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(apiError(
      'RESOURCE_LIMIT',
      'The simulation wall-time limit was exceeded',
      'solve',
      { limit: 'maxWallTimeMs', maximum: wallTimeMs },
    )), wallTimeMs);
  });
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(cancelledError());
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation(), timeoutPromise, cancellationPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  }
}

const workerSource = String.raw`
const { parentPort } = require('node:worker_threads');

const compareCodePoints = (left, right) => {
  const a = Array.from(left, character => character.codePointAt(0));
  const b = Array.from(right, character => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};

const sortedMap = (values, convert = value => value) => Object.fromEntries(
  [...values.entries()].sort(([left], [right]) => compareCodePoints(left, right))
    .map(([name, value]) => [name, convert(value)]),
);

const pointEvent = (point, common, pointIndex) => 'time' in point
  ? {
    type: 'point', ...common, pointIndex,
    point: {
      type: 'tran', timeS: point.time,
      voltagesV: sortedMap(point.voltages), currentsA: sortedMap(point.currents),
    },
  }
  : {
    type: 'point', ...common, pointIndex,
    point: {
      type: 'ac', frequencyHz: point.frequency,
      voltagePhasors: sortedMap(point.voltages, value => ({
        magnitude: value.magnitude, phaseDegrees: value.phase,
      })),
      currentPhasors: sortedMap(point.currents, value => ({
        magnitude: value.magnitude, phaseDegrees: value.phase,
      })),
    },
  };

const coreOptions = options => ({
  simulator: options?.backend === 'ngspice-wasm' ? 'ngspice-wasm' : 'spice-ts',
  abstol: options?.abstol,
  vntol: options?.vntol,
  reltol: options?.reltol,
  maxIterations: options?.maxIterations,
  maxTransientIterations: options?.maxTransientIterations,
  maxTimestep: options?.maxTimestep,
  integrationMethod: options?.integrationMethod,
  trtol: options?.trtol,
  gmin: options?.gmin,
});

const sendEvents = events => new Promise(resolve => {
  parentPort.once('message', resolve);
  parentPort.postMessage({ type: 'events', events });
});

async function streamProtocol(core, request) {
  if (request.input.format !== 'spice') return;
  const files = request.input.virtualFiles ?? {};
  const circuit = await core.parseTitlelessAsync(request.input.source, async path => {
    const source = files[path];
    if (source === undefined) throw new Error('A virtual include was not provided');
    return source;
  });
  const analyses = [...circuit.analyses];
  if (!analyses.every(analysis => analysis.type === 'tran' || analysis.type === 'ac')) return;
  const hasSteps = circuit.compile().steps.length > 0;

  for (let analysisIndex = 0; analysisIndex < analyses.length; analysisIndex++) {
    const analysis = analyses[analysisIndex];
    circuit.analyses.splice(0, circuit.analyses.length, analysis);
    let activeKey;
    let activeCommon;
    let pointIndex = 0;
    let batchPointCount = 0;
    let events = [];
    for await (const entry of core.simulateStepStream(circuit, coreOptions(request.options))) {
      const step = hasSteps
        ? { index: entry.stepIndex, parameter: entry.paramName, value: entry.paramValue }
        : undefined;
      const key = hasSteps ? String(entry.stepIndex) : '';
      const common = { analysisIndex, ...(step ? { step } : {}) };
      if (key !== activeKey) {
        if (activeCommon) {
          events.push({ type: 'analysis-end', analysis: analysis.type, ...activeCommon, pointCount: pointIndex });
        }
        activeKey = key;
        activeCommon = common;
        pointIndex = 0;
        events.push({ type: 'analysis-start', analysis: analysis.type, ...common });
      }
      events.push(pointEvent(entry.point, common, pointIndex++));
      batchPointCount++;
      if (batchPointCount === 2) {
        await sendEvents(events);
        events = [];
        batchPointCount = 0;
      }
    }
    if (activeCommon) {
      events.push({
        type: 'analysis-end', analysis: analysis.type, ...activeCommon, pointCount: pointIndex,
      });
    }
    if (events.length > 0) await sendEvents(events);
  }
}

parentPort.once('message', async ({ operation, request, coreModulePath, sensitivityOutput, tfSelector, impedanceSelector, sparamsSelector }) => {
  const core = require(coreModulePath);
  try {
    if (operation === 'impedance') {
      const { port, sweep } = impedanceSelector;
      const invalid = (message, impedanceCode) => {
        throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: impedanceCode ? { impedanceCode } : {} };
      };
      const node = name => /^(0|gnd)$/i.test(name) ? '0' : name.toLowerCase();
      let result;
      if (request.input.format === 'spice') {
        const files = request.input.virtualFiles || {};
        const circuit = await core.parseTitlelessAsync(request.input.source, async path => {
          if (files[path] === undefined) throw new core.ParseError('Missing virtual include: ' + path, 0, path);
          return files[path];
        });
        const compiled = circuit.compile();
        if (compiled.steps.length || compiled.poleZeroAnalyses.length || circuit.controlScript || /(^|\n)\s*\.control\b/i.test(request.input.source)) invalid('Impedance requires an unstepped deck without control blocks or .pz');
        const names = compiled.nodeNames;
        for (const name of [port.positive, port.negative]) {
          if (name !== '0' && !names.some(n => node(n) === name)) invalid('Unknown port node: ' + name, 'UNKNOWN_NODE');
        }
        for (const device of compiled.devices) {
          if ('waveform' in device) {
            const error = circuit.alterInstance(device.name, 'acmag', [0]);
            if (error) invalid(error);
          }
        }
        const actual = name => name === '0' ? '0' : names.find(n => node(n) === name);
        let source = 'I__spice_impedance';
        const used = new Set(compiled.devices.map(d => d.name.toLowerCase()));
        while (used.has(source.toLowerCase())) source += '_';
        circuit.addCurrentSource(source, actual(port.negative), actual(port.positive), { type: 'ac', magnitude: 1, phase: 0, dc: 0 });
        circuit.analyses.splice(0, circuit.analyses.length, sweep);
        const ac = (await core.simulate(circuit, request.options)).ac;
        const voltage = name => name === '0' ? ac.frequencies.map(() => ({ magnitude: 0, phaseDegrees: 0 }))
          : ac.voltage(actual(name)).map(v => ({ magnitude: v.magnitude, phaseDegrees: v.phase }));
        result = { frequencyHz: ac.frequencies, positive: voltage(port.positive), negative: voltage(port.negative) };
      } else {
        const document = structuredClone(request.input.document);
        const components = document.circuit.components;
        const names = components.flatMap(c => c.ports.map(p => p.net));
        for (const name of [port.positive, port.negative]) {
          if (name !== '0' && !names.some(n => node(n) === name)) invalid('Unknown port node: ' + name, 'UNKNOWN_NODE');
        }
        const actual = name => name === '0' ? '0' : names.find(n => node(n) === name);
        for (const component of [...components, ...document.subcircuits.flatMap(s => s.components)]) {
          if (['V', 'I'].includes(component.type.toUpperCase())) component.params.magnitude = 0;
        }
        let source = 'I__spice_impedance';
        while (components.some(c => c.name.toLowerCase() === source.toLowerCase() || c.id.toLowerCase() === source.toLowerCase())) source += '_';
        components.push({ type: 'I', id: source, name: source, ports: [{ name: 'p', net: actual(port.negative) }, { name: 'n', net: actual(port.positive) }], params: { waveform: 'ac', magnitude: 1, phase: 0, dc: 0 } });
        document.analyses = [sweep];
        const response = await core.simulateProtocolV1({ ...request, input: { format: 'spice-ts', document } });
        const ac = response.analyses[0];
        const voltage = name => name === '0' ? ac.frequencyHz.map(() => ({ magnitude: 0, phaseDegrees: 0 }))
          : ac.voltagePhasors[actual(name)];
        result = { frequencyHz: ac.frequencyHz, positive: voltage(port.positive), negative: voltage(port.negative) };
      }
      parentPort.postMessage({ type: 'result', result });
      return;
    }
    if (operation === 'disto') {
      const files = request.input.virtualFiles || {};
      const circuit = await core.parseTitlelessAsync(request.input.source, async path => {
        if (files[path] === undefined) throw new core.ParseError('Missing virtual include: ' + path, 0, path);
        return files[path];
      });
      const compiled = circuit.compile();
      if (compiled.steps.length || compiled.poleZeroAnalyses.length || circuit.controlScript) {
        parentPort.postMessage({ type: 'error', error: { code: 'UNSUPPORTED_ANALYSIS', message: 'Distortion metrics require an unstepped deck without control blocks or .pz', phase: 'validation', retryable: false, details: {} } });
        return;
      }
      const result = (await core.simulate(circuit, request.options)).distortion;
      // Project through public selectors rather than depending on private result fields.
      const voltageArrays = new Map(result.products.map(product => [product,
        new Map(compiled.nodeNames.map(node => [node, result.voltage(node, product)]))]));
      const currentArrays = new Map(result.products.map(product => [product,
        new Map(compiled.branchNames.map(branch => [branch, result.current(branch, product)]))]));
      parentPort.postMessage({ type: 'result', result: { frequencies: result.frequencies, f2OverF1: result.f2OverF1, voltageArrays, currentArrays } });
      return;
    }
    if (operation === 'sparams') {
      const invalid = message => { throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} }; };
      const circuit = core.parseTitleless(request.input.source);
      const compiled = circuit.compile();
      if (compiled.steps.length || compiled.poleZeroAnalyses.length || circuit.controlScript
        || /(^|\n)\s*\.control\b/i.test(request.input.source)
        || circuit.analyses.length !== 1 || circuit.analyses[0].type !== 'sp') {
        invalid('S-parameters require exactly one .sp analysis without steps, control blocks or conflicting analyses');
      }
      const analysis = circuit.analyses[0];
      const ports = compiled.devices.filter(d => d.port !== undefined);
      if (sparamsSelector.portPair && sparamsSelector.portPair.some(p => p > ports.length)) invalid('Port index exceeds the number of RF ports');
      const frequencies = sparamsSelector.frequenciesHz;
      const count = frequencies ? frequencies.length
        // SP and noise share log grids; noise LIN conservatively counts SP's LIN=2 quirk.
        : core.estimateProtocolResultPointsV1([{ ...analysis, type: 'noise' }], undefined, circuit.simulationOptions.reltol);
      const maximum = request.options.limits.maxResultPoints;
      if (!Number.isFinite(count) || count * ports.length ** 2 > maximum) {
        throw { code: 'RESOURCE_LIMIT', message: 'S-parameter point limit exceeded', phase: 'validation', retryable: false, details: { limit: 'maxResultPoints', maximum } };
      }
      const results = [];
      for (const frequency of frequencies || [undefined]) {
        circuit.analyses.splice(0, 1, frequency === undefined ? { ...analysis, noise: false }
          : { ...analysis, variation: 'lin', points: 1, startFreq: frequency, stopFreq: frequency, noise: false });
        results.push((await core.simulate(circuit, request.options)).sParameters);
      }
      parentPort.postMessage({ type: 'result', result: results });
      return;
    }
    if (operation === 'tf') {
      const circuit = request.input.format === 'spice'
        ? core.parseTitleless(request.input.source) : core.circuitFromDocument(request.input.document);
      const compiled = circuit.compile();
      const analysis = core.parseTitleless('.tf ' + tfSelector.output + ' ' + tfSelector.inputSource).analyses[0];
      const sameAnalysis = a => a.type === 'tf'
        && a.inputSource.toLowerCase() === analysis.inputSource.toLowerCase()
        && (a.outputNode || '').toLowerCase() === (analysis.outputNode || '').toLowerCase()
        && (a.outputReferenceNode || '').toLowerCase() === (analysis.outputReferenceNode || '').toLowerCase()
        && (a.outputSource || '').toLowerCase() === (analysis.outputSource || '').toLowerCase();
      if (compiled.steps.length || compiled.poleZeroAnalyses.length || circuit.controlScript
        || (request.input.format === 'spice' && /(^|\n)\s*\.control\b/i.test(request.input.source))
        || circuit.analyses.length > 1 || circuit.analyses.some(a => !sameAnalysis(a))) {
        throw new core.InvalidCircuitError('Transfer function requires an unstepped deck without control blocks or conflicting analyses');
      }
      // Use protocol preflight for component/expansion limits even though TF has a dedicated result envelope.
      const preflightInput = request.input.format === 'spice'
        ? { ...request.input, source: (circuit.analyses.length ? '' : '.op\n') + request.input.source }
        : { ...request.input, document: { ...request.input.document,
          analyses: circuit.analyses.length ? request.input.document.analyses : [{ type: 'op' }] } };
      await core.validateProtocolV1({ ...request, input: preflightInput });
      circuit.analyses.splice(0, circuit.analyses.length, analysis);
      const result = (await core.simulate(circuit, request.options)).transferFunction;
      parentPort.postMessage({ type: 'result', result });
      return;
    }
    if (operation === 'sensitivity') {
      const circuit = request.input.format === 'spice'
        ? core.parseTitleless(request.input.source) : core.circuitFromDocument(request.input.document);
      const compiled = circuit.compile();
      if (compiled.steps.length || compiled.poleZeroAnalyses.length || circuit.controlScript
        || (request.input.format === 'spice' && /(^|\n)\s*\.control\b/i.test(request.input.source))) {
        throw new core.InvalidCircuitError('Sensitivity requires an unstepped deck without control blocks or .pz');
      }
      const analysis = core.parseTitleless('.sens ' + sensitivityOutput).analyses[0];
      circuit.analyses.splice(0, circuit.analyses.length, analysis);
      // Preflight component/expansion limits without executing discarded deck analyses.
      // Native protocol documents support OP preflight, not the dedicated sensitivity envelope.
      const preflightInput = request.input.format === 'spice'
        ? { format: 'spice', source: circuit.toNetlist() }
        : { ...request.input, document: { ...request.input.document, analyses: [{ type: 'op' }] } };
      await core.validateProtocolV1({ ...request, input: preflightInput });
      const result = (await core.simulate(circuit, request.options)).sensitivity;
      parentPort.postMessage({ type: 'result', result });
      return;
    }
    if (operation === 'stream') await streamProtocol(core, request);
    const result = operation === 'validate'
      ? await core.validateProtocolV1(request, { topologyWarnings: true })
      : operation === 'pz' ? await core.simulatePoleZeroProtocolV1(request)
      : operation === 'noise' ? await core.simulateNoiseProtocolV1(request)
      : operation === 'op-report' ? await core.operatingPointReportProtocolV1(request)
      : await core.simulateProtocolV1(request);
    parentPort.postMessage({ type: 'result', result });
  } catch (error) {
    const mapped = error && error.code === 'INVALID_REQUEST' && error.details ? error : core.mapProtocolErrorV1(error);
    parentPort.postMessage({ type: 'error', error: error instanceof core.SpiceError ? { ...mapped, code: error.code } : mapped });
  }
});
`;

const packageRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
const coreModulePath = packageRequire.resolve('@spice-ts/core');

function createExecutionWorker(): ExecutionWorker {
  return new Worker(workerSource, { eval: true }) as unknown as ExecutionWorker;
}

async function runStreamingWorker(
  request: SimulationRequestV1,
  wallTimeMs: number,
  options: ToolExecutionOptions,
  onEvents: (events: SimulationEventV1[]) => Promise<void>,
): Promise<SimulationResultV1> {
  throwIfCancelled(options.signal);
  const worker = (options.workerFactory ?? createExecutionWorker)();
  return new Promise<SimulationResultV1>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (outcome: () => void, terminateWorker = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (terminateWorker) void Promise.resolve(worker.terminate()).catch(() => undefined);
      outcome();
    };
    const onMessage = (message: WorkerReply) => {
      if (message.type === 'events') {
        if (!message.events) return finish(() => reject(workerFailure()));
        let retained: Promise<void>;
        try {
          retained = onEvents(message.events);
        } catch (error) {
          finish(() => reject(publicError(error)));
          return;
        }
        void retained
          .then(() => { if (!settled) worker.postMessage({ type: 'ack' }); })
          .catch(error => finish(() => reject(publicError(error))));
        return;
      }
      finish(() => {
        if (message.type === 'result') resolve(message.result as SimulationResultV1);
        else reject(message.error ?? workerFailure());
      });
    };
    const onError = () => finish(() => reject(workerFailure()));
    const onExit = () => finish(() => reject(workerFailure()), false);
    const onAbort = () => finish(() => reject(cancelledError()));

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => finish(() => reject(apiError(
      'RESOURCE_LIMIT',
      'The simulation wall-time limit was exceeded',
      'solve',
      { limit: 'maxWallTimeMs', maximum: wallTimeMs },
    ))), wallTimeMs);
    try {
      const message: WorkerRequest = { operation: 'stream', request, coreModulePath };
      worker.postMessage(message);
    } catch {
      finish(() => reject(workerFailure()));
    }
  });
}

async function runInWorker<T>(
  operation: 'validate' | 'simulate' | 'noise' | 'pz' | 'op-report' | 'sensitivity' | 'tf' | 'disto' | 'impedance' | 'sparams',
  request: SimulationRequestV1,
  wallTimeMs: number,
  options: ToolExecutionOptions,
  sensitivityOutput?: string,
  tfSelector?: { output: string; inputSource: string },
  impedanceSelector?: ImpedanceSelectors,
  sparamsSelector?: SparamsArgs,
): Promise<T> {
  throwIfCancelled(options.signal);
  const worker = (options.workerFactory ?? createExecutionWorker)();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (outcome: () => void, terminateWorker = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (terminateWorker) void Promise.resolve(worker.terminate()).catch(() => undefined);
      outcome();
    };
    const onMessage = (message: WorkerReply) => finish(() => {
      if (message.type === 'result') resolve(message.result as T);
      else reject(message.error ?? workerFailure());
    });
    const onError = () => finish(() => reject(workerFailure()));
    const onExit = () => finish(() => reject(workerFailure()), false);
    const onAbort = () => finish(() => reject(cancelledError()));

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => finish(() => reject(apiError(
      'RESOURCE_LIMIT',
      'The simulation wall-time limit was exceeded',
      'solve',
      { limit: 'maxWallTimeMs', maximum: wallTimeMs },
    ))), wallTimeMs);
    try {
      const message: WorkerRequest = { operation, request, coreModulePath, sensitivityOutput, tfSelector, impedanceSelector, sparamsSelector };
      worker.postMessage(message);
    } catch {
      finish(() => reject(workerFailure()));
    }
  });
}

function workerFailure(): SpiceApiErrorV1 {
  return apiError('INTERNAL_ERROR', 'The isolated simulation worker failed', 'transport', {});
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): SpiceApiErrorV1 {
  return apiError('CANCELLED', 'The request was cancelled', 'transport', {});
}

/** MCP preserves core discriminators in addition to protocol-v1 error categories. */
type SpiceApiErrorV1 = Omit<ProtocolApiErrorV1, 'code'> & { code: string };

function publicError(error: unknown): SpiceApiErrorV1 {
  const mapped = isApiError(error) ? error : mapProtocolErrorV1(error);
  return sanitizeError(error instanceof SpiceError ? { ...mapped, code: error.code } : mapped);
}

function sanitizeError(error: SpiceApiErrorV1): SpiceApiErrorV1 {
  return sanitizeValue(error as unknown as JsonValue) as unknown as SpiceApiErrorV1;
}

function sanitizeValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value
      .replaceAll('spice-ts-js', 'simulation backend')
      .replaceAll('spice-ts-wasm', 'simulation backend')
      .replaceAll('ngspice-wasm', 'simulation backend')
      .replaceAll('spice-ts', 'simulation backend');
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]));
  }
  return value;
}

function apiError(
  code: SpiceApiErrorV1['code'],
  message: string,
  phase: SpiceApiErrorV1['phase'],
  details: JsonObject,
): SpiceApiErrorV1 {
  return { code, message, retryable: false, phase, details };
}

function isApiError(error: unknown): error is SpiceApiErrorV1 {
  return isRecord(error)
    && typeof error.code === 'string'
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean'
    && typeof error.phase === 'string'
    && isRecord(error.details);
}

function success(value: object, diagnostics?: ConversionDiagnosticV1[]): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(diagnostics?.length ? { _meta: { conversionDiagnostics: diagnostics } } : {}),
  };
}

function failure(error: SpiceApiErrorV1 | ParameterOverrideApiError): CallToolResult {
  const value = { error };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
