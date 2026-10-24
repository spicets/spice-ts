import { InvalidCircuitError } from './errors.js';
import { DEVICE_GMIN } from './devices/device.js';

/** Node identifier — string name from netlist (e.g., '1', 'out', '0' for ground) */
export type NodeName = string;

/** Ground node is always '0' */
export const GROUND_NODE = '0';

/** Supported analysis command types. */
export type AnalysisType = 'op' | 'dc' | 'tran' | 'ac' | 'noise' | 'sp' | 'tf' | 'pz' | 'sens' | 'disto';

/** DC operating point analysis (`.op`). */
export interface DCAnalysis {
  type: 'op';
}

/** One source range in a DC sweep (`.dc`). */
export interface DCSweepDimension {
  /** Name of the source to sweep (e.g., `'V1'`) */
  source: string;
  /** Start value of the sweep (volts or amps) */
  start: number;
  /** Stop value of the sweep */
  stop: number;
  /** Step size between sweep points */
  step: number;
}

/** DC sweep analysis (`.dc`). The primary source varies fastest. */
export interface DCSweepAnalysis extends DCSweepDimension {
  type: 'dc';
  /** Optional outer source range. Exactly two dimensions are supported. */
  secondary?: DCSweepDimension;
}

/** Transient analysis (`.tran`). Time-domain simulation. */
export interface TransientAnalysis {
  type: 'tran';
  /** Suggested timestep in seconds */
  timestep: number;
  /** Simulation end time in seconds */
  stopTime: number;
  /** Simulation start time in seconds (default: 0) */
  startTime?: number;
  /** Maximum allowed timestep in seconds */
  maxTimestep?: number;
  /** Skip the DC operating point and use `.ic` values as the transient state. */
  useInitialConditions?: boolean;
}

/** A node voltage supplied by `.ic` or `.nodeset`. */
export interface NodeInitialState {
  /** Node name as declared in the netlist. */
  node: NodeName;
  /** Initial voltage or Newton guess in volts. */
  value: number;
}

/** AC small-signal analysis (`.ac`). Frequency sweep. */
export interface ACAnalysis {
  type: 'ac';
  /** Frequency sweep variation: `'dec'` (decades), `'oct'` (octaves), or `'lin'` (linear) */
  variation: 'dec' | 'oct' | 'lin';
  /** Number of points per decade/octave, or total for linear */
  points: number;
  /** Start frequency in Hz */
  startFreq: number;
  /** Stop frequency in Hz */
  stopFreq: number;
}

/** Bounded resistor-noise analysis (`.noise v(node[,reference]) source ...`). */
export interface NoiseAnalysis {
  type: 'noise';
  /** Positive output node whose voltage-noise density is reported. */
  outputNode: string;
  /** Optional negative output node for a differential voltage result. */
  outputReferenceNode?: string;
  /** Independent voltage source used to refer output noise back to the input. */
  inputSource: string;
  /** Frequency sweep spacing. */
  variation: 'dec' | 'oct' | 'lin';
  /** Number of points per decade/octave, or total points for a linear sweep. */
  points: number;
  /** Start frequency in Hz. */
  startFreq: number;
  /** Stop frequency in Hz. */
  stopFreq: number;
  /** Optional interval between per-generator summary points in classic SPICE output. */
  pointsPerSummary?: number;
}

/**
 * S-parameter analysis over the circuit's RF ports
 * (`.sp {dec|oct|lin} points fstart fstop [donoise]`, ngspice-47 span.c).
 */
export interface SParameterAnalysis {
  type: 'sp';
  /** Frequency sweep spacing. */
  variation: 'dec' | 'oct' | 'lin';
  /** Number of points per decade/octave, or total points for a linear sweep. */
  points: number;
  /** Start frequency in Hz. */
  startFreq: number;
  /** Stop frequency in Hz. */
  stopFreq: number;
  /** `donoise = 1`: also compute the port noise-current correlation matrix Cy (and NF/SOpt/NFmin/Rn for two ports). */
  noise: boolean;
}

/** Bounded distortion analysis (`.disto dec ... [f2overf1]`). */
export interface DistortionAnalysis {
  type: 'disto';
  variation: 'dec';
  /** Points per decade. */
  points: number;
  /** Fundamental-frequency sweep start in Hz. */
  startFreq: number;
  /** Fundamental-frequency sweep stop in Hz. */
  stopFreq: number;
  /** Fixed F2/start-F1 ratio. Its presence selects the bounded two-tone mode. */
  f2OverF1?: number;
}

