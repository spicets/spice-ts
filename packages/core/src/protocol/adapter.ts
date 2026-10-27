import type {
  AcResultV1,
  AnalysisResultV1,
  NativeAnalysisV1,
  CircuitComponentV1,
  CircuitModelV1,
  ComplexPolarV1,
  DcResultV1,
  JsonObject,
  JsonValue,
  SimulationOptionsV1,
  SimulationRequestV1,
  SimulationResultV1,
  SpiceApiErrorV1,
  SpiceTsCircuitDocumentV1,
  StepCoordinateV1,
  SubcircuitV1,
  TransientResultV1,
} from './types.js';
import { Circuit, type CompiledCircuit } from '../circuit.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { CurrentSource } from '../devices/current-source.js';
import { Resistor } from '../devices/resistor.js';
import { operatingPointReport } from '../op-report.js';
import {
  ConvergenceError,
  CycleError,
  InvalidCircuitError,
  ModelTypeMismatchError,
  ParseError,
  SingularMatrixError,
  SpiceError,
  TimestepTooSmallError,
  UnsupportedCircuitModelTypeError,
} from '../errors.js';
import { parseTitlelessAsync } from '../parser/index.js';
import { VOLTAGE_SOURCE_MULTIPLIER_ERROR } from '../parser/waveform-parser.js';
import type { ACResult, DCSweepResult, DCResult, SimulationResult, StepResult, TransientResult } from '../results.js';
import { simulate } from '../simulate.js';
import type {
  AnalysisCommand, AnalysisDirective, SimulationOptions, SourceWaveform, StepAnalysis, TransferFunctionAnalysis,
} from '../types.js';
import { DEFAULT_OPTIONS } from '../types.js';
import {
  preflightTopology,
  topologyWarnings,
  TopologyPreflightError,
  type TopologySourcePath,
} from '../validation/topology-preflight.js';
import {
  ProtocolExecutionError,
  ProtocolExecutionGuard,
  type ProtocolExecutionOptionsV1,
} from './execution-guard.js';
import { accumulatedLinearPointCount, directedLinearPointCount } from '../analysis/directed-linear-grid.js';
import { frequencyPointCount } from '../analysis/frequency-grid.js';
import { isValidMaxTimestepOption } from '../analysis/max-timestep.js';

const MAX_DETAIL_NAMES = 32;
const API_ERROR_CODES = new Set<SpiceApiErrorV1['code']>([
  'INVALID_REQUEST', 'INVALID_INPUT', 'PARSE_ERROR', 'INVALID_CIRCUIT', 'UNSUPPORTED_FEATURE',
  'SINGULAR_MATRIX', 'CONVERGENCE_FAILED', 'TIMESTEP_TOO_SMALL', 'RESOURCE_LIMIT',
  'CANCELLED', 'BACKEND_UNAVAILABLE', 'INTERNAL_ERROR',
]);
const API_ERROR_PHASES = new Set<SpiceApiErrorV1['phase']>([
  'validation', 'parse', 'compile', 'solve', 'serialize', 'transport',
]);

export interface ProtocolValidationResultV1 {
  status: 'valid';
  nodeCount: number;
  branchCount: number;
  analysisCount: number;
  diagnostics?: import('../validation/topology-preflight.js').TopologyWarning[];
}

