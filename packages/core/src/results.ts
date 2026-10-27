import { getCaseInsensitive } from './case-fold.js';
import type { DigitalNodeEvent } from './devices/xspice/event-network.js';
import type { ConvergenceTelemetry, SimulationWarning } from './types.js';

/**
 * Result of a DC operating point (`.op`) analysis.
 *
 * Contains the steady-state node voltages and branch currents.
 */
export class DCResult {
  constructor(
    private readonly voltageMap: Map<string, number>,
    private readonly currentMap: Map<string, number>,
  ) {}

  /**
   * Get the DC voltage at a node.
   *
   * @param node - Node name as it appears in the netlist
   * @returns Voltage in volts
   * @throws Error if the node name is not found in the result
   */
  voltage(node: string): number {
    const v = getCaseInsensitive(this.voltageMap, node);
    if (v === undefined) throw new Error(`Unknown node: ${node}`);
    return v;
  }

  /**
   * Get the DC current through a voltage source or inductor branch.
   *
   * @param source - Branch device name (e.g., `'V1'`)
   * @returns Current in amps
   * @throws Error if the branch name is not found in the result
   */
  current(source: string): number {
    const i = getCaseInsensitive(this.currentMap, source);
    if (i === undefined) throw new Error(`Unknown branch: ${source}`);
    return i;
  }

  /** Copy of all node voltages as a Map. */
  get voltages(): Map<string, number> {
    return new Map(this.voltageMap);
  }

  /** Copy of all branch currents as a Map. */
  get currents(): Map<string, number> {
    return new Map(this.currentMap);
  }
}

/**
 * Result of a transient (`.tran`) analysis.
 *
 * Contains time-domain waveforms for all nodes and branches.
 */
export class TransientResult {
  /** `.four` tables. Harmonic zero is the signed DC component. */
  fourier?: FourierResult[];

  constructor(
    /** Array of time points in seconds. */
    public readonly time: number[],
    private readonly voltageArrays: Map<string, number[]>,
    private readonly currentArrays: Map<string, number[]>,
    private readonly digitalHistories: Map<string, DigitalNodeEvent[]> = new Map(),
    /** Saved device quantities sampled at exactly the returned time points. */
    public readonly deviceVectors: Map<string, Float64Array> = new Map(),
  ) {}

  /**
   * Get the value changes of an XSPICE digital (event-driven) node: its
   * operating-point value at time 0, then one entry per accepted change,
   * like ngspice `eprint`.
   *
   * @param node - Digital node name as it appears in the netlist
   * @throws Error if the node is not a digital node of the circuit
   */
  digital(node: string): DigitalNodeEvent[] {
    const events = getCaseInsensitive(this.digitalHistories, node);
    if (events === undefined) throw new Error(`Unknown digital node: ${node}`);
    return events;
  }

  /** Copy of every digital node's value changes as a Map. */
  get digitalNodes(): Map<string, DigitalNodeEvent[]> {
    return new Map(this.digitalHistories);
  }

  /**
   * Get the voltage waveform at a node over time.
   *
   * @param node - Node name as it appears in the netlist
   * @returns Array of voltage values (one per time point)
   * @throws Error if the node name is not found in the result
   */
  voltage(node: string): number[] {
    const v = getCaseInsensitive(this.voltageArrays, node);
    if (v === undefined) throw new Error(`Unknown node: ${node}`);
    return v;
  }

  /**
   * Get the current waveform through a branch over time.
   *
   * @param source - Branch device name (e.g., `'V1'`)
   * @returns Array of current values (one per time point)
   * @throws Error if the branch name is not found in the result
   */
  current(source: string): number[] {
    const i = getCaseInsensitive(this.currentArrays, source);
    if (i === undefined) throw new Error(`Unknown branch: ${source}`);
    return i;
  }

  /** Copy of all node voltage waveforms as a Map. */
  get voltages(): Map<string, number[]> {
    return new Map(this.voltageArrays);
  }

  /** Copy of all branch current waveforms as a Map. */
  get currents(): Map<string, number[]> {
    return new Map(this.currentArrays);
  }
}

/**
 * Result of an AC small-signal (`.ac`) analysis.
 *
 * Contains frequency-domain magnitude and phase data for all nodes and branches.
 */
export class ACResult {
  constructor(
    /** Array of frequency points in Hz. */
    public readonly frequencies: number[],
    private readonly voltageArrays: Map<string, { magnitude: number; phase: number }[]>,
    private readonly currentArrays: Map<string, { magnitude: number; phase: number }[]>,
  ) {}