/** Bounded DC transfer-function analysis. */
export type TransferFunctionAnalysis = VoltageTransferFunctionAnalysis
  | CurrentTransferFunctionAnalysis;

/** Voltage-output transfer function (`.tf v(node[,reference]) source`). */
export interface VoltageTransferFunctionAnalysis {
  type: 'tf';
  /** Positive output node whose small-signal voltage is measured. */
  outputNode: string;
  /** Negative output node; omitted means ground. */
  outputReferenceNode?: string;
  /** Independent voltage or current source used as the small-signal input. */
  inputSource: string;
}

/** Independent-voltage-source current-output transfer function (`.tf i(source) input`). */
export interface CurrentTransferFunctionAnalysis {
  type: 'tf';
  /** Independent voltage source whose small-signal branch current is measured. */
  outputSource: string;
  /** Independent voltage or current source used as the small-signal input. */
  inputSource: string;
}

/** Bounded pole-zero analysis (`.pz input 0 output 0 {cur|vol} {pol|pz}`). */
export interface PoleZeroAnalysis {
  type: 'pz';
  /** Positive input terminal. */
  inputPositive: string;
  /** Negative input terminal (`'0'` for ground). */
  inputNegative: string;
  /** Positive voltage-output terminal. */
  outputPositive: string;
  /** Negative voltage-output terminal (`'0'` for ground). */
  outputNegative: string;
  /** Current or voltage input. */
  inputType: 'cur' | 'vol';
  /** Compute poles only, zeros only, or both poles and zeros. */
  mode: 'pol' | 'zer' | 'pz';
}

/** Bounded voltage or independent voltage-source branch-current sensitivity analysis. */
export type SensitivityAnalysis = DCSensitivityAnalysis | ACSensitivityAnalysis;

/** DC operating-point sensitivity (`.sens v(node)`). */
export interface DCSensitivityAnalysis {
  type: 'sens';
  /** Defaults to voltage; current outputNode names an independent voltage source. */
  outputType?: 'voltage' | 'current';
  outputNode: string;
  outputReferenceNode?: string;
  mode: 'dc';
}

/** Small-signal AC sensitivity (`.sens v(node) ac {dec|oct|lin} ...`). */
export interface ACSensitivityAnalysis {
  type: 'sens';
  /** Defaults to voltage; current outputNode names an independent voltage source. */
  outputType?: 'voltage' | 'current';
  outputNode: string;
  outputReferenceNode?: string;
  mode: 'ac';
  variation: 'dec' | 'oct' | 'lin';
  points: number;
  startFreq: number;
  stopFreq: number;
}

/** Established time/frequency analysis command types. */
export type AnalysisCommand = DCAnalysis | DCSweepAnalysis | TransientAnalysis | ACAnalysis;

/** Every analysis directive executable by the native simulator. */
export type AnalysisDirective =
  | AnalysisCommand
  | NoiseAnalysis
  | SParameterAnalysis
  | DistortionAnalysis
  | TransferFunctionAnalysis
  | SensitivityAnalysis;

/** Integration methods for transient analysis */
export type IntegrationMethod = 'euler' | 'trapezoidal' | 'gear2';

/** Canonical ngbehavior request and ngspice-47 set_compat_mode flags.
 * This does not claim support for every vendor's netlist translation.
 */
export interface Ngbehavior {
  readonly mode: string;
  readonly flags: Readonly<Record<'hs' | 'ps' | 'xs' | 'lt' | 'ki' | 'a' | 'll' | 's3' | 'eg' | 'spe' | 'mc', boolean>>;
}

/**
 * Options for controlling simulation behavior.
 * All fields are optional; SPICE-convention defaults are used when omitted.
 */