/** Parse, compile, and validate topology without assembling or solving a matrix. */
export async function validateProtocolV1(
  request: SimulationRequestV1,
  execution?: ProtocolExecutionOptionsV1 & { topologyWarnings?: boolean },
): Promise<ProtocolValidationResultV1> {
  const guard = protocolGuard(request, execution);
  enforceInputLimits(request, guard);
  const circuit = await requestCircuit(request, guard);
  guard.maximum('maxAnalyses', circuit.analyses.length, 'validation');
  const compiled = circuit.compile(guard);
  enforcePointLimit(circuit.analyses, guard, requestReltol(request, circuit), compiled.steps[0]);
  validateNativeTfOutputs(request, compiled);
  if (compiled.analyses.length === 0) throw new InvalidCircuitError('No analysis command specified');
  if (!execution?.topologyWarnings) preflightTopology(compiled, protocolSourcePath(request));
  const diagnostics = execution?.topologyWarnings ? topologyWarnings(compiled) : [];
  return {
    status: 'valid',
    nodeCount: compiled.nodeCount,
    branchCount: compiled.branchCount,
    analysisCount: compiled.analyses.length,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

/** Native OP readouts using the shared JSON circuit construction path. */
export async function operatingPointReportProtocolV1(request: SimulationRequestV1) {
  const guard = protocolGuard(request);
  enforceInputLimits(request, guard);
  // Preserve OP report semantics: SPICE analysis/control commands are ignored.
  const input = request.input.format === 'spice' ? request.input.source : await requestCircuit(request, guard);
  return operatingPointReport(input, coreOptions(request.options));
}

/** Bounded native pole-zero result, separate from the v1 result/stream union. */
export async function simulatePoleZeroProtocolV1(request: SimulationRequestV1) {
  const guard = protocolGuard(request);
  enforceInputLimits(request, guard);
  const circuit = await requestCircuit(request, guard);
  guard.maximum('maxAnalyses', circuit.analyses.length + circuit.poleZeroAnalyses.length, 'validation');
  if (circuit.poleZeroAnalyses.length !== 1 || circuit.poleZeroAnalyses[0].mode === 'zer') {
    throw new ProtocolExecutionError({
      code: 'INVALID_REQUEST', message: 'Expected exactly one .pz analysis with mode pol or pz (stability requires poles)',
      phase: 'validation', retryable: false, details: {},
    });
  }
  circuit.analyses.splice(0, circuit.analyses.length);
  const compiled = circuit.compile(guard);
  preflightTopology(compiled, protocolSourcePath(request));
  const result = required((await simulate(circuit, coreOptions(request.options), guard)).poleZero, 'pole-zero result');
  guard.maximum('maxResultPoints', result.poles.length + result.zeros.length, 'serialize');
  guard.maximum('maxSerializedResultBytes', utf8Bytes(JSON.stringify(result)), 'serialize');
  return result;
}

/** Bounded noise spectrum for scalar consumers, separate from the v1 result/stream union. */
export async function simulateNoiseProtocolV1(request: SimulationRequestV1) {
  const guard = protocolGuard(request);
  enforceInputLimits(request, guard);
  const circuit = await requestCircuit(request, guard);
  guard.maximum('maxAnalyses', circuit.analyses.length, 'validation');
  const noise = circuit.analyses.filter(a => a.type === 'noise');
  if (noise.length !== 1) throw new ProtocolExecutionError({
    code: 'INVALID_REQUEST', message: 'Expected exactly one .noise analysis',
    phase: 'validation', retryable: false, details: {},
  });
  circuit.analyses.splice(0, circuit.analyses.length, noise[0]);
  const compiled = circuit.compile(guard);
  if (compiled.steps.length) throw new ProtocolExecutionError({
    code: 'INVALID_REQUEST', message: 'Stepped noise analyses must be run separately',
    phase: 'validation', retryable: false, details: {},
  });
  enforcePointLimit(noise, guard, requestReltol(request, circuit));
  preflightTopology(compiled, protocolSourcePath(request));
  const result = required((await simulate(circuit, coreOptions(request.options), guard)).noise, 'noise result');
  guard.maximum('maxResultPoints', result.frequencies.length, 'serialize');
  guard.maximum('maxSerializedResultBytes', utf8Bytes(JSON.stringify(result)), 'serialize');
  return result;
}

/** Execute a protocol-v1 request through the existing core simulator. */
export async function simulateProtocolV1(
  request: SimulationRequestV1,
  execution?: ProtocolExecutionOptionsV1,
): Promise<SimulationResultV1> {
  const guard = protocolGuard(request, execution);
  enforceInputLimits(request, guard);
  const circuit = await requestCircuit(request, guard);
  const analyses = circuit.analyses.map(protocolAnalysis);
  guard.maximum('maxAnalyses', analyses.length, 'validation');
  const preflight = circuit.compile(guard);
  validateNativeTfOutputs(request, preflight);
  enforcePointLimit(analyses, guard, requestReltol(request, circuit), preflight.steps[0]);
  preflightTopology(preflight, protocolSourcePath(request));
  const options = coreOptions(request.options);
  const serialized: AnalysisResultV1[] = [];

  for (let analysisIndex = 0; analysisIndex < analyses.length; analysisIndex++) {
    const analysis = analyses[analysisIndex]!;
    circuit.analyses.splice(0, circuit.analyses.length, analysis);
    const compiled = circuit.compile(guard);
    const result = await simulate(circuit, options, guard);
    const completedBefore = serialized.length;
    appendAnalysisResult(serialized, result, analysis, analysisIndex, compiled.nodeNames, compiled.branchNames, circuit);
    for (const completed of serialized.slice(completedBefore)) execution?.onAnalysisComplete?.(completed);
    guard.checkpoint('serialize:analysis');
    guard.maximum('maxResultPoints', resultPointCount(serialized), 'serialize');
    guard.maximum(
      'maxSerializedResultBytes',
      utf8Bytes(JSON.stringify({ status: 'complete', analyses: serialized } satisfies SimulationResultV1)),
      'serialize',
    );
  }

  circuit.analyses.splice(0, circuit.analyses.length, ...analyses);
  const response: SimulationResultV1 = { status: 'complete', analyses: serialized };
  return response;
}

type ProtocolCoreAnalysis = AnalysisCommand | TransferFunctionAnalysis;

function protocolAnalysis(analysis: AnalysisDirective): ProtocolCoreAnalysis {
  switch (analysis.type) {
    case 'op':
    case 'dc':
    case 'tran':
    case 'ac':
    case 'tf':
      return analysis;
    case 'noise':
    case 'sp':
    case 'disto':
    case 'sens':
      throw new UnsupportedProtocolAnalysisError(analysis.type);
  }
}

class UnsupportedProtocolAnalysisError extends Error {
  constructor(readonly analysis: string) {
    super(`Protocol v1 does not support '${analysis}' analysis results`);
    this.name = 'UnsupportedProtocolAnalysisError';
  }
}

/** Convert an existing typed core error to its stable protocol-v1 representation. */
export function mapProtocolErrorV1(error: unknown): SpiceApiErrorV1 {
  if (isWireApiError(error)) return wireApiError(error);
  if (error instanceof ProtocolExecutionError) return wireApiError(error.apiError);
  if (error instanceof UnsupportedProtocolAnalysisError) {
    return apiError('UNSUPPORTED_FEATURE', error, 'validation', { analysis: error.analysis });
  }
  if (error instanceof ParseError) {
    return apiError('PARSE_ERROR', error, 'parse', { line: error.line, context: error.context });
  }
  if (error instanceof TimestepTooSmallError) {
    return apiError('TIMESTEP_TOO_SMALL', error, 'solve', {
      ...convergenceDetails(error),
      timestep: error.timestep,
    });
  }
  if (error instanceof SingularMatrixError) {
    const details: JsonObject = {
      involvedNodes: error.involvedNodes.slice(0, MAX_DETAIL_NAMES),
      involvedBranches: error.involvedBranches.slice(0, MAX_DETAIL_NAMES),
    };
    if (error.pivotIndex !== undefined) details.pivotIndex = error.pivotIndex;
    return apiError('SINGULAR_MATRIX', error, 'solve', details);
  }
  if (error instanceof ConvergenceError) {
    return apiError('CONVERGENCE_FAILED', error, 'solve', convergenceDetails(error));
  }
  if (error instanceof CycleError) {
    return apiError('INVALID_CIRCUIT', error, 'compile', { chain: error.chain.slice(0, MAX_DETAIL_NAMES) });
  }
  if (error instanceof TopologyPreflightError) {
    return apiError('INVALID_CIRCUIT', error, 'validation', {
      kind: error.kind,
      involvedNodes: error.involvedNodes.slice(0, MAX_DETAIL_NAMES),
      sourcePaths: error.sourcePaths.slice(0, MAX_DETAIL_NAMES),
    });
  }
  if (error instanceof UnsupportedCircuitModelTypeError) {
    return apiError('UNSUPPORTED_FEATURE', error, 'validation', {
      reason: error.code, modelName: error.modelName, modelType: error.modelType,
    });
  }
  if (error instanceof ModelTypeMismatchError) {
    return apiError('INVALID_CIRCUIT', error, 'compile', {
      reason: error.code,
      deviceName: error.deviceName,
      deviceKind: error.deviceKind,
      modelName: error.modelName,
      modelType: error.modelType,
      expectedTypes: [...error.expectedTypes],
    });
  }
  if (error instanceof InvalidCircuitError) {
    return apiError('INVALID_CIRCUIT', error, 'compile', {});
  }
  if (error instanceof SpiceError) {
    return {
      code: 'INTERNAL_ERROR', message: 'Internal simulation error', retryable: false,
      phase: 'solve', details: {},
    };
  }
  return {
    code: 'INTERNAL_ERROR', message: 'Internal simulation error', retryable: false,
    phase: 'solve', details: {},
  };
}

function protocolSourcePath(request: SimulationRequestV1): TopologySourcePath {
  const paths = new Map<string, string>();
  if (request.input.format === 'spice') {
    request.input.source.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('.')) return;
      const name = trimmed.split(/\s+/, 1)[0];
      if (name) paths.set(name.toUpperCase(), `/input/source/lines/${index}`);
    });
  } else if (request.input.format === 'spice-ts') {
    request.input.document.circuit.components.forEach((component, index) => {
      paths.set(component.name.toUpperCase(), `/input/document/circuit/components/${index}`);
    });
  }

  return deviceName => {
    const rootName = deviceName.split('.', 1)[0]!.toUpperCase();
    return paths.get(deviceName.toUpperCase())
      ?? paths.get(rootName)
      ?? `/compiled/devices/${jsonPointerSegment(deviceName)}`;
  };
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