  /**
   * Get the AC voltage response at a node across all frequencies.
   *
   * @param node - Node name as it appears in the netlist
   * @returns Array of `{ magnitude, phase }` objects (one per frequency point; phase in degrees)
   * @throws Error if the node name is not found in the result
   */
  voltage(node: string): { magnitude: number; phase: number }[] {
    const v = getCaseInsensitive(this.voltageArrays, node);
    if (v === undefined) throw new Error(`Unknown node: ${node}`);
    return v;
  }

  /**
   * Get the AC current response through a branch across all frequencies.
   *
   * @param source - Branch device name (e.g., `'V1'`)
   * @returns Array of `{ magnitude, phase }` objects (one per frequency point; phase in degrees)
   * @throws Error if the branch name is not found in the result
   */
  current(source: string): { magnitude: number; phase: number }[] {
    const i = getCaseInsensitive(this.currentArrays, source);
    if (i === undefined) throw new Error(`Unknown branch: ${source}`);
    return i;
  }

  /** Copy of all node voltage phasors as a Map. */
  get voltages(): Map<string, { magnitude: number; phase: number }[]> {
    return new Map(this.voltageArrays);
  }

  /** Copy of all branch current phasors as a Map. */
  get currents(): Map<string, { magnitude: number; phase: number }[]> {
    return new Map(this.currentArrays);
  }
}

/** Spectral output-voltage and input-referred noise densities from a `.noise` analysis. */
export class NoiseResult {
  constructor(
    /** Frequency points in Hz. */
    public readonly frequencies: number[],
    /** Output node named by the `.noise` command. */
    public readonly outputNode: string,
    /** Input source named by the `.noise` command. */
    public readonly inputSource: string,
    /** Output-referred voltage-noise density in V/sqrt(Hz), or V^2/Hz when squared. */
    public readonly outputNoiseDensity: number[],
    /**
     * Input-referred noise density: V/sqrt(Hz) for a voltage input source or
     * A/sqrt(Hz) for a current input source. With squared=true, V^2/Hz or A^2/Hz.
     */
    public readonly inputNoiseDensity: number[],
    /** Integrated output noise in V (V^2 when squared), absent for a zero-width sweep. */
    public readonly integratedOutputNoise: number | undefined,
    /**
     * Integrated input-referred RMS noise: V for a voltage input source or A
     * for a current input source (V^2 or A^2 when squared); absent for a zero-width sweep.
     */
    public readonly integratedInputNoise: number | undefined,
    /** Optional negative output node for a differential voltage result. */
    public readonly outputReferenceNode?: string,
    /** `set sqrnoise`: power spectra and integrated power instead of RMS amplitudes. */
    public readonly squared = false,
  ) {}
}

/** Convert only the output units; the solver and integration remain unchanged. */
export function squaredNoiseOutput(noise: NoiseResult): NoiseResult {
  if (noise.squared) return noise;
  // ngspice-47 noisean.c:242 selects power output. nevalsrc.c:100-115
  // computes power; cktnoise.c:110-126 skips sqrt for BOTH plot kinds.
  return new NoiseResult(
    noise.frequencies, noise.outputNode, noise.inputSource,
    noise.outputNoiseDensity.map(value => value * value),
    noise.inputNoiseDensity.map(value => value * value),
    noise.integratedOutputNoise === undefined ? undefined : noise.integratedOutputNoise ** 2,
    noise.integratedInputNoise === undefined ? undefined : noise.integratedInputNoise ** 2,
    noise.outputReferenceNode, true,
  );
}

/** Rectangular complex value of an S-parameter analysis vector. */
export interface ComplexValue {
  real: number;
  imaginary: number;
}

/**
 * S-parameter analysis result (from `.sp`), with ngspice-47's vector names:
 * `S_i_j`, `Y_i_j`, `Z_i_j` for every port pair, plus with `donoise = 1` the
 * port noise-current correlation matrix `Cy_i_j` (A²/Hz; ngspice writes these
 * as `i(Cy_i_j)`) and, for exactly two ports, `NF`, `SOpt`, `NFmin` (dB) and
 * `Rn` (ohms).
 */
export class SParameterResult {
  constructor(
    /** Frequency points in Hz. */
    public readonly frequencies: number[],
    /** Port source names; entry `i` is port `i + 1`. */
    public readonly ports: string[],
    /** Complex vectors keyed by ngspice name, one value per frequency. */
    public readonly vectors: Map<string, ComplexValue[]>,
    /** RF port reference impedances, in port order (ohms). */
    public readonly referenceImpedances: number[] = ports.map(() => 50),
  ) {}

