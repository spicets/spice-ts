import type { ChargeTruncation, DeviceModel, StampContext } from './device.js';

/**
 * ngspice-47 switch states (swload.c / cswload.c): on or off with the control
 * outside the hysteresis window, or on or off while it is inside it.
 */
export const REALLY_OFF = 0;
export const REALLY_ON = 1;
export const HYST_OFF = 2;
export const HYST_ON = 3;

export type SwitchState = typeof REALLY_OFF | typeof REALLY_ON | typeof HYST_OFF | typeof HYST_ON;

/** Resolved `.model SW` / `.model CSW` parameters. */
export interface SwitchModel {
  /** Threshold: VT (V) for SW, IT (A) for CSW. Default 0. */
  readonly threshold: number;
  /** Hysteresis: VH (V) for SW, IH (A) for CSW. Default 0; may be negative. */
  readonly hysteresis: number;
  /** 1 / RON; default 1 S. */
  readonly onConductance: number;
  /** 1 / ROFF; default CKTgmin. */
  readonly offConductance: number;
}

/** Model parameters each switch model type accepts (ngspice sw.c / csw.c). */
const SWITCH_MODEL_KEYS = {
  SW: { threshold: 'VT', hysteresis: 'VH' },
  CSW: { threshold: 'IT', hysteresis: 'IH' },
} as const;

/**
 * Resolve a `.model SW` or `.model CSW` card with the ngspice-47 defaults
 * (swsetup.c / cswsetup.c). Parameters the model type does not define are
 * returned as warnings; ngspice ignores them too.
 */
export function resolveSwitchModel(
  type: 'SW' | 'CSW',
  params: Readonly<Record<string, number>>,
  gmin: number,
): { model: SwitchModel; warnings: string[] } {
  const keys = SWITCH_MODEL_KEYS[type];
  const known = new Set<string>([keys.threshold, keys.hysteresis, 'RON', 'ROFF']);
  const warnings = Object.keys(params)
    .filter(key => !known.has(key))
    .map(key => `.model ${type} parameter '${key}' is not a ${type} parameter and is ignored`);
  return {
    model: {
      threshold: params[keys.threshold] ?? 0,
      hysteresis: params[keys.hysteresis] ?? 0,
      onConductance: params.RON === undefined ? 1 : 1 / params.RON,
      offConductance: params.ROFF === undefined ? gmin : 1 / params.ROFF,
    },
    warnings,
  };
}

/**
 * Which ngspice CKTmode the next load corresponds to:
 * - `init`: MODEINITJCT / MODEINITFIX of the DC operating point, where the
 *   state follows the instance ON/OFF flag;
 * - `predict`: MODEINITTRAN / MODEINITPRED, the first load of a timepoint,
 *   decided against the last accepted state;
 * - `float`: MODEINITFLOAT, every later Newton iteration.
 */
type LoadMode = 'init' | 'predict' | 'float';

/**
 * Shared ngspice-47 switch behaviour: a conductance that toggles between
 * RON and ROFF with a hysteresis state machine on a control quantity.
 *
 * The two ngspice devices differ in a few state-machine details (kept here
 * verbatim, quirks included) and in that only SW stores its control value,
 * so only SW limits the timestep (CSWtrunc never fires, see cswload.c).
 */