async function requestCircuit(
  request: SimulationRequestV1,
  guard: ProtocolExecutionGuard,
): Promise<Circuit> {
  switch (request.input.format) {
    case 'spice': {
      const files = request.input.virtualFiles ?? {};
      const circuit = await parseTitlelessAsync(request.input.source, async path => {
        const source = files[path];
        if (source === undefined) throw new ParseError(`Virtual include '${path}' was not provided`, 0, path);
        return source;
      }, guard);
      // Interpreted ngspice control scripts run an open-ended analysis sequence
      // that the protocol's per-analysis limits and result envelope cannot bound.
      if (circuit.controlScript) throw new UnsupportedProtocolAnalysisError('.control script');
      return circuit;
    }
    case 'spice-ts':
      return circuitFromDocument(request.input.document);
    case 'circuit-json':
      throw new InvalidCircuitError('circuit-json conversion is owned by @spice-ts/circuit-json and is unavailable in core');
  }
}

function protocolGuard(
  request: SimulationRequestV1,
  execution?: ProtocolExecutionOptionsV1,
): ProtocolExecutionGuard {
  return new ProtocolExecutionGuard(request.options?.limits ?? {}, execution);
}

function enforceInputLimits(request: SimulationRequestV1, guard: ProtocolExecutionGuard): void {
  if (request.input.format === 'spice') {
    const files = request.input.virtualFiles ?? {};
    const sourceBytes = utf8Bytes(request.input.source)
      + Object.values(files).reduce((total, source) => total + utf8Bytes(source), 0);
    guard.maximum('maxSourceBytes', sourceBytes, 'validation');
    guard.maximum('maxVirtualFiles', Object.keys(files).length, 'validation');
    return;
  }
  if (request.input.format === 'spice-ts') {
    guard.maximum(
      'maxComponents',
      request.input.document.circuit.components.length,
      'compile',
    );
  }
  guard.maximum('maxSourceBytes', utf8Bytes(JSON.stringify(request.input)), 'validation');
}

function enforcePointLimit(
  analyses: readonly AnalysisDirective[],
  guard: ProtocolExecutionGuard,
  reltol: number,
  step?: StepAnalysis,
): void {
  guard.maximum('maxResultPoints', estimateProtocolResultPointsV1(analyses, step, reltol), 'validation');
}

/**
 * Result points a protocol run of `analyses` is estimated to produce before
 * solving, multiplied by the sweep count of the optional `.step` directive.
 * This is the count the `maxResultPoints` validation check compares. `reltol`
 * is the run's resolved relative tolerance, which sets ngspice's `.ac` DEC/OCT
 * stop tolerance.
 */
export function estimateProtocolResultPointsV1(
  analyses: readonly AnalysisDirective[],
  step?: StepAnalysis,
  reltol: number = DEFAULT_OPTIONS.reltol,
): number {
  const analysisPoints = analyses.reduce(
    (total, analysis) => total + estimatedAnalysisPoints(analysis, reltol),
    0,
  );
  return analysisPoints * estimatedStepCount(step);
}

function requestReltol(request: SimulationRequestV1, circuit: Circuit): number {
  return request.options?.reltol ?? circuit.simulationOptions.reltol ?? DEFAULT_OPTIONS.reltol;
}

function estimatedStepCount(step?: StepAnalysis): number {
  if (!step) return 1;
  if (step.sweepMode === 'list') return step.values?.length ?? 0;
  const start = step.start;
  const stop = step.stop;
  if (start === undefined || stop === undefined) return 0;
  if (step.sweepMode === 'lin') return finiteLinearPoints(start, stop, step.increment ?? 0);
  const points = step.points ?? 0;
  const span = step.sweepMode === 'dec'
    ? Math.log10(stop / start)
    : Math.log2(stop / start);
  return Number.isFinite(span) ? Math.max(0, Math.floor(span * points + 1 + 1e-12)) : 0;
}