export interface SimulationOptions {
  /** Interpolate transient output onto the ngspice TSTEP grid. Does not change solver steps. */
  interp?: boolean;
  /** Input deck path, when known. Defines the control-language $inputdir; never inferred from cwd. */
  sourcePath?: string;
  /** Optional caller-owned output sink. Core never accesses the filesystem; callers enforce their sandbox. */
  writeControlFile?: (path: string, contents: string) => void;
  /** Save supported device currents as complete per-point analysis vectors. Default: false. */
  savecurrents?: boolean;
  /** Stop transient analysis after all applicable measurements complete. Default: false. */
  autostop?: boolean;
  /** ngspice instance geometry scale. Explicit MOS/R/C lengths scale by S, MOS areas by S^2. Default: 1. */
  scale?: number;
  /** Parsed compatibility request; existing expression extensions remain available in all modes. */
  ngbehavior?: Ngbehavior;
  /** Parsed ngspice solver-selection hint. Native analyses always use spice-ts's sparse LU solver. */
  solverSelection?: 'klu' | 'sparse';
  /** ngspice nonlinear-device bypass request. Native solver always evaluates devices and warns when nonzero. */
  bypass?: number;
  /** ngspice-47 RAMPTIME breakpoint (s). Ordinary V/I sources do not ramp in the release build. Default: 0. */
  rampTime?: number;
  /**
   * ngspice `.options seed=N` (positive integer): seeds the uniform random
   * streams of TRNOISE RTS noise and TRRANDOM sources as ngspice-47 does.
   * Absent keeps spice-ts's fixed default streams, so runs stay reproducible.
   */
  seed?: number;
  /** Absolute current tolerance (A). Default: 1e-12 */
  abstol?: number;
  /** Absolute voltage tolerance (V). Default: 1e-6 */
  vntol?: number;
  /** Relative tolerance. Default: 1e-3 */
  reltol?: number;
  /** Max Newton-Raphson iterations (DC). Default: 100 */
  maxIterations?: number;
  /** Max Newton-Raphson iterations per transient step. Default: 100 (ngspice-47 NIiter floor) */
  maxTransientIterations?: number;
  /**
   * Maximum timestep for transient analyses without a `.tran` TMAX (TMAX wins,
   * as in ngspice). Default: min(TSTEP, TSTOP/50). 0 means unset, as in
   * ngspice; negative or non-finite values throw `InvalidCircuitError`.
   */
  maxTimestep?: number;
  /** Integration method. Default: 'trapezoidal' */
  integrationMethod?: IntegrationMethod;
  /** ngspice trapezoidal mixing coefficient. Default: 0.5; no range clamp. */
  xmu?: number;
  /** ngspice MAXORD cap (1..6). Order 1 uses backward Euler for trap and gear. Default: 2. */
  maxOrder?: number;
  /** Trapezoidal truncation error factor. Default: 7 */
  trtol?: number;
  /** Charge tolerance (C) of the device-charge truncation error (ngspice CHGTOL). Default: 1e-14 */
  chgtol?: number;
  /**
   * Diagonal node-to-ground (gshunt-like) conductance. Default: 0 (disabled).
   * Netlist `.options gmin` sets deviceGmin instead.
   */
  gmin?: number;
  /** Junction conductance (ngspice CKTgmin / `.options gmin`). Default: 1e-12 S. */
  deviceGmin?: number;
  /**
   * ngspice `.options rshunt=R` (ohms, above 1e-30): a noiseless resistor R
   * from every node, device-internal nodes included, to ground in every
   * analysis. Read from the circuit's own options (`.options` card or
   * `Circuit.setSimulationOptions`) when it is compiled. Default: none.
   */
  rshunt?: number;
  /** Resolver for .include and .lib file directives */
  resolveInclude?: IncludeResolver;
  /**
   * Simulation backend to use. Defaults to `'spice-ts'`, the TypeScript-native
   * solver. Use `'ngspice-wasm'` to run through the optional ngspice WASM
   * adapter, or pass a custom simulator adapter.
   */
  simulator?: SimulatorBackend;
  /** Optional bounded worker execution for independent `.step` iterations. */
  stepWorkers?: false | StepWorkerOptions;
}

/** Serializable work sent to one `.step` worker. */
export interface StepWorkerTask {
  index: number;
  netlist: string;
  options: Omit<SimulationOptions, 'resolveInclude' | 'simulator' | 'stepWorkers'>;
}

/** Minimal worker contract supported by Node worker_threads and browser Workers. */
export interface StepWorker {
  run(task: StepWorkerTask): Promise<import('./results.js').SimulationResult>;
  terminate(reason?: unknown): void | Promise<void>;
}

export interface StepWorkerCompletion {
  index: number;
  result: import('./results.js').StepResult;
}