export abstract class SwitchBase implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (SWtrunc). */
  readonly truncationCoversCharges = true;
  /**
   * ngspice never damps node voltages; the switch is decided from the raw
   * Newton iterate. Also routes beginTransientNewton / limitedLastStamp.
   */
  readonly limitsOwnJunctions = true;

  /** ngspice CKTstate0[switchstate]: state decided by the last load. */
  private state: SwitchState = REALLY_OFF;
  /** ngspice CKTstate1[switchstate]: state at the last accepted timepoint. */
  private acceptedState: SwitchState = REALLY_OFF;
  /** ngspice CKTstate0[ctrlvalue]: control value read by the last load. */
  private control = 0;
  /** ngspice CKTstate1[ctrlvalue]: control value at the last accepted timepoint. */
  private acceptedControl = 0;
  private mode: LoadMode = 'init';
  /** Source scale of the last load; the DC init phase ends at full scale. */
  private lastSourceScale = 1;
  /** ngspice CKTnoncon from the last load. */
  private changedLastLoad = false;

  constructor(
    readonly name: string,
    readonly nodes: number[],
    protected readonly model: SwitchModel,
    /** Instance `ON` flag (ngspice SWzero_stateGiven); default OFF. */
    readonly initiallyOn: boolean,
    readonly modelWarnings: readonly string[] = [],
  ) {}

  /** Control quantity: V(nc+, nc-) for S, the controlling branch current for W. */
  protected abstract readControl(ctx: StampContext): number;
  /** Whether the hysteresis-window state of the float load follows state1 (CSW) or state0 (SW). */
  protected abstract readonly floatHoldsAcceptedState: boolean;
  /** States the predict load takes when entering a negative-hysteresis window. */
  protected abstract readonly predictWindowEntry: { fromOn: SwitchState; fromOff: SwitchState };

  /** Present state, for inspection and tests. */
  get currentState(): SwitchState {
    return this.state;
  }

  /** Conductance stamped by the last load (ngspice SWcond). */
  get conductance(): number {
    return isOn(this.state) ? this.model.onConductance : this.model.offConductance;
  }

  /**
   * Start a DC operating point. ngspice allocates zeroed state vectors and
   * does not advance CKTstate1 during the operating point, so the float load
   * of an operating point reads REALLY_OFF and a zero control as state1.
   */
  beginOperatingPoint(): void {
    this.mode = 'init';
    this.acceptedState = REALLY_OFF;
    this.acceptedControl = 0;
  }

  beginTransientNewton(): void {
    this.mode = 'predict';
  }

  resetTransient(): void {
    this.beginOperatingPoint();
  }

  stamp(ctx: StampContext): void {
    const control = this.readControl(ctx);
    const old = this.state;
    const mode = this.mode;
    let next: SwitchState;
    switch (mode) {
      case 'init':
        next = this.initialState(control);
        this.lastSourceScale = ctx.sourceScale;
        break;
      case 'predict':
        next = this.predictState(control);
        this.mode = 'float';
        break;
      case 'float':
        next = this.floatState(control, old);
        break;
    }
    // NIiter never accepts a predictor load (niiter.c:287-290). Request a
    // float reload even if the first Newton update is below VNTOL: that
    // update can still cross VT/IT and change the switch conductance.
    this.changedLastLoad = mode === 'predict' || (mode === 'float' && next !== old);
    this.state = next;
    this.control = control;
    this.stampConductance(ctx, this.conductance);
  }

  /**
   * Conductance of AC, noise and pole-zero analyses. Before a small-signal
   * analysis ngspice loads once in MODEINITSMSIG, which sets state0 to
   * CKTstate1 (swload.c / cswload.c); SWacLoad, SWpzLoad and SWnoise then
   * treat every nonzero state as on. CKTstate1 is not advanced during an
   * operating point, so after one it is REALLY_OFF and ngspice-47 stamps
   * ROFF whatever state the operating point settled in.
   */
  get smallSignalConductance(): number {
    return this.acceptedState !== REALLY_OFF ? this.model.onConductance : this.model.offConductance;
  }

  stampSmallSignal(ctx: StampContext): void {
    this.stampConductance(ctx, this.smallSignalConductance);
  }

  stampAC(_ctx: StampContext, _omega: number): void {
    // The small-signal conductance is real and stamped by stampSmallSignal.
  }

  /**
   * ngspice CKTnoncon: a float load that changed the state needs one more
   * Newton iteration. In the DC init phase (MODEINITFIX) this is asked only
   * once Newton has otherwise converged; at full source scale that ends the
   * init phase and forces one MODEINITFLOAT iteration, as ngspice NIiter does.
   */
  limitedLastStamp(): boolean {
    if (this.mode === 'init') {
      if (this.lastSourceScale < 1) return false;
      this.mode = 'float';
      return true;
    }
    return this.changedLastLoad;
  }

  acceptTransientStep(ctx: StampContext): void {
    if (this.mode === 'init') {
      // No operating point preceded this point (UIC): ngspice loads once in
      // MODEINITJCT at the initial conditions.
      this.control = this.readControl(ctx);
      this.state = this.initialState(this.control);
      this.mode = 'float';
    }
    this.acceptedState = this.state;
    this.acceptedControl = this.control;
  }

  /** ngspice MODEINITJCT / MODEINITFIX: the instance ON/OFF flag decides. */
  private initialState(control: number): SwitchState {
    const { threshold: vt, hysteresis: vh } = this.model;
    if (this.initiallyOn) {
      if (vh >= 0 && control > vt + vh) return REALLY_ON;
      if (vh < 0 && control > vt - vh) return REALLY_ON;
      return HYST_ON;
    }
    if (vh >= 0 && control < vt - vh) return REALLY_OFF;
    if (vh < 0 && control < vt + vh) return REALLY_OFF;
    return HYST_OFF;
  }

  /** ngspice MODEINITTRAN / MODEINITPRED, decided against state1. */
  private predictState(control: number): SwitchState {
    const { threshold: vt, hysteresis: vh } = this.model;
    const previous = this.acceptedState;
    if (vh > 0) {
      if (control > vt + vh) return REALLY_ON;
      if (control < vt - vh) return REALLY_OFF;
      return previous;
    }
    if (control > vt - vh) return REALLY_ON;
    if (control < vt + vh) return REALLY_OFF;
    if (previous === HYST_ON || previous === HYST_OFF) return previous;
    if (previous === REALLY_ON) return this.predictWindowEntry.fromOn;
    return this.predictWindowEntry.fromOff;
  }

  /** ngspice MODEINITFLOAT. */
  private floatState(control: number, old: SwitchState): SwitchState {
    const { threshold: vt, hysteresis: vh } = this.model;
    const previous = this.acceptedState;
    if (vh > 0) {
      if (control > vt + vh) return REALLY_ON;
      if (control < vt - vh) return REALLY_OFF;
      return this.floatHoldsAcceptedState ? previous : old;
    }
    if (control > vt - vh) return REALLY_ON;
    if (control < vt + vh) return REALLY_OFF;
    if (previous === HYST_ON || previous === HYST_OFF) return previous;
    if (previous === REALLY_ON) return HYST_OFF;
    return HYST_ON;
  }

  /** Control value and state the timestep limiter reads (ngspice state0/state1). */
  protected truncationState(): {
    state: SwitchState; control: number; acceptedControl: number;
  } {
    return { state: this.state, control: this.control, acceptedControl: this.acceptedControl };
  }

  private stampConductance(ctx: StampContext, g: number): void {
    const [n1, n2] = this.nodes;
    if (n1 >= 0) ctx.stampG(n1, n1, g);
    if (n2 >= 0) ctx.stampG(n2, n2, g);
    if (n1 >= 0 && n2 >= 0) {
      ctx.stampG(n1, n2, -g);
      ctx.stampG(n2, n1, -g);
    }
  }
}