function estimatedAnalysisPoints(analysis: AnalysisDirective, reltol: number): number {
  switch (analysis.type) {
    case 'op':
    case 'tf': return 1;
    case 'dc': {
      const primaryPoints = accumulatedLinearPointCount(analysis.start, analysis.stop, analysis.step);
      const secondaryPoints = analysis.secondary === undefined
        ? 1
        : accumulatedLinearPointCount(
          analysis.secondary.start, analysis.secondary.stop, analysis.secondary.step,
        );
      return primaryPoints * secondaryPoints;
    }
    case 'tran': return finiteLinearPoints(analysis.startTime ?? 0, analysis.stopTime, analysis.timestep);
    case 'ac': return frequencyPointCount(analysis, reltol, 'ac');
    case 'noise': return frequencyPointCount(analysis, reltol, 'noise');
    case 'sp':
    case 'disto': return 0;
    case 'sens': {
      if (analysis.mode === 'dc') return 1;
      return frequencyPointCount(analysis, reltol, 'sens');
    }
  }
}

function finiteLinearPoints(start: number, stop: number, step: number): number {
  return directedLinearPointCount(start, stop, step);
}

function resultPointCount(analyses: readonly AnalysisResultV1[]): number {
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function coreOptions(options?: SimulationOptionsV1): SimulationOptions {
  const backend = options?.backend ?? 'spice-ts-js';
  if (backend === 'spice-ts-wasm') {
    throw new InvalidCircuitError("Protocol backend 'spice-ts-wasm' is not available");
  }
  if (!isValidMaxTimestepOption(options?.maxTimestep)) {
    throw new ProtocolExecutionError({
      code: 'INVALID_REQUEST',
      message: "'maxTimestep' must be a positive finite number or 0 (unset)",
      retryable: false,
      phase: 'validation',
      details: { option: 'maxTimestep' },
    });
  }
  return {
    simulator: backend === 'spice-ts-js' ? 'spice-ts' : 'ngspice-wasm',
    abstol: options?.abstol,
    vntol: options?.vntol,
    reltol: options?.reltol,
    maxIterations: options?.maxIterations,
    maxTransientIterations: options?.maxTransientIterations,
    maxTimestep: options?.maxTimestep,
    integrationMethod: options?.integrationMethod,
    trtol: options?.trtol,
    gmin: options?.gmin,
  };
}

/** Reconstruct a circuit from a validated native protocol document. */
export function circuitFromDocument(document: SpiceTsCircuitDocumentV1): Circuit {
  const circuit = new Circuit();
  for (const model of document.models) circuit.addModel(coreModel(model));
  for (const subcircuit of document.subcircuits) circuit.addSubcircuit(coreSubcircuit(subcircuit));
  for (const [index, component] of document.circuit.components.entries()) {
    if (component.type.toUpperCase() === 'V') {
      for (const field of ['portnum', 'z0']) {
        const value = component.params[field];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
          || field === 'portnum' && !Number.isInteger(value))) invalidNativeField(`/input/document/circuit/components/${index}/params/${field}`);
      }
    }
    addComponent(circuit, component);
  }
  for (const field of ['initialConditions', 'nodesets'] as const) {
    const states = document[field];
    if (states === undefined) continue;
    const path = `/input/document/${field}`;
    if (typeof states !== 'object' || states === null || Array.isArray(states)) invalidNativeField(path);
    const nodes = new Set([...circuit.compile().nodeIndexMap.keys()].map(node => node.toLowerCase()));
    for (const [node, value] of Object.entries(states)) {
      if (typeof value !== 'number' || !Number.isFinite(value)
        || !['0', 'gnd'].includes(node.toLowerCase()) && !nodes.has(node.toLowerCase())) {
        invalidNativeField(`${path}/${node.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      }
      circuit.addInitialState(field === 'initialConditions' ? 'ic' : 'nodeset', { node, value });
    }
  }
  for (const [index, analysis] of document.analyses.entries()) {
    if (analysis.type === 'tran' && analysis.uic !== undefined && analysis.uic !== true) {
      invalidNativeField(`/input/document/analyses/${index}/uic`);
    }
    if (analysis.type === 'dc' && analysis.secondary !== undefined) {
      const path = `/input/document/analyses/${index}/secondary`;
      const secondary = analysis.secondary;
      if (typeof secondary !== 'object' || secondary === null || Array.isArray(secondary)) invalidNativeField(path);
      if (typeof secondary.source !== 'string' || !/^[^\s]+$/.test(secondary.source)) invalidNativeField(`${path}/source`);
      for (const field of ['start', 'stop', 'step'] as const) {
        if (typeof secondary[field] !== 'number' || !Number.isFinite(secondary[field])) invalidNativeField(`${path}/${field}`);
      }
      if (secondary.step === 0 || (secondary.stop > secondary.start && secondary.step < 0)
        || (secondary.stop < secondary.start && secondary.step > 0)) invalidNativeField(`${path}/step`);
      for (const field of Object.keys(secondary)) {
        if (!['source', 'start', 'stop', 'step'].includes(field)) invalidNativeField(`${path}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      }
      const name = secondary.source.toUpperCase();
      if (name === analysis.source.toUpperCase()) invalidNativeField(`${path}/source`);
      const targets = circuit.compile().devices.filter(device => (device instanceof VoltageSource || device instanceof CurrentSource || device instanceof Resistor) && device.name.toUpperCase() === name);
      if (name !== 'TEMP' && targets.length !== 1) invalidNativeField(`${path}/source`);
    }
    if (analysis.type === 'sens') {
      const path = `/input/document/analyses/${index}`;
      if (analysis.mode !== 'dc') invalidNativeField(`${path}/mode`);
      for (const field of ['outputNode', 'outputReferenceNode'] as const) {
        if (field === 'outputReferenceNode' && analysis[field] === undefined) continue;
        if (typeof analysis[field] !== 'string' || !analysis[field].trim()) invalidNativeField(`${path}/${field}`);
      }
      if (analysis.outputType !== undefined && !['voltage', 'current'].includes(analysis.outputType)) invalidNativeField(`${path}/outputType`);
      if (analysis.outputType === 'current' && analysis.outputReferenceNode !== undefined) invalidNativeField(`${path}/outputReferenceNode`);
      for (const field of Object.keys(analysis)) {
        if (!['type', 'mode', 'outputNode', 'outputReferenceNode', 'outputType'].includes(field)) {
          invalidNativeField(`${path}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`);
        }
      }
      // Use expanded nodes/devices rather than potentially stale declared net labels.
      const compiled = circuit.compile();
      if (analysis.outputType === 'current') {
        const source = compiled.devices.find(device => device.name.toLowerCase() === analysis.outputNode.toLowerCase());
        if (!(source instanceof VoltageSource)) invalidNativeField(`${path}/outputNode`);
      } else {
        for (const field of ['outputNode', 'outputReferenceNode'] as const) {
          const name = analysis[field]?.toLowerCase();
          if (name === undefined || name === '0' || name === 'gnd') continue;
          if (![...compiled.nodeIndexMap].some(([node, index]) => node.toLowerCase() === name && index >= 0)) invalidNativeField(`${path}/${field}`);
        }
      }
    }
    if (analysis.type === 'tf') {
      const path = `/input/document/analyses/${index}`;
      if (typeof analysis.source !== 'string' || !/^[^\s]+$/.test(analysis.source)) invalidNativeField(`${path}/source`);
      if (typeof analysis.output !== 'string') invalidNativeField(`${path}/output`);
      const voltage = /^v\(\s*([^\s(),]+)\s*(?:,\s*([^\s(),]+)\s*)?\)$/i.exec(analysis.output);
      const current = /^i\(\s*(v[^\s(),]*)\s*\)$/i.exec(analysis.output);
      if (!voltage && !current) invalidNativeField(`${path}/output`);
    }
    if (analysis.type === 'disto') {
      const path = `/input/document/analyses/${index}`;
      for (const field of ['points', 'startFreq', 'stopFreq'] as const) {
        const value = analysis[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
          || field === 'points' && !Number.isInteger(value)) invalidDistoField(`${path}/${field}`);
      }
      if (analysis.variation !== 'dec') invalidDistoField(`${path}/variation`);
      if (analysis.stopFreq < analysis.startFreq) invalidDistoField(`${path}/stopFreq`);
      const ratio = analysis.f2OverF1;
      if (ratio !== undefined && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)) invalidDistoField(`${path}/f2OverF1`);
    }
    if (analysis.type === 'sp') {
      for (const field of ['points', 'startFreq', 'stopFreq'] as const) {
        const value = analysis[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
          || field === 'points' && !Number.isInteger(value)) invalidNativeField(`/input/document/analyses/${index}/${field}`);
      }
      if (!['dec', 'oct', 'lin'].includes(analysis.variation)) invalidNativeField(`/input/document/analyses/${index}/variation`);
    }
    addAnalysis(circuit, analysis);
  }
  if (document.noiseAnalyses !== undefined) {
    const analyses = document.noiseAnalyses;
    const base = '/input/document/noiseAnalyses';
    if (!Array.isArray(analyses)) invalidNativeField(base);
    for (const [index, analysis] of analyses.entries()) {
      const path = `${base}/${index}`;
      if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) invalidNativeField(path);
      if (analysis.type !== 'noise') invalidNativeField(`${path}/type`);
      for (const field of ['outputNode', 'inputSource', 'outputReferenceNode'] as const) {
        if (field === 'outputReferenceNode' && analysis[field] === undefined) continue;
        if (typeof analysis[field] !== 'string' || !analysis[field].trim()) invalidNativeField(`${path}/${field}`);
      }
      if (!['dec', 'oct', 'lin'].includes(analysis.variation)) invalidNativeField(`${path}/variation`);
      for (const field of ['points', 'startFreq', 'stopFreq'] as const) {
        const value = analysis[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
          || field === 'points' && !Number.isInteger(value)) invalidNativeField(`${path}/${field}`);
      }
      if (analysis.stopFreq < analysis.startFreq) invalidNativeField(`${path}/stopFreq`);
      for (const field of Object.keys(analysis)) {
        if (!['type', 'outputNode', 'outputReferenceNode', 'inputSource', 'variation', 'points', 'startFreq', 'stopFreq'].includes(field)) {
          invalidNativeField(`${path}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`);
        }
      }
      circuit.addAnalysis('noise', analysis);
    }
  }
  if (document.poleZeroAnalyses !== undefined) {
    const analyses = document.poleZeroAnalyses;
    if (!Array.isArray(analyses) || analyses.some(a => !a || a.type !== 'pz'
      || !['inputPositive', 'inputNegative', 'outputPositive', 'outputNegative'].every(key => typeof a[key as keyof typeof a] === 'string')
      || !['cur', 'vol'].includes(a.inputType) || !['pol', 'zer', 'pz'].includes(a.mode))) {
      throw new ProtocolExecutionError({ code: 'INVALID_REQUEST', message: 'Invalid poleZeroAnalyses', phase: 'validation', retryable: false, details: {} });
    }
    for (const analysis of analyses) circuit.addAnalysis('pz', analysis);
  }
  return circuit;
}

