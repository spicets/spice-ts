import type { ConvergenceTelemetry } from './types.js';

/**
 * Base class for all spice-ts errors.
 */
export class SpiceError extends Error {
  /** Stable machine-readable discriminator; subclasses may supply a more specific code. */
  readonly code: string = 'SPICE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'SpiceError';
  }
}

/**
 * Thrown when a netlist cannot be parsed due to syntax errors.
 *
 * Contains the line number and raw text of the offending line.
 */
export class ParseError extends SpiceError {
  /** Stable code for netlist syntax errors. */
  readonly code: string = 'PARSE_ERROR';

  constructor(
    message: string,
    /** 1-based line number where the error occurred */
    public readonly line: number,
    /** Raw text of the line that caused the error */
    public readonly context: string,
  ) {
    super(`Parse error at line ${line}: ${message}\n  ${context}`);
    this.name = 'ParseError';
  }
}

/**
 * Thrown when the circuit structure is invalid (e.g., no analysis command).
 */
export class InvalidCircuitError extends SpiceError {
  /** Stable code for invalid circuit structure. */
  readonly code: string = 'INVALID_CIRCUIT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidCircuitError';
  }
}

/**
 * Thrown when the MNA system matrix is singular and cannot be solved.
 *
 * Typically indicates a topology error such as a voltage source loop
 * or a floating node.
 */
export interface MatrixVariableIdentity {
  /** Whether this MNA unknown is a node voltage or branch current. */
  kind: 'node' | 'branch';
  /** Circuit-level node or branch/source name. */
  name: string;
}

export class SingularMatrixError extends SpiceError {
  /** Stable code for an unsolvable singular MNA system. */
  readonly code = 'SINGULAR_MATRIX';

  constructor(
    message: string,
    /** Node names involved in the singularity */
    public readonly involvedNodes: string[],
    /** Branch or source names involved in the singularity */
    public readonly involvedBranches: string[] = [],
    /** Zero-based MNA matrix index of the failed pivot */
    public readonly pivotIndex?: number,
  ) {
    const identities = [
      `nodes: ${involvedNodes.join(', ')}`,
      ...(involvedBranches.length > 0 ? [`branches: ${involvedBranches.join(', ')}`] : []),
    ];
    super(`Singular matrix: ${message} (${identities.join('; ')})`);
    this.name = 'SingularMatrixError';
  }

  /** Build a bounded diagnostic directly from the failed matrix variable. */
  static atPivot(
    pivotIndex: number,
    variables: readonly MatrixVariableIdentity[] = [],
  ): SingularMatrixError {
    const variable = variables[pivotIndex];
    return new SingularMatrixError(
      `zero pivot at matrix column ${pivotIndex}`,
      variable?.kind === 'node' ? [variable.name] : [],
      variable?.kind === 'branch' ? [variable.name] : [],
      pivotIndex,
    );
  }
}

/** Discriminator for {@link ConvergenceError} subclasses. */
export type ConvergenceFailureKind = 'nr-divergence' | 'lte-cascade' | 'dt-floor';

/**
 * Thrown when Newton-Raphson iteration fails to converge within the
 * allowed number of iterations, when LTE rejects too many steps in a row,
 * or when the adaptive timestep shrinks below the floor.
 *
 * Contains diagnostic information including the oscillating nodes,
 * the last two solution vectors, the timestep and GMIN value in effect,
 * and a `kind` discriminator identifying the failure mode.
 */
export class ConvergenceError extends SpiceError {
  /** Stable code for convergence failure; timestep-floor failures specialize it. */
  readonly code: string = 'CONVERGENCE_FAILED';

  public readonly kind: ConvergenceFailureKind;
  /** Bounded counters accumulated before this terminal failure. */
  public convergence?: ConvergenceTelemetry;

  constructor(
    message: string,
    /** Simulation time at which convergence failed (undefined for DC) */
    public readonly time: number | undefined,
    /** Nodes that were oscillating at the time of failure */
    public readonly oscillatingNodes: string[],
    /** Solution vector from the last iteration */
    public readonly lastSolution: Float64Array,
    /** Solution vector from the second-to-last iteration */
    public readonly prevSolution: Float64Array,
    /** Failure mode discriminator. Defaults to `'nr-divergence'`. */
    kind: ConvergenceFailureKind = 'nr-divergence',
    /** Timestep in effect when the failure occurred (undefined for DC) */
    public readonly dt?: number,
    /** GMIN value in effect at the time of failure */
    public readonly gmin?: number,
  ) {
    super(
      `Convergence failed${time !== undefined ? ` at t=${time}` : ''}: ${message}` +
        (oscillatingNodes.length > 0 ? ` (oscillating nodes: ${oscillatingNodes.join(', ')})` : ''),
    );
    this.name = 'ConvergenceError';
    this.kind = kind;
  }
}