function isOn(state: SwitchState): boolean {
  return state === REALLY_ON || state === HYST_ON;
}

/**
 * ngspice-47 voltage-controlled switch (S element, `.model SW`).
 * Nodes: `[n+, n-, nc+, nc-]`.
 */
export class VoltageSwitch extends SwitchBase {
  protected readonly floatHoldsAcceptedState = false;
  protected readonly predictWindowEntry = { fromOn: REALLY_OFF, fromOff: REALLY_ON } as const;

  protected readControl(ctx: StampContext): number {
    const [, , nCtrlP, nCtrlN] = this.nodes;
    return (nCtrlP >= 0 ? ctx.getVoltage(nCtrlP) : 0) - (nCtrlN >= 0 ? ctx.getVoltage(nCtrlN) : 0);
  }

  /**
   * ngspice SWtrunc: while the control approaches the next switching
   * threshold, cap the step so it moves at most 75% of the remaining distance
   * plus 50 mV. Like ngspice, only REALLY_OFF counts as off here.
   */
  truncateTransientStep(_ctx: StampContext, truncation: ChargeTruncation): number {
    const { threshold: vt, hysteresis: vh } = this.model;
    const { state, control, acceptedControl } = this.truncationState();
    const lastChange = control - acceptedControl;
    const delta = truncation.deltas[0];
    if (state === REALLY_OFF) {
      const ref = vt + vh;
      if (control < ref && lastChange > 0) {
        return ((ref - control) * 0.75 + 0.05) / lastChange * delta;
      }
    } else {
      const ref = vt - vh;
      if (control > ref && lastChange < 0) {
        return ((ref - control) * 0.75 - 0.05) / lastChange * delta;
      }
    }
    return Infinity;
  }
}

/**
 * ngspice-47 current-controlled switch (W element, `.model CSW`), controlled
 * by the current through a voltage source. Nodes: `[n+, n-]`.
 *
 * ngspice cswload.c does not store the control current, so CSWtrunc sees no
 * change and never limits the timestep; neither does this device.
 */
export class CurrentSwitch extends SwitchBase {
  protected readonly floatHoldsAcceptedState = true;
  protected readonly predictWindowEntry = { fromOn: HYST_OFF, fromOff: HYST_ON } as const;

  /**
   * CSWtrunc is a complete no-op in ngspice-47. Expose that port so the
   * driver does not mistake hysteresis history for untruncated charge and
   * apply node-voltage LTE to an instantaneous conductance change (#1628).
   */
  truncateTransientStep(_ctx: StampContext, _truncation: ChargeTruncation): number {
    return Infinity;
  }

  constructor(
    name: string,
    nodes: number[],
    /** Branch index of the controlling voltage source (see {@link bindControlBranch}). */
    private controlBranchIndex: number,
    model: SwitchModel,
    initiallyOn: boolean,
    modelWarnings: readonly string[] = [],
  ) {
    super(name, nodes, model, initiallyOn, modelWarnings);
  }

  /** Branch index of the controlling voltage source. */
  get controlBranch(): number {
    return this.controlBranchIndex;
  }

  /** Bind the controlling source's branch once every device is compiled. */
  bindControlBranch(branch: number): void {
    this.controlBranchIndex = branch;
  }

  protected readControl(ctx: StampContext): number {
    return ctx.getCurrent(this.controlBranchIndex);
  }
}