  /**
   * Get a vector by ngspice name, case-insensitively (`'S_2_1'`, `'cy_1_1'`).
   *
   * @throws Error if the analysis produced no such vector
   */
  vector(name: string): ComplexValue[] {
    for (const [key, values] of this.vectors) {
      if (key.toLowerCase() === name.toLowerCase()) return values;
    }
    throw new Error(`Unknown S-parameter vector '${name}'`);
  }
}

/** Rectangular complex distortion component. */
export interface ComplexDistortionValue {
  real: number;
  imaginary: number;
}

/** Harmonic products included in the bounded single-tone result. */
export type DistortionOrder = 2 | 3;

/** Intermodulation products included in the bounded two-tone result. */
export type DistortionIntermodulationProduct = 'f1+f2' | 'f1-f2' | '2f1-f2';

/** Product selector for a bounded single- or two-tone distortion result. */
export type DistortionProduct = DistortionOrder | DistortionIntermodulationProduct;

/** Deterministic harmonic or intermodulation results from a bounded `.disto`. */
export class DistortionResult {
  public readonly products: readonly DistortionProduct[];

  constructor(
    /** Swept F1 frequencies in ascending order. */
    public readonly frequencies: number[],
    private readonly voltageArrays: Map<DistortionProduct, Map<string, ComplexDistortionValue[]>>,
    private readonly currentArrays: Map<DistortionProduct, Map<string, ComplexDistortionValue[]>>,
    /** Fixed F2/start-F1 ratio for two-tone results. */
    public readonly f2OverF1?: number,
  ) {
    this.products = [...voltageArrays.keys()];
  }

  voltage(node: string, product: DistortionProduct): ComplexDistortionValue[] {
    const arrays = this.voltageArrays.get(product);
    if (!arrays) throw new Error(`Distortion product ${product} is unavailable for this analysis`);
    const values = getCaseInsensitive(arrays, node);
    if (!values) throw new Error(`Unknown node: ${node}`);
    return values.map(value => ({ ...value }));
  }

  current(branch: string, product: DistortionProduct): ComplexDistortionValue[] {
    const arrays = this.currentArrays.get(product);
    if (!arrays) throw new Error(`Distortion product ${product} is unavailable for this analysis`);
    const values = getCaseInsensitive(arrays, branch);
    if (!values) throw new Error(`Unknown branch: ${branch}`);
    return values.map(value => ({ ...value }));
  }
}

/** Scalar small-signal quantities from a bounded `.tf` analysis. */
export class TransferFunctionResult {
  constructor(
    /** Output node for voltage-output analysis; undefined for current output. */
    public readonly outputNode: string | undefined,
    /** Independent input source named by the `.tf` command. */
    public readonly inputSource: string,
    /** Voltage/current gain or transimpedance/transconductance. */
    public readonly transfer: number,
    /** Small-signal resistance seen by the input source, in ohms. */
    public readonly inputResistance: number,
    /** Ngspice-compatible small-signal output resistance, in ohms. */
    public readonly outputResistance: number,
    /** Output voltage source for current-output analysis; undefined for voltage output. */
    public readonly outputSource?: string,
  ) {}
}

/** One finite pole or zero in radians per second. */
export interface PoleZeroValue {
  real: number;
  imaginary: number;
}

/** Deterministically ordered finite poles and zeros from a bounded `.pz` analysis. */
export class PoleZeroResult {
  constructor(
    public readonly inputPositive: string,
    public readonly inputNegative: string,
    public readonly outputPositive: string,
    public readonly outputNegative: string,
    public readonly poles: PoleZeroValue[],
    public readonly zeros: PoleZeroValue[],
  ) {}
}

/** One rectangular complex sensitivity value. */
export interface ComplexSensitivityValue {
  real: number;
  imaginary: number;
}

/**
 * Sensitivity to one device parameter: a non-zero primary value, or the instance
 * multiplier `m` (ngspice `<dev>_m`) or `scale` (ngspice `<dev>_scale`) of a
 * resistor, capacitor, inductor or current source (`scale`: R, C and L only).
 * DC BJTs additionally expose positive IS/BF/NF/VAF/BR/NR as `bjt:<name>`
 * (ngspice `<dev>:<name>`), and the instance multiplier (`<dev>_m`).
 */
export interface SensitivityEntry {
  device: string;
  /** Nominal parameter value used for the perturbation (before any scaling). */
  value: number;
  parameter:
    | 'resistance' | 'capacitance' | 'inductance' | 'dc' | 'acMagnitude' | 'gain'
    | 'multiplier' | 'scale'
    | 'bjt:is' | 'bjt:bf' | 'bjt:nf' | 'bjt:vaf' | 'bjt:br' | 'bjt:nr';
  dc?: number;
  ac?: ComplexSensitivityValue[];
}