export interface StepWorkerOptions {
  /** Maximum concurrent workers. Defaults to the runtime hardware-concurrency hint. */
  maxWorkers?: number;
  /** Abort the sweep and terminate every active worker. */
  signal?: import('./analysis/step-scheduler.js').StepTaskAbortSignal;
  /** Receives results immediately in completion order. */
  onComplete?: (completion: StepWorkerCompletion) => void;
  /** Override worker creation; returning null requests sequential fallback. */
  workerFactory?: (workerIndex: number) => StepWorker | null | Promise<StepWorker | null>;
}

/** Built-in simulator backend names. */
export type SimulatorBackendName = 'spice-ts' | 'ngspice-wasm';

/** Pluggable simulator adapter compatible with {@link simulate}. */
export interface SimulatorAdapter {
  /** Human-readable backend name for diagnostics. */
  readonly name?: string;
  /** Run a simulation and return the standard spice-ts result shape. */
  simulate(
    input: string | import('./circuit.js').Circuit,
    options?: SimulationOptions,
  ): Promise<import('./results.js').SimulationResult>;
}

/** Simulation backend selector accepted by {@link SimulationOptions}. */
export type SimulatorBackend = SimulatorBackendName | SimulatorAdapter;

/** Resolved options with all defaults filled in */
export interface ResolvedOptions {
  interp?: boolean;
  maxOrder: number;
  rampTime: number;
  abstol: number;
  vntol: number;
  reltol: number;
  maxIterations: number;
  maxTransientIterations: number;
  maxTimestep: number;
  integrationMethod: IntegrationMethod;
  xmu?: number;
  trtol: number;
  chgtol: number;
  gmin: number;
  deviceGmin: number;
}

export const DEFAULT_OPTIONS: ResolvedOptions = {
  maxOrder: 2,
  rampTime: 0,
  abstol: 1e-12,
  vntol: 1e-6,
  reltol: 1e-3,
  maxIterations: 100,
  // ngspice-47 niiter.c raises any limit below 100 (default ITL4 = 10) to 100 (#804).
  maxTransientIterations: 100,
  maxTimestep: Infinity,
  integrationMethod: 'trapezoidal',
  xmu: 0.5,
  trtol: 7,
  chgtol: 1e-14,
  gmin: 0,
  deviceGmin: DEVICE_GMIN,
};

/** Netlist `.options` overlaid by caller options; an explicit `undefined` keeps the netlist value. */
export function withNetlistOptions<T extends SimulationOptions>(netlist: SimulationOptions, options?: T): T {
  const merged: Record<string, unknown> = { ...netlist };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as T;
}

export function resolveOptions(opts?: SimulationOptions, stopTime?: number): ResolvedOptions {
  if (opts?.xmu !== undefined && !Number.isFinite(opts.xmu)) {
    throw new InvalidCircuitError('SimulationOptions.xmu must be finite');
  }
  if (opts?.maxOrder !== undefined && (!Number.isInteger(opts.maxOrder) || opts.maxOrder < 1 || opts.maxOrder > 6)) {
    throw new InvalidCircuitError('SimulationOptions.maxOrder must be an integer from 1 to 6');
  }
  if (opts?.integrationMethod === 'gear2' && (opts.maxOrder ?? 2) > 3) {
    throw new InvalidCircuitError('spice-ts implements Gear orders 1 through 3 only');
  }
  if (opts?.rampTime !== undefined && (!Number.isFinite(opts.rampTime) || opts.rampTime < 0)) {
    throw new InvalidCircuitError('SimulationOptions.rampTime must be a non-negative finite number');
  }
  if (opts?.bypass !== undefined && (!Number.isInteger(opts.bypass) || opts.bypass < 0)) {
    throw new InvalidCircuitError('SimulationOptions.bypass must be a non-negative integer');
  }
  return {
    maxOrder: opts?.maxOrder ?? DEFAULT_OPTIONS.maxOrder,
    interp: opts?.interp,
    rampTime: opts?.rampTime ?? DEFAULT_OPTIONS.rampTime,
    abstol: opts?.abstol ?? DEFAULT_OPTIONS.abstol,
    vntol: opts?.vntol ?? DEFAULT_OPTIONS.vntol,
    reltol: opts?.reltol ?? DEFAULT_OPTIONS.reltol,
    maxIterations: opts?.maxIterations ?? DEFAULT_OPTIONS.maxIterations,
    maxTransientIterations: opts?.maxTransientIterations ?? DEFAULT_OPTIONS.maxTransientIterations,
    maxTimestep: opts?.maxTimestep ?? (stopTime ? stopTime / 50 : DEFAULT_OPTIONS.maxTimestep),
    // ngspice nicomcof.c: trap and gear order 1 both have coefficients 1/dt, -1/dt.
    // Resolve the cap here so companion stamping, nonlinear charge history and
    // truncation all use the same first-order rule (including streaming runs).
    integrationMethod: opts?.maxOrder === 1 ? 'euler' : opts?.integrationMethod ?? DEFAULT_OPTIONS.integrationMethod,
    trtol: opts?.trtol ?? DEFAULT_OPTIONS.trtol,
    xmu: opts?.xmu ?? DEFAULT_OPTIONS.xmu,
    chgtol: opts?.chgtol ?? DEFAULT_OPTIONS.chgtol,
    gmin: opts?.gmin ?? DEFAULT_OPTIONS.gmin,
    deviceGmin: opts?.deviceGmin ?? DEFAULT_OPTIONS.deviceGmin,
  };
}

