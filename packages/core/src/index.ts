export { simulate, simulateStream, simulateStepStream, createSimulator } from './simulate.js';
export {
  simulateProtocolV1, simulateNoiseProtocolV1, operatingPointReportProtocolV1,
  simulatePoleZeroProtocolV1, validateProtocolV1, mapProtocolErrorV1, estimateProtocolResultPointsV1,
} from './protocol/adapter.js';
export type { ProtocolValidationResultV1 } from './protocol/adapter.js';
export { executeProtocolV1, protocolCapabilitiesV1 } from './protocol/envelopes.js';
export type { ProtocolEnvelopeExecutionOptionsV1 } from './protocol/envelopes.js';
export type {
  ProtocolCapabilitiesV1, ProtocolCompletionV1, ProtocolExecutionMetadataV1,
  ProtocolFailureEnvelopeV1, ProtocolSuccessEnvelopeV1, ProtocolTerminalEnvelopeV1,
} from './protocol/types.js';
export type {
  ProtocolAbortSignalV1, ProtocolExecutionOptionsV1, ProtocolSafePointV1,
} from './protocol/execution-guard.js';
export { preflightTopology, TopologyPreflightError } from './validation/topology-preflight.js';
export type { TopologyFailureKind, TopologySourcePath } from './validation/topology-preflight.js';
export { frequencyGrid, frequencyPointCount } from './analysis/frequency-grid.js';
export { ngspiceFourier } from './parser/control/fourier.js';
export type { FrequencySweepKind } from './analysis/frequency-grid.js';
export { createTransientSim } from './analysis/transient-driver.js';
export type { TransientSim, TransientSimOptions } from './analysis/transient-driver.js';
export type { SparseSolver } from './solver/sparse-solver.js';
export { WasmNgspiceSimulator } from './simulators/ngspice-wasm.js';
export type { WasmNgspiceSimulatorOptions } from './simulators/ngspice-wasm.js';
export { parse, parseAsync, parseTitleless, parseTitlelessAsync } from './parser/index.js';
export { preprocess } from './parser/preprocessor.js';
export { Circuit } from './circuit.js';
export { operatingPointReport } from './op-report.js';
export type { OperatingPointDevice, OperatingPointReport } from './op-report.js';
export type { CompiledCircuit } from './circuit.js';
export {
  DCResult, TransientResult, ACResult, DCSweepResult, NoiseResult, DistortionResult,
  TransferFunctionResult, PoleZeroResult, SensitivityResult, SParameterResult,
} from './results.js';
export type {
  SimulationResult, DotAnalysisRun, StepResult, PoleZeroValue, SensitivityEntry, ComplexSensitivityValue,
  ComplexDistortionValue, ComplexValue, DistortionOrder, DistortionIntermodulationProduct, DistortionProduct,
  ControlScriptResult, ControlScriptRun, MeasurementResult, FourierResult,
} from './results.js';
export type {
  SimulationOptions,
  Ngbehavior,
  IntegrationMethod,
  TransientStep,
  ACPoint,
  NoiseAnalysis,
  SParameterAnalysis,
  RFPort,
  DistortionAnalysis,
  DistortionExcitation,
  TransferFunctionAnalysis,
  PoleZeroAnalysis,
  SensitivityAnalysis,
  AnalysisCommand,
  AnalysisDirective,
  NodeInitialState,
  SourceWaveform,
  ExpSource,
  SffmSource,
  AmSource,
  TransientNoiseSource,
  TransientRandomSource,
  ModelParams,
  SubcktDefinition,
  IncludeResolver,
  StepAnalysis,
  StepSweepMode,
  StepStreamEvent,
  StepWorker,
  StepWorkerTask,
  StepWorkerOptions,
  StepWorkerCompletion,
  SimulatorBackend,
  SimulatorBackendName,
  SimulatorAdapter,
  ConvergenceTelemetry,
  DCConvergenceTelemetry,
  TransientConvergenceTelemetry,
} from './types.js';
export type { DeviceModel, StampContext } from './devices/device.js';
export type { CircuitIR, IRComponent, IRPort, ComponentType } from './ir/types.js';
export { VCVS } from './devices/vcvs.js';
export { VCCS } from './devices/vccs.js';
export { CCVS } from './devices/ccvs.js';
export { CCCS } from './devices/cccs.js';
export {
  SpiceError,
  ParseError,
  InvalidCircuitError,
  SingularMatrixError,
  ConvergenceError,
  TimestepTooSmallError,
  CycleError,
  UnsupportedModelLevelError,
  UnsupportedModelVersionError,
  UnsupportedCircuitModelTypeError,
  ModelTypeMismatchError,
  UnsupportedModelParameterError,
  UnsupportedTemperatureError,
  UnsupportedMultiplicityError,
} from './errors.js';
export { SUPPORTED_MODEL_TYPES, DEVICE_MODEL_TYPES, UnsupportedModelTypeError } from './parser/model-type.js';
export { UnsupportedSourceWaveformError } from './parser/waveform-parser.js';
export type { ConvergenceFailureKind } from './errors.js';
export { UnsupportedCodeModelError } from './parser/xspice-parser.js';
export type { DigitalNodeEvent } from './devices/xspice/event-network.js';
export { UnsupportedResistorParameterError } from './parser/resistor-parser.js';
export { UnsupportedModelFlagError } from './parser/model-flags.js';
export { UnsupportedMeasureError } from './measure/errors.js';
export {
  UnsupportedControlCommandError, ControlScriptError, ControlScriptExitError,
} from './parser/control/errors.js';