/** Deterministically ordered results from the bounded `.sens` slice. */
export class SensitivityResult {
  constructor(
    public readonly outputNode: string,
    public readonly mode: 'dc' | 'ac',
    public readonly frequencies: number[],
    public readonly entries: SensitivityEntry[],
    public readonly outputReferenceNode?: string,
    public readonly outputType?: 'voltage' | 'current',
  ) {}
}

/**
 * Result of a DC sweep (`.dc`) analysis.
 *
 * Contains node voltages and branch currents at each sweep point.
 */
export class DCSweepResult {
  constructor(
    /** Array of swept source values (e.g., voltage in volts). */
    public readonly sweepValues: Float64Array,
    private readonly voltageArrays: Map<string, Float64Array>,
    private readonly currentArrays: Map<string, Float64Array>,
    /** Point-aligned outer sweep coordinates, when a second source is swept. */
    public readonly secondarySweepValues?: Float64Array,
    /** Explicitly saved device outputs, sampled at each DC operating point. */
    public readonly deviceVectors: Map<string, Float64Array> = new Map(),
  ) {}

  /**
   * Get the voltage at a node across all sweep points.
   *
   * @param node - Node name as it appears in the netlist
   * @returns Float64Array of voltage values (one per sweep point)
   * @throws Error if the node name is not found in the result
   */
  voltage(node: string): Float64Array {
    const v = getCaseInsensitive(this.voltageArrays, node);
    if (v === undefined) throw new Error(`Unknown node: ${node}`);
    return v;
  }

  /**
   * Get the current through a branch across all sweep points.
   *
   * @param source - Branch device name (e.g., `'V1'`)
   * @returns Float64Array of current values (one per sweep point)
   * @throws Error if the branch name is not found in the result
   */
  current(source: string): Float64Array {
    const i = getCaseInsensitive(this.currentArrays, source);
    if (i === undefined) throw new Error(`Unknown branch: ${source}`);
    return i;
  }

  /** Copy of all node voltage sweeps as a Map. */
  get voltages(): Map<string, Float64Array> {
    return new Map(this.voltageArrays);
  }

  /** Copy of all branch current sweeps as a Map. */
  get currents(): Map<string, Float64Array> {
    return new Map(this.currentArrays);
  }
}

/**
 * Result of a single parametric step.
 * Contains the same result fields as a non-stepped simulation.
 */
export interface StepResult {
  /** Name of the swept parameter or device */
  paramName: string;
  /** Value of the parameter for this step */
  paramValue: number;
  /** DC operating point result (from .op) */
  dc?: DCResult;
  /** DC sweep result (from .dc) */
  dcSweep?: DCSweepResult;
  /** Transient analysis result (from .tran) */
  transient?: TransientResult;
  /** AC small-signal analysis result (from .ac) */
  ac?: ACResult;
  /** DC small-signal transfer function (from .tf) */
  transferFunction?: TransferFunctionResult;
}

/**
 * Aggregate result object returned by {@link simulate}.
 *
 * Each field is populated only if the corresponding analysis was requested
 * in the netlist. For example, `.op` populates `dc`, `.tran` populates `transient`.
 */
export interface SimulationResult {
  /**
   * Every native analysis run when a non-stepped, non-interpreted-control deck
   * executes at least two analyses. Includes straight-line `.control` commands
   * lowered onto analysis cards. Absent for a single analysis and `.step`.
   * Order is native source order of dot cards, followed by `.pz` cards;
   * legacy top-level fields still contain the last run of each type.
   */
  analyses?: DotAnalysisRun[];
  /** DC operating point result (from `.op`) */
  dc?: DCResult;
  /** DC sweep result (from `.dc`) */
  dcSweep?: DCSweepResult;
  /** Transient analysis result (from `.tran`) */
  transient?: TransientResult;
  /** AC small-signal analysis result (from `.ac`) */
  ac?: ACResult;
  /** Resistor-noise spectral result (from `.noise`) */
  noise?: NoiseResult;
  /** S-, Y-, Z-parameters over the RF ports (from `.sp`). */
  sParameters?: SParameterResult;
  /** Bounded harmonic or intermodulation result (from `.disto`). */
  distortion?: DistortionResult;
  /** DC small-signal transfer function (from `.tf`) */
  transferFunction?: TransferFunctionResult;
  /** Finite poles and zeros (in rad/s) from `.pz`. */
  poleZero?: PoleZeroResult;
  /** Primary-value sensitivities from the bounded `.sens` slice. */
  sensitivity?: SensitivityResult;
  /** Parametric sweep results (from .step). When present, top-level result fields are empty. */
  steps?: StepResult[];
  /**
   * `.meas`/`.measure` results, evaluated like ngspice-47 after each `.tran`,
   * `.ac` and `.dc` analysis, in card order. A measurement ngspice fails
   * (out of interval, bad syntax, unknown vector, ...) is listed with
   * `status: 'failed'` and ngspice's reason.
   */
  measurements?: MeasurementResult[];
  /**
   * Execution record of an interpreted ngspice `.control` script. When present,
   * each top-level analysis field holds the latest run of that analysis type:
   * the deck's own dot-card run that ngspice performs after the script (unless
   * the script ends with `quit`), otherwise the script's last run of that type.
   */
  control?: ControlScriptResult;
  /** Warnings collected during simulation */
  warnings: SimulationWarning[];
  /** Native-solver convergence counters. External adapters may omit them. */
  convergence?: ConvergenceTelemetry;
}