/**
 * A single transient simulation timestep, yielded by {@link simulateStream}.
 */
export interface TransientStep {
  /** Simulation time in seconds */
  time: number;
  /** Node voltages at this timestep (node name to volts) */
  voltages: Map<string, number>;
  /** Branch currents at this timestep (device name to amps) */
  currents: Map<string, number>;
}

/**
 * A single AC frequency point, yielded by {@link simulateStream}.
 */
export interface ACPoint {
  /** Frequency in Hz */
  frequency: number;
  /** Node voltage phasors (node name to magnitude/phase in degrees) */
  voltages: Map<string, { magnitude: number; phase: number }>;
  /** Branch current phasors (device name to magnitude/phase in degrees) */
  currents: Map<string, { magnitude: number; phase: number }>;
}

/**
 * Device model parameters parsed from a `.model` card.
 */
export interface ModelParams {
  /** Model name as declared in the netlist */
  name: string;
  /** Model type (e.g., `'NPN'`, `'PNP'`, `'NMOS'`, `'PMOS'`, `'D'`) */
  type: string;
  /** Key-value parameter map (e.g., `{ BF: 100, IS: 1e-14 }`) */
  params: Record<string, number>;
  /**
   * Raw `VERSION=` string of the card (e.g. `'3.3.0'`). ngspice declares the BSIM version as a
   * string parameter and selects the BSIM implementation by its prefix, so it is kept verbatim.
   */
  version?: string;
}

/** DC source waveform. Constant value. */
export interface DCSource {
  type: 'dc';
  /** DC value in volts (for voltage sources) or amps (for current sources) */
  value: number;
}

/** Pulse source waveform (PULSE). */
export interface PulseSource {
  type: 'pulse';
  /** Explicit DC operating-point value declared before the waveform. */
  dc?: number;
  /** Initial value */
  v1: number;
  /** Pulsed value */
  v2: number;
  /** Delay before first pulse in seconds */
  delay: number;
  /** Rise time in seconds */
  rise: number;
  /** Fall time in seconds */
  fall: number;
  /** Pulse width in seconds */
  width: number;
  /** Period in seconds */
  period: number;
  /**
   * Number of pulses (ngspice's eighth PULSE field, NP). When positive, the
   * source holds V1 once `time - delay` exceeds `pulses * period`; omitted or
   * non-positive means the pulse train repeats indefinitely.
   */
  pulses?: number;
}

/** Sinusoidal source waveform (SIN). */
export interface SinSource {
  type: 'sin';
  /** Explicit DC operating-point value when declared before SIN/SINE. */
  dc?: number;
  /** DC offset */
  offset: number;
  /** Peak amplitude */
  amplitude: number;
  /** Frequency in Hz */
  frequency: number;
  /** Delay before sine starts in seconds */
  delay?: number;
  /** Damping factor (1/s) */
  damping?: number;
  /** Phase offset in degrees */
  phase?: number;
}

/** One time/value pair in a piecewise-linear source waveform. */
export interface PWLPoint {
  /** Time in seconds. Points are ordered by non-decreasing time. */
  time: number;
  /** Source value at this point. */
  value: number;
}