/** Resolve native .tf voltage outputs only after hierarchical nodes are expanded. */
function validateNativeTfOutputs(request: SimulationRequestV1, compiled: CompiledCircuit): void {
  if (request.input.format !== 'spice-ts') return;
  if (!request.input.document.analyses.some(analysis => analysis.type === 'tf')) return;
  const nodes = new Set([...compiled.nodeIndexMap.keys()].map(node => node.toLowerCase()));
  for (const [index, analysis] of request.input.document.analyses.entries()) {
    if (analysis.type !== 'tf') continue;
    const voltage = /^v\(\s*([^\s(),]+)\s*(?:,\s*([^\s(),]+)\s*)?\)$/i.exec(analysis.output);
    if (voltage && [voltage[1], voltage[2]].some(node => node !== undefined
      && !['0', 'gnd'].includes(node.toLowerCase()) && !nodes.has(node.toLowerCase()))) {
      invalidNativeField(`/input/document/analyses/${index}/output`);
    }
  }
}

function coreModel(model: CircuitModelV1): { name: string; type: string; params: Record<string, number> } {
  return { name: model.name, type: model.type, params: numberParams(model.params) };
}

function coreSubcircuit(subcircuit: SubcircuitV1): { name: string; ports: string[]; params: Record<string, number>; body: string[] } {
  return {
    name: subcircuit.name,
    ports: [...subcircuit.ports],
    params: {},
    body: [
      ...(subcircuit.models ?? []).map(modelLine),
      ...subcircuit.components.map(componentLine),
    ],
  };
}