/** One retained native dot-card (or lowered straight-line control) analysis. */
export interface DotAnalysisRun {
  /** Zero-based native execution order: analysis cards first, then `.pz`. */
  index: number;
  analysis: 'op' | 'dc' | 'ac' | 'tran' | 'noise' | 'sp' | 'disto' | 'tf' | 'sens' | 'pz';
  /**
   * Only this run's analysis field (`op` -> `dc`, `dc` -> `dcSweep`,
   * `tran` -> `transient`, `sp` -> `sParameters`, `disto` -> `distortion`,
   * `tf` -> `transferFunction`, `sens` -> `sensitivity`, `pz` -> `poleZero`)
   * and any `.meas` results evaluated immediately after it. Measurements are
   * omitted when none were evaluated. Warnings are empty; convergence,
   * analyses, steps and control are absent. No analysis is rerun for retention.
   */
  result: SimulationResult;
}

/** One evaluated `.meas` card. Names follow ngspice: lower-cased as in the deck. */
export interface MeasurementResult {
  /** Result name (second word of the card), lower-cased. */
  name: string;
  /** Analysis the card measures: `tran`, `ac` or `dc`. */
  analysis: string;
  /** Measure function as written (third word), lower-cased: `trig`, `find`, `when`, `avg`, `param`, ... */
  function: string;
  /** 1-based netlist line of the card. */
  line: number;
  /** `failed` when ngspice-47 reports the measurement as failed. */
  status: 'ok' | 'failed';
  /** Measured value (`targ - trig` for TRIG/TARG, the x position for MIN_AT/MAX_AT). */
  value?: number;
  /** TRIG/TARG: trigger and target positions on the analysis scale. */
  trig?: number;
  targ?: number;
  /** MIN/MAX: scale position of the extremum. */
  at?: number;
  /** MIN_AT/MAX_AT: the extremum value. */
  with?: number;
  /** AVG/RMS/INTEG/PP: the window ngspice reports. */
  from?: number;
  to?: number;
  /** Why the measurement failed, in ngspice-47's words. */
  error?: string;
}

/** One analysis run by an ngspice `.control` script. */
export interface ControlScriptRun {
  /** ngspice plot name of the run, e.g. `tran1`, `dc3`, `noise2`. */
  plot: string;
  /** Analysis type: `op`, `dc`, `ac`, `tran`, `noise`, ... */
  analysis: string;
  /** Result fields of this one run. */
  result: SimulationResult;
}

/** Harmonic table from one control-language Fourier operand. */
export interface FourierResult {
  vector: string;
  fundamental: number;
  gridSize: number;
  degree: number;
  periods: number;
  /** Total harmonic distortion in percent, excluding DC and the fundamental. */
  thd: number;
  harmonics: {
    harmonic: number;
    frequency: number;
    magnitude: number;
    /** Sine-reference phase in degrees. */
    phase: number;
    normalizedMagnitude: number;
    normalizedPhase: number;
  }[];
}

/** What an interpreted `.control` script did. */
export interface ControlScriptResult {
  /** Files emitted by control commands. Paths are deck-requested, not filesystem authorization. */
  files?: { path: string; contents: string }[];
  /** Every analysis the script ran, in execution order. */
  runs: ControlScriptRun[];
  /** Lines the script printed with `echo`. */
  output: string[];
  /** True when the script ended with `quit`/`exit` status 0, so the deck's own analyses were not run afterwards. */
  quit: boolean;
  /** Every `meas` command the script ran, in order (failed ones with ngspice's reason). */
  measurements: MeasurementResult[];
  /** Fourier commands in execution order, one entry per operand. */
  fourier?: FourierResult[];
}