/** Piecewise-linear source waveform (PWL). */
export interface PWLSource {
  type: 'pwl';
  /** Explicit DC operating-point value declared before the waveform. */
  dc?: number;
  /** Ordered time/value pairs. Equal adjacent times describe a discontinuity. */
  points: PWLPoint[];
  /** `TD=`: delay in seconds that shifts every point (ngspice VSRCrdelay). */
  delay?: number;
  /**
   * `R=`: repeat start time. After the last point the waveform repeats from
   * the point at this time (ngspice VSRCr; `R=0` repeats the whole waveform).
   * Must equal one of the point times and be before the last one.
   */
  repeat?: number;
}

/**
 * Exponential source waveform (`EXP(V1 V2 [TD1 [TAU1 [TD2 [TAU2]]]])`).
 * Omitted or zero times default as in ngspice-47 vsrcload.c: TD1, TAU1 and
 * TAU2 to the transient TSTEP, TD2 to TD1 + TSTEP.
 */
export interface ExpSource {
  type: 'exp';
  /** Explicit DC operating-point value declared before the waveform. */
  dc?: number;
  /** Initial value */
  v1: number;
  /** Pulsed value */
  v2: number;
  /** Rise delay time in seconds */
  td1?: number;
  /** Rise time constant in seconds */
  tau1?: number;
  /** Fall delay time in seconds */
  td2?: number;
  /** Fall time constant in seconds */
  tau2?: number;
}

/**
 * Single-frequency FM source waveform
 * (`SFFM(VO VA [FC [MDI [FM [TD [PHASEM [PHASEC]]]]]])`), ngspice-47
 * semantics: 0 until TD, then `VO + VA*sin(2*pi*FC*t + PHASEC + MDI*sin(2*pi*FM*t + PHASEM))`
 * with `t` measured from TD. Omitted FC and FM default to `5/TSTOP` and
 * `500/TSTOP` (FM also when zero), MDI to 90, and MDI is clamped to [0, FC/FM].
 */
export interface SffmSource {
  type: 'sffm';
  /** Explicit DC operating-point value declared before the waveform. */
  dc?: number;
  /** Offset */
  offset: number;
  /** Amplitude */
  amplitude: number;
  /** Carrier frequency in Hz */
  carrierFrequency?: number;
  /** Modulation index */
  modulationIndex?: number;
  /** Signal (modulating) frequency in Hz */
  signalFrequency?: number;
  /** Delay in seconds */
  delay?: number;
  /** Modulating-signal phase in degrees */
  signalPhase?: number;
  /** Carrier phase in degrees */
  carrierPhase?: number;
}

/**
 * Amplitude-modulated source waveform
 * (`AM(VO VMO [VMA [FM [FC [TD [PHASEM [PHASEC]]]]]])`), ngspice-47
 * semantics: 0 until TD, then
 * `VO + (VMO + VMA*sin(2*pi*FM*t + PHASEM)) * sin(2*pi*FC*t + PHASEC)` with `t`
 * measured from TD. Omitted VMA, FM and FC default to 1, `5/TSTOP` and `500/TSTOP`.
 */
export interface AmSource {
  type: 'am';
  /** Explicit DC operating-point value declared before the waveform. */
  dc?: number;
  /** Offset */
  offset: number;
  /** Carrier amplitude (modulation offset) */
  carrierAmplitude: number;
  /** Modulation amplitude */
  modulationAmplitude?: number;
  /** Modulating frequency in Hz */
  modulationFrequency?: number;
  /** Carrier frequency in Hz */
  carrierFrequency?: number;
  /** Delay in seconds */
  delay?: number;
  /** Modulating-signal phase in degrees */
  modulationPhase?: number;
  /** Carrier phase in degrees */
  carrierPhase?: number;
}

/**
 * ngspice-47 transient noise source
 * (`TRNOISE(NA TS [NALPHA [NAMP [RTSAM [RTSCAPT [RTSEMT]]]]])`): white noise
 * of rms `amplitude` and 1/f^`alpha` noise of rms `oneOverFAmplitude`, both
 * sampled every `ts` and linearly interpolated, plus random-telegraph noise of
 * amplitude `rtsAmplitude` with exponentially distributed mean capture and
 * emission times.
 */