function invalidNativeField(path: string): never {
  throw new ProtocolExecutionError({ code: 'INVALID_REQUEST', message: `Invalid native field at ${path}`, phase: 'validation', retryable: false, details: { path } });
}

function addAnalysis(circuit: Circuit, analysis: NativeAnalysisV1): void {
  switch (analysis.type) {
    case 'op': circuit.addAnalysis('op'); break;
    case 'dc': circuit.addAnalysis('dc', analysis); break;
    case 'tran': circuit.addAnalysis('tran', { ...analysis, useInitialConditions: analysis.uic }); break;
    case 'ac': circuit.addAnalysis('ac', analysis); break;
    case 'sp': circuit.addAnalysis('sp', analysis); break;
    case 'disto': circuit.addAnalysis('disto', analysis); break;
    case 'sens': circuit.addAnalysis('sens', analysis); break;
    case 'tf': {
      const voltage = /^v\(\s*([^\s(),]+)\s*(?:,\s*([^\s(),]+)\s*)?\)$/i.exec(analysis.output);
      const current = /^i\(\s*(v[^\s(),]*)\s*\)$/i.exec(analysis.output);
      if (voltage) circuit.addAnalysis('tf', { outputNode: voltage[1], outputReferenceNode: voltage[2], inputSource: analysis.source });
      else if (current) circuit.addAnalysis('tf', { outputSource: current[1], inputSource: analysis.source });
      else invalidNativeField('/input/document/analyses/output');
      break;
    }

  }
}

function addComponent(circuit: Circuit, component: CircuitComponentV1): void {
  const p = component.params;
  const nodes = component.ports.map(port => port.net);
  const named = (name: string, fallback: number): string => component.ports.find(port => port.name === name)?.net ?? nodes[fallback]!;
  const model = component.model ?? stringParam(p, 'modelName');
  switch (component.type.toUpperCase()) {
    case 'R': circuit.addResistor(component.name, named('p', 0), named('n', 1), numberParam(p, 'resistance')); break;
    case 'C': circuit.addCapacitor(component.name, named('p', 0), named('n', 1), optionalNumber(p, 'capacitance'), model, numberParamsExcept(p, ['capacitance', 'modelName'])); break;
    case 'L': circuit.addInductor(component.name, named('p', 0), named('n', 1), optionalNumber(p, 'inductance'), model, numberParamsExcept(p, ['inductance', 'modelName'])); break;
    case 'V':
      // ngspice-47 vsrc has no `m` ("unknown parameter (m)"), as in the SPICE parser.
      if (p.m !== undefined) throw new InvalidCircuitError(VOLTAGE_SOURCE_MULTIPLIER_ERROR);
      circuit.addVoltageSource(component.name, named('p', 0), named('n', 1), waveform(p),
        p.portnum === undefined ? undefined : { number: numberParam(p, 'portnum'), z0: optionalNumber(p, 'z0') ?? 50 });
      break;
    case 'I': circuit.addCurrentSource(component.name, named('p', 0), named('n', 1), waveform(p), optionalNumber(p, 'm')); break;
    case 'D': circuit.addDiode(component.name, named('anode', 0), named('cathode', 1), model); break;
    case 'Q': circuit.addBJT(component.name, named('collector', 0), named('base', 1), named('emitter', 2), required(model, 'model')); break;
    case 'M': circuit.addMOSFET(component.name, named('drain', 0), named('gate', 1), named('source', 2), required(model, 'model'), numberParamsExcept(p, ['modelName', 'channelType']), component.ports.find(port => port.name === 'bulk')?.net); break;
    case 'E': circuit.addVCVS(component.name, named('outP', 2), named('outN', 3), named('ctrlP', 0), named('ctrlN', 1), numberParam(p, 'gain')); break;
    case 'G': circuit.addVCCS(component.name, named('outP', 2), named('outN', 3), named('ctrlP', 0), named('ctrlN', 1), numberParam(p, 'gm')); break;
    case 'H': circuit.addCCVS(component.name, named('outP', 0), named('outN', 1), required(stringParam(p, 'controlSource'), 'controlSource'), numberParam(p, 'gain')); break;
    case 'F': circuit.addCCCS(component.name, named('outP', 0), named('outN', 1), required(stringParam(p, 'controlSource'), 'controlSource'), numberParam(p, 'gain')); break;
    case 'X': circuit.addSubcircuitInstance(component.name, nodes, required(component.subcircuit ?? stringParam(p, 'subcircuit'), 'subcircuit'), numberParamsExcept(p, ['subcircuit'])); break;
    default: throw new InvalidCircuitError(`Unsupported native component type '${component.type}'`);
  }
}

function appendAnalysisResult(
  target: AnalysisResultV1[],
  result: SimulationResult,
  analysis: ProtocolCoreAnalysis,
  analysisIndex: number,
  nodeNames: string[],
  branchNames: string[],
  circuit: Circuit,
): void {
  if (result.steps) {
    result.steps.forEach((step, index) => target.push(serializeOne(step, analysis, analysisIndex, nodeNames, branchNames, circuit, {
      index, parameter: step.paramName, value: step.paramValue,
    })));
  } else {
    target.push(serializeOne(result, analysis, analysisIndex, nodeNames, branchNames, circuit));
  }
}