/**
 * Thrown during transient analysis when the adaptive timestep shrinks
 * below the minimum threshold (see `MIN_TIMESTEP` in `transient-driver.ts`).
 *
 * Subclass of {@link ConvergenceError} with `kind === 'dt-floor'`.
 */
export class TimestepTooSmallError extends ConvergenceError {
  /** Stable code for the adaptive timestep reaching its minimum. */
  readonly code = 'TIMESTEP_TOO_SMALL';

  constructor(
    /** Simulation time at which the error occurred */
    time: number,
    /** The timestep that was too small */
    public readonly timestep: number,
    convergence?: ConvergenceTelemetry,
  ) {
    super(
      `Timestep too small: dt=${timestep}`,
      time, [], new Float64Array(0), new Float64Array(0),
      'dt-floor', timestep, undefined,
    );
    this.name = 'TimestepTooSmallError';
    this.convergence = convergence;
    // Override the message to preserve the old format verbatim so string
    // comparisons in consumer code keep working.
    this.message = `Timestep too small at t=${time}: dt=${timestep}`;
  }
}

/**
 * Thrown when a circular dependency is detected in `.include`/`.lib`
 * directives or subcircuit instantiation.
 */
export class CycleError extends SpiceError {
  /** Stable code for circular include or subcircuit dependencies. */
  readonly code = 'CYCLE';

  constructor(
    /** The dependency chain that forms the cycle */
    public readonly chain: string[],
  ) {
    super(`Circular dependency detected: ${chain.join(' → ')}`);
    this.name = 'CycleError';
  }
}

/**
 * Thrown when a MOSFET model card selects a `LEVEL` that spice-ts does not
 * implement (for example MOS level 7). Such cards used to run the
 * Level-1 equations silently.
 */
export class UnsupportedModelLevelError extends InvalidCircuitError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_MODEL_LEVEL';

  constructor(
    /** Instance name, e.g. `M1` */
    public readonly deviceName: string,
    /** Model card name, when the instance was compiled from a netlist */
    public readonly modelName: string | undefined,
    /** Requested `LEVEL` value */
    public readonly level: number,
    /** Levels spice-ts implements for this device kind */
    public readonly supportedLevels: readonly number[],
  ) {
    super(
      `MOSFET '${deviceName}'${modelName ? ` (model '${modelName}')` : ''} uses unsupported model LEVEL=${level}`
        + ` (supported MOSFET levels: ${supportedLevels.join(', ')})`,
    );
    this.name = 'UnsupportedModelLevelError';
  }
}

/**
 * Thrown when a MOSFET model card selects, through its `VERSION=` string, a revision of a
 * supported `LEVEL` that spice-ts does not implement. ngspice picks BSIM3v0/v1 for
 * `LEVEL=8/49 VERSION=3.0/3.1`; spice-ts implements the BSIM3v32 (3.2.x) and default BSIM3
 * 3.3 revisions only and never runs those cards with other equations silently.
 */
export class UnsupportedModelVersionError extends InvalidCircuitError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_MODEL_VERSION';

  constructor(
    /** Instance name, e.g. `M1` */
    public readonly deviceName: string,
    /** Model card name, when the instance was compiled from a netlist */
    public readonly modelName: string | undefined,
    /** Model `LEVEL` value */
    public readonly level: number,
    /** Requested `VERSION=` string */
    public readonly version: string,
    /** Version prefixes spice-ts implements for this level */
    public readonly supportedVersions: readonly string[],
  ) {
    super(
      `MOSFET '${deviceName}'${modelName ? ` (model '${modelName}')` : ''} uses unsupported LEVEL=${level}`
        + ` VERSION=${version} (supported versions: ${supportedVersions.join(', ')})`,
    );
    this.name = 'UnsupportedModelVersionError';
  }
}

/**
 * Thrown when a model registered through the Circuit API, a subcircuit body
 * or the JSON protocol declares a `.model` type that no spice-ts device
 * implements. The netlist parser raises the {@link ParseError} subclass
 * `UnsupportedModelTypeError` (same `code`) for the same condition, with a
 * line number.
 */
export class UnsupportedCircuitModelTypeError extends InvalidCircuitError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_MODEL_TYPE';

  constructor(
    /** Model name */
    public readonly modelName: string,
    /** Upper-cased model type */
    public readonly modelType: string,
    /** Model types spice-ts implements */
    public readonly supportedTypes: readonly string[],
  ) {
    super(
      `.model '${modelName}' has unsupported type '${modelType}'`
        + ` (supported: ${supportedTypes.join(', ')})`,
    );
    this.name = 'UnsupportedCircuitModelTypeError';
  }
}