export interface TransientNoiseSource {
  type: 'trnoise';
  /** Explicit DC value, added to the noise as in ngspice. */
  dc?: number;
  /** NA: white-noise rms value. */
  amplitude: number;
  /** TS: noise sample interval in seconds (0 disables white and 1/f noise). */
  ts: number;
  /** NALPHA: 1/f exponent (0 < alpha < 2); 0 disables 1/f noise. */
  alpha: number;
  /** NAMP: 1/f noise rms value (ignored by ngspice when NALPHA is 0). */
  oneOverFAmplitude: number;
  /** RTSAM: random-telegraph amplitude (0 disables RTS noise). */
  rtsAmplitude: number;
  /** RTSCAPT: mean trap capture time in seconds (ignored when RTSAM is 0). */
  rtsCaptureTime: number;
  /** RTSEMT: mean trap emission time in seconds (ignored when RTSAM is 0). */
  rtsEmissionTime: number;
}

/**
 * ngspice-47 random-value source (`TRRANDOM(TYPE TS [TD [PARAM1 [PARAM2]]])`):
 * a new random value every `ts` seconds after the delay `td`.
 */
export interface TransientRandomSource {
  type: 'trrandom';
  /** Explicit DC value, added to the random value as in ngspice. */
  dc?: number;
  /**
   * TYPE: 1 uniform in [-PARAM1+PARAM2, PARAM1+PARAM2[; 2 Gaussian (deviation
   * PARAM1, mean PARAM2); 3 exponential (mean PARAM1, offset PARAM2); 4 Poisson
   * (lambda PARAM1, offset PARAM2). ngspice yields 0 for any other value.
   */
  distribution: number;
  /** TS: interval between new values in seconds. */
  ts: number;
  /** TD: delay before the first new value in seconds. */
  td: number;
  /** PARAM1 (default 1). */
  param1: number;
  /** PARAM2 (default 0); also the value before the first draw. */
  param2: number;
}

/** AC small-signal source (AC). Used for `.ac` analysis excitation. */
export interface ACSource {
  type: 'ac';
  /** DC operating-point value used before small-signal AC excitation. */
  dc?: number;
  /** AC magnitude */
  magnitude: number;
  /** AC phase in degrees */
  phase: number;
}

/** AC small-signal excitation that coexists with a transient waveform. */
export interface ACExcitation {
  magnitude: number;
  phase: number;
}

/** Optional AC term carried alongside a transient source waveform. */
export interface SourceACTerm {
  ac?: ACExcitation;
}

/** One source's small-signal distortion excitation at F1 or F2. */
export interface DistortionExcitation {
  magnitude: number;
  phase: number;
}

/** Distortion annotations coexist with the source's DC/AC/transient waveform. */
export interface SourceDistortionTerms {
  distortionF1?: DistortionExcitation;
  distortionF2?: DistortionExcitation;
}

/**
 * ngspice-47 RF port on an independent voltage source
 * (`V1 in 0 dc 0 ac 1 portnum 1 z0 50 [pwr P] [freq F]`, RFSPICE vsrc).
 *
 * A port puts its reference impedance `z0` in series with the source through
 * an internal node `<name>.res` (ngspice `<name>#res`) in every analysis, and
 * makes the source one of the ports of an `.sp` analysis.
 */
export interface RFPort {
  /** `portnum`: 1-based port index; a circuit's ports are numbered 1..N. */
  number: number;
  /** `z0`: reference impedance in ohms (default 50). */
  z0: number;
  /**
   * Present when `pwr` or `freq` is given. ngspice then evaluates the source as
   * `sqrt(4*pwr*z0) * cos(2*pi*freq*t)` (defaults 1 mW, 1 GHz) everywhere except
   * a DC operating point of a source with an explicit DC value.
   */
  power?: {
    /** `pwr`: available power in watts. */
    watts: number;
    /** `freq`: frequency in Hz. */
    frequency: number;
    /** Explicit DC value, used for `.op`, `.dc` and the small-signal operating point. */
    dc?: number;
  };
}

/** Union of all source waveform types. Discriminated on the `type` field. */
export type SourceWaveform =
  (DCSource | PulseSource | SinSource | PWLSource | ExpSource | SffmSource | AmSource
    | TransientNoiseSource | TransientRandomSource | ACSource)
  & SourceACTerm & SourceDistortionTerms;