function serializeOne(
  result: SimulationResult | StepResult,
  analysis: ProtocolCoreAnalysis,
  analysisIndex: number,
  nodeNames: string[],
  branchNames: string[],
  circuit: Circuit,
  step?: StepCoordinateV1,
): AnalysisResultV1 {
  switch (analysis.type) {
    case 'op': return serializeOp(required(result.dc, 'operating-point result'), analysisIndex, nodeNames, branchNames, step);
    case 'dc': return serializeDc(required(result.dcSweep, 'DC-sweep result'), analysis, analysisIndex, nodeNames, branchNames, circuit, step);
    case 'tran': return serializeTransient(required(result.transient, 'transient result'), analysisIndex, nodeNames, branchNames, step);
    case 'ac': return serializeAc(required(result.ac, 'AC result'), analysisIndex, nodeNames, branchNames, step);
    case 'tf': {
      const tf = required(result.transferFunction, 'transfer-function result');
      return withStep({ type: 'tf', analysisIndex, transferFunction: tf.transfer, inputResistanceOhm: tf.inputResistance, outputResistanceOhm: tf.outputResistance }, step);
    }
  }
}

function serializeOp(result: DCResult, analysisIndex: number, nodes: string[], branches: string[], step?: StepCoordinateV1): AnalysisResultV1 {
  return withStep({
    type: 'op', analysisIndex,
    voltagesV: sortedRecord(nodes, name => result.voltage(name)),
    currentsA: sortedRecord(branches, name => result.current(name)),
  }, step);
}

function serializeDc(result: DCSweepResult, analysis: Extract<AnalysisCommand, { type: 'dc' }>, analysisIndex: number, nodes: string[], branches: string[], circuit: Circuit, step?: StepCoordinateV1): DcResultV1 {
  const components = circuit.toIR().components;
  const axis = (name: string, values: Float64Array): DcResultV1['axis'] => {
    const source = components.find(component => component.name.toUpperCase() === name.toUpperCase());
    return { name: source?.name ?? name, unit: source?.type === 'I' ? 'A' : 'V', values: Array.from(values) };
  };
  return withStep({
    type: 'dc', analysisIndex,
    axis: axis(analysis.source, result.sweepValues),
    ...(analysis.secondary && result.secondarySweepValues ? {
      secondaryAxis: axis(analysis.secondary.source, result.secondarySweepValues),
    } : {}),
    voltagesV: sortedRecord(nodes, name => Array.from(result.voltage(name))),
    currentsA: sortedRecord(branches, name => Array.from(result.current(name))),
  }, step);
}

function serializeTransient(result: TransientResult, analysisIndex: number, nodes: string[], branches: string[], step?: StepCoordinateV1): TransientResultV1 {
  return withStep({
    type: 'tran', analysisIndex, timeS: [...result.time],
    voltagesV: sortedRecord(nodes, name => [...result.voltage(name)]),
    currentsA: sortedRecord(branches, name => [...result.current(name)]),
  }, step);
}

function serializeAc(result: ACResult, analysisIndex: number, nodes: string[], branches: string[], step?: StepCoordinateV1): AcResultV1 {
  const polar = (values: { magnitude: number; phase: number }[]): ComplexPolarV1[] => values.map(value => ({
    magnitude: value.magnitude, phaseDegrees: value.phase,
  }));
  return withStep({
    type: 'ac', analysisIndex, frequencyHz: [...result.frequencies],
    voltagePhasors: sortedRecord(nodes, name => polar(result.voltage(name))),
    currentPhasors: sortedRecord(branches, name => polar(result.current(name))),
  }, step);
}

function sortedRecord<T>(names: string[], value: (name: string) => T): Record<string, T> {
  const result: Record<string, T> = {};
  for (const name of [...names].sort(compareCodePoints)) result[name] = value(name);
  return result;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0)!);
  const b = Array.from(right, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function withStep<T extends AnalysisResultV1>(result: T, step?: StepCoordinateV1): T {
  return step ? { ...result, step } : result;
}

function convergenceDetails(error: ConvergenceError): JsonObject {
  const details: JsonObject = {
    kind: error.kind,
    oscillatingNodes: error.oscillatingNodes.slice(0, MAX_DETAIL_NAMES),
    solutionSummary: solutionSummary(error.lastSolution, error.prevSolution),
  };
  if (error.time !== undefined) details.time = error.time;
  if (error.dt !== undefined) details.dt = error.dt;
  if (error.gmin !== undefined) details.gmin = error.gmin;
  return details;
}

function solutionSummary(last: Float64Array, previous: Float64Array): JsonObject {
  const extrema = (values: Float64Array): [number | null, number | null] => values.length === 0
    ? [null, null]
    : [Math.min(...values), Math.max(...values)];
  const [lastMinimum, lastMaximum] = extrema(last);
  const [previousMinimum, previousMaximum] = extrema(previous);
  let changedCount = Math.abs(last.length - previous.length);
  for (let index = 0; index < Math.min(last.length, previous.length); index++) {
    if (last[index] !== previous[index]) changedCount++;
  }
  return { lastMinimum, lastMaximum, previousMinimum, previousMaximum, changedCount };
}

function apiError(code: SpiceApiErrorV1['code'], error: Error, phase: SpiceApiErrorV1['phase'], details: JsonObject): SpiceApiErrorV1 {
  return { code, message: wireMessage(error.message), retryable: false, phase, details: wireObject(details) };
}

function wireApiError(error: SpiceApiErrorV1): SpiceApiErrorV1 {
  return {
    code: error.code,
    message: wireMessage(error.message),
    retryable: error.retryable,
    phase: error.phase,
    details: wireObject(error.details),
  };
}

function isWireApiError(value: unknown): value is SpiceApiErrorV1 {
  if (!isRecord(value)) return false;
  return typeof value.code === 'string'
    && API_ERROR_CODES.has(value.code as SpiceApiErrorV1['code'])
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
    && typeof value.phase === 'string'
    && API_ERROR_PHASES.has(value.phase as SpiceApiErrorV1['phase'])
    && isJsonObject(value.details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value, new WeakSet<object>());
}

function isJsonValue(value: unknown, seen: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const valid = Object.keys(value).length === value.length
      && value.every(entry => isJsonValue(entry, seen));
    seen.delete(value);
    return valid;
  }
  const valid = Object.values(value).every(entry => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

function wireMessage(message: string): string {
  return message.replace(/\bspice-ts\b(?!-(?:js|wasm))/g, 'spice-ts-js');
}

function wireObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key.toLowerCase() !== 'stack')
    .map(([key, entry]) => [key, wireValue(entry)]));
}

function wireValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return wireMessage(value);
  if (Array.isArray(value)) return value.map(wireValue);
  if (value !== null && typeof value === 'object') return wireObject(value);
  return value;
}

function numberParams(params: JsonObject): Record<string, number> {
  return numberParamsExcept(params, []);
}

function numberParamsExcept(params: JsonObject, excluded: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!excluded.includes(key) && typeof value === 'number') result[key] = value;
  }
  return result;
}

function numberParam(params: JsonObject, name: string): number {
  const value = params[name];
  if (typeof value !== 'number') throw new InvalidCircuitError(`Native component parameter '${name}' must be a number`);
  return value;
}

function optionalNumber(params: JsonObject, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new InvalidCircuitError(`Native component parameter '${name}' must be a number`);
  return value;
}

function stringParam(params: JsonObject, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' ? value : undefined;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new InvalidCircuitError(`Missing ${name}`);
  return value;
}

function waveform(params: JsonObject): Partial<SourceWaveform> & { dc?: number } {
  const distortion: Partial<SourceWaveform> = {};
  for (const field of ['distortionF1', 'distortionF2'] as const) {
    const value = params[field];
    if (value !== undefined) {
      const path = `params/${field}`;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidDistoField(path);
      const excitation = value as JsonObject;
      for (const key of Object.keys(excitation)) {
        if (key !== 'magnitude' && key !== 'phase') invalidDistoField(`${path}/${key}`);
      }
      if (typeof excitation.magnitude !== 'number' || !Number.isFinite(excitation.magnitude)) invalidDistoField(`${path}/magnitude`);
      if (excitation.phase !== undefined && (typeof excitation.phase !== 'number' || !Number.isFinite(excitation.phase))) invalidDistoField(`${path}/phase`);
      distortion[field] = { magnitude: numberParam(excitation, 'magnitude'), phase: optionalNumber(excitation, 'phase') ?? 0 };
    }
  }
  return { ...sourceWaveform(params), ...distortion };
}

function invalidDistoField(path: string): never {
  throw new ProtocolExecutionError({ code: 'INVALID_INPUT', message: `Invalid native distortion field at ${path}`, phase: 'validation', retryable: false, details: { path } });
}

function sourceWaveform(params: JsonObject): Partial<SourceWaveform> & { dc?: number } {
  const kind = stringParam(params, 'waveform') ?? 'dc';
  switch (kind) {
    case 'dc': return { dc: params.dc === undefined && (params.distortionF1 !== undefined || params.distortionF2 !== undefined) ? 0 : numberParam(params, 'dc') };
    case 'ac': return { type: 'ac', dc: optionalNumber(params, 'dc'), magnitude: optionalNumber(params, 'magnitude') ?? 1, phase: optionalNumber(params, 'phase') ?? 0 };
    case 'sin': return { type: 'sin', offset: numberParam(params, 'offset'), amplitude: numberParam(params, 'amplitude'), frequency: numberParam(params, 'frequency'), delay: optionalNumber(params, 'delay'), damping: optionalNumber(params, 'damping'), phase: optionalNumber(params, 'phase') };
    case 'pulse': return { type: 'pulse', v1: numberParam(params, 'v1'), v2: numberParam(params, 'v2'), delay: numberParam(params, 'delay'), rise: numberParam(params, 'rise'), fall: numberParam(params, 'fall'), width: numberParam(params, 'width'), period: numberParam(params, 'period') };
    case 'pwl': {
      const points = params.points;
      const delay = optionalNumber(params, 'delay');
      const repeat = optionalNumber(params, 'repeat');
      const options = { ...(delay !== undefined ? { delay } : {}), ...(repeat !== undefined ? { repeat } : {}) };
      if (typeof points === 'string') return { type: 'pwl', points: parseIrPwlPoints(points), ...options };
      if (Array.isArray(points)) return { type: 'pwl', points: points.map((point, index) => {
        if (typeof point !== 'object' || point === null || Array.isArray(point)) throw new InvalidCircuitError(`Native PWL point ${index} is invalid`);
        const entry = point as JsonObject;
        return { time: numberParam(entry, 'time'), value: numberParam(entry, 'value') };
      }), ...options };
      throw new InvalidCircuitError("Native PWL parameter 'points' must be an array or CircuitIR string");
    }
    default: throw new InvalidCircuitError(`Unsupported native source waveform '${kind}'`);
  }
}

function parseIrPwlPoints(value: string): Array<{ time: number; value: number }> {
  if (value === '') return [];
  return value.split(',').map((point, index) => {
    const separator = point.indexOf(':');
    if (separator <= 0 || separator !== point.lastIndexOf(':')) {
      throw new InvalidCircuitError(`Native PWL point ${index} is invalid`);
    }
    const time = Number(point.slice(0, separator));
    const sample = Number(point.slice(separator + 1));
    if (!Number.isFinite(time) || !Number.isFinite(sample)) {
      throw new InvalidCircuitError(`Native PWL point ${index} is invalid`);
    }
    return { time, value: sample };
  });
}

function modelLine(model: CircuitModelV1): string {
  const params = Object.entries(numberParams(model.params)).map(([key, value]) => `${key}=${value}`).join(' ');
  return `.model ${model.name} ${model.type}${params ? ` (${params})` : ''}`;
}

function componentLine(component: CircuitComponentV1): string {
  const circuit = new Circuit();
  addComponent(circuit, component);
  return circuit.toNetlist().split('\n').find(line => line.startsWith(component.name + ' '))
    ?? (() => { throw new InvalidCircuitError(`Unable to serialize subcircuit component '${component.name}'`); })();
}