/**
 * Thrown when an instance references a model whose type belongs to another
 * device kind, e.g. a MOSFET (`M`) card naming an `NPN` model. ngspice rejects
 * these; simulating them would silently run the wrong device equations.
 */
export class ModelTypeMismatchError extends InvalidCircuitError {
  /** Stable machine-readable error code. */
  readonly code = 'MODEL_TYPE_MISMATCH';

  constructor(
    /** Instance name, e.g. `M1` */
    public readonly deviceName: string,
    /** SPICE instance letter, e.g. `M` */
    public readonly deviceKind: string,
    /** Referenced model name */
    public readonly modelName: string,
    /** Upper-cased type of the referenced model */
    public readonly modelType: string,
    /** Model types this device kind accepts */
    public readonly expectedTypes: readonly string[],
  ) {
    super(
      `${deviceKind} instance '${deviceName}' references model '${modelName}' of type '${modelType}'`
        + ` (expected: ${expectedTypes.join(', ')})`,
    );
    this.name = 'ModelTypeMismatchError';
  }
}

/**
/**
 * Thrown when a device instance or its model card sets a parameter that
 * ngspice-47 honours (or that the selected device model does not define) but
 * spice-ts does not implement, e.g. the diode sidewall resistance `RSW` or a
 * BSIM1 card's `VTO`. Such parameters used to be accepted and silently ignored.
 */
export class UnsupportedModelParameterError extends InvalidCircuitError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_MODEL_PARAMETER';
  /** Model card name, when known */
  public readonly modelName: string | undefined;
  /** Device model, e.g. `BSIM1`, when known */
  public readonly model: string | undefined;

  constructor(
    /** Instance name, e.g. `D1` (empty when the model card itself is rejected) */
    public readonly deviceName: string,
    /** Parameter name as written on the card */
    public readonly parameter: string,
    /** What the parameter does in ngspice and why it cannot be simulated */
    public readonly reason: string,
    context: { modelName?: string; model?: string } = {},
  ) {
    const subject = deviceName
      ? `Device '${deviceName}'`
      : `${context.model ? `${context.model} ` : ''}model '${context.modelName ?? '?'}'`;
    super(`${subject} uses unsupported model parameter '${parameter}': ${reason}`);
    this.modelName = context.modelName;
    this.model = context.model;
    this.name = 'UnsupportedModelParameterError';
  }
}

/**
 * Thrown when a circuit temperature other than the nominal one (`.options
 * TEMP`, `.step TEMP`) reaches a device, or a model parameter, whose ngspice
 * temperature law spice-ts does not implement. Such devices used to run at
 * 27 C silently (#374).
 */
export class UnsupportedTemperatureError extends InvalidCircuitError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_TEMPERATURE';

  constructor(
    /** Instance name, e.g. `D1` */
    public readonly deviceName: string,
    /** Requested device temperature in degrees Celsius */
    public readonly temperature: number,
    /** Model parameter without a temperature law; undefined when the whole device has none */
    public readonly parameter?: string,
  ) {
    super(
      parameter === undefined
        ? `Device '${deviceName}' has no ngspice temperature model in spice-ts`
          + ` and cannot be simulated at TEMP=${temperature} C`
        : `Device '${deviceName}' cannot be simulated at TEMP=${temperature} C: model parameter`
          + ` '${parameter}' has an ngspice temperature law that spice-ts does not implement`,
    );
    this.name = 'UnsupportedTemperatureError';
  }
}

/**
 * Thrown when a subcircuit instance with multiplicity `m` (the X-line `m=`,
 * including one inherited from an enclosing instance) contains a card that
 * ngspice-47 scales by `m` but spice-ts cannot (e.g. a G, F, current B or
 * JFET card). Simulating it with m = 1 would silently model a different
 * circuit.
 */
export class UnsupportedMultiplicityError extends InvalidCircuitError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_MULTIPLICITY';

  constructor(
    /** Flattened device name, e.g. `x1.g1` */
    public readonly deviceName: string,
    /** SPICE instance letter, e.g. `G` */
    public readonly deviceKind: string,
    /** Subcircuit instance path whose multiplicity reaches the device, e.g. `x1` */
    public readonly instanceName: string,
    /** Effective multiplicity of that instance */
    public readonly multiplicity: number,
  ) {
    super(
      `${deviceKind} device '${deviceName}' cannot be scaled by the multiplicity m=${multiplicity}`
        + ` of subcircuit instance '${instanceName}': spice-ts does not implement m for ${deviceKind} cards`,
    );
    this.name = 'UnsupportedMultiplicityError';
  }
}