/** Warning collected during simulation (non-fatal). */
export interface SimulationWarning {
  /** Warning category (e.g., `'convergence'`, `'topology'`) */
  type: string;
  /** Human-readable warning message */
  message: string;
  /** Stable machine-readable diagnostic code, when available. */
  code?: string;
  /** One-based source line for parser diagnostics, when available. */
  line?: number;
  /** Related node name, if applicable */
  node?: string;
}

/** Aggregate Newton-Raphson and fallback work performed by DC analyses. */
export interface DCConvergenceTelemetry {
  /** Newton-Raphson iterations across every attempted DC solve. */
  newtonIterations: number;
  /** DC solves that converged, including homotopy intermediate solves. */
  acceptedSolves: number;
  /** DC solves that exhausted their Newton iteration budget. */
  rejectedSolves: number;
  /** Source-ramping homotopy levels attempted. */
  sourceStepAttempts: number;
  /** Source-ramping levels that did not converge. */
  sourceStepFailures: number;
  /** GMIN-stepping homotopy levels attempted. */
  gminStepAttempts: number;
  /** GMIN-stepping levels that did not converge. */
  gminStepFailures: number;
  /** Terminal failure classification; recoverable retries leave this null. */
  failure: import('./errors.js').ConvergenceFailureKind | null;
}

/** Aggregate adaptive-step and Newton work performed by transient analyses. */
export interface TransientConvergenceTelemetry {
  /** Timesteps committed to the output waveform (the t=0 DC point is excluded). */
  acceptedSteps: number;
  /** Attempted timesteps rejected for either Newton or LTE reasons. */
  rejectedSteps: number;
  /** Newton-Raphson iterations across accepted and rejected attempts. */
  newtonIterations: number;
  /** Timesteps retried after Newton-Raphson failed to converge. */
  nrRetries: number;
  /** Timesteps retried after the local truncation error check failed. */
  lteRetries: number;
  /** Smallest committed timestep, or null when no transient step was accepted. */
  minimumAcceptedTimestep: number | null;
  /** Terminal failure classification; recoverable retries leave this null. */
  failure: import('./errors.js').ConvergenceFailureKind | null;
}

/** Bounded, deterministic convergence counters for a simulation run. */
export interface ConvergenceTelemetry {
  dc: DCConvergenceTelemetry;
  transient: TransientConvergenceTelemetry;
}

/**
 * Async function that resolves `.include` and `.lib` file paths to their contents.
 *
 * @param path - File path as it appears in the `.include` or `.lib` directive
 * @returns The file contents as a string
 */
export type IncludeResolver = (path: string) => Promise<string>;

/**
 * Subcircuit definition parsed from a `.subckt`/`.ends` block.
 */
export interface SubcktDefinition {
  /** Subcircuit name (case-insensitive) */
  name: string;
  /** Ordered list of port node names */
  ports: string[];
  /**
   * Default parameter values (can be overridden per instance), in declaration
   * order. A string is a numparam expression (`'20e3/stime'`), evaluated per
   * instance like ngspice-47: after the instance overrides, over the earlier
   * parameters of the same definition and the top-level `.param` values.
   */
  params: Record<string, number | string>;
  /** Raw netlist lines between `.subckt` and `.ends` */
  body: string[];
  /**
   * Deck line number of each `body` line, so errors in the body point at the
   * source card. Without it, errors give line numbers relative to the body.
   */
  bodyLines?: number[];
}

/** Sweep mode for .step directive */
export type StepSweepMode = 'lin' | 'dec' | 'oct' | 'list';

/** .step directive — parametric sweep configuration. */
export interface StepAnalysis {
  type: 'step';
  /** Device name to sweep (e.g., 'R1') */
  param: string;
  /** Sweep mode */
  sweepMode: StepSweepMode;
  /** Start value (lin/dec/oct) */
  start?: number;
  /** Stop value (lin/dec/oct) */
  stop?: number;
  /** Step increment (lin) */
  increment?: number;
  /** Points per decade or octave (dec/oct) */
  points?: number;
  /** Explicit list of values (list mode) */
  values?: number[];
}

/**
 * A single streaming event from a stepped simulation.
 * Wraps a TransientStep or ACPoint with step metadata.
 */
export interface StepStreamEvent {
  stepIndex: number;
  paramName: string;
  paramValue: number;
  point: TransientStep | ACPoint;
}
