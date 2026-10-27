import {
  DEVICE_GMIN, type ChargeIntegration, type ChargeTruncation, type ConvergenceTolerances, type DeviceModel,
  type StampContext,
} from './device.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';
import { meyerHalfCapacitances } from './mos6.js';
import { MOS1DepletionCharge } from './mosfet-charge.js';
import {
  CHARGE, CONSTCTOK, CONSTKOVERQ, junctionPotentialFactor, NOMINAL_TEMPERATURE_C, REFTEMP,
  siliconBandGap, temperatureJunction,
} from './junction-temperature.js';
import { InvalidCircuitError, UnsupportedModelLevelError } from '../errors.js';
import { fetlim, pnjlim } from './devsup.js';

export interface MOSFETParams {
  LEVEL: number;
  VTO: number;
  KP: number;
  LAMBDA: number;
  /** Body-effect coefficient (V^0.5); given, or derived from TOX and NSUB. */
  GAMMA: number;
  /** Surface potential (V); given, derived from NSUB, or 0.6. */
  PHI: number;
  /** Lateral diffusion (m); the effective channel length is L - 2*LD. */
  LD: number;
  W: number;
  L: number;
  KF: number;
  AF: number;
  NLEV: number;
  TOX: number | undefined;
  /** Instance multiplier M (mos1temp.c MOS1m, default 1): M parallel copies of the device. */
  M: number;
  /** Instance temperature in Celsius; takes precedence over DTEMP. */
  TEMP?: number;
  /** Offset from circuit temperature in Celsius when TEMP is absent. */
  DTEMP?: number;
  polarity: number; // 1 for NMOS, -1 for PMOS
}

export interface MOSFETOperatingPoint {
  drainNode: number;
  sourceNode: number;
  drainCurrent: number;
  transconductance: number;
}

const GMIN = 1e-12;
// Keep source-ramp Newton iterates finite without clipping ordinary supply steps.
const MAX_NEWTON_TERMINAL_STEP = 10;
const MAX_EXP_ARG = 709;
/** ngspice cktinit.c CKTdefaultMosW / CKTdefaultMosL, used when W or L is omitted. */
const DEFAULT_MOS_WIDTH = 1e-4;
const DEFAULT_MOS_LENGTH = 1e-4;
/** ngspice const.h CHARGE. */
const ELECTRON_CHARGE = CHARGE;
/** ngspice mos1temp.c permittivities 3.9 * eps0 (oxide) and 11.7 * eps0 (silicon), F/m. */
const OXIDE_PERMITTIVITY = 3.9 * 8.854214871e-12;
const SILICON_PERMITTIVITY = 11.7 * 8.854214871e-12;

/**
 * VTO, KP, PHI and GAMMA when the model card omits them, as ngspice-47
 * mos1set.c/mos1temp.c resolve them at TNOM (default 27 C):
 * - VTO defaults to 0, KP to 2e-5, PHI to 0.6 and GAMMA to 0.
 * - With a non-zero oxide capacitance Cox = 3.9*eps0/TOX (TOX given), KP =
 *   UO*Cox*1e-4 (UO default 600). A given NSUB > ni then sets PHI =
 *   max(0.1, 2*vt*ln(NSUB/ni)), GAMMA = sqrt(2*eps_si*q*NSUB)/Cox and VTO from
 *   the flat-band voltage: vfb + type*(GAMMA*sqrt(PHI) + PHI).
 */
function level1Defaults(
  polarity: number, params: Record<string, number | undefined>, nominalKelvin: number,
): { VTO: number; KP: number; PHI: number; GAMMA: number } {
  const plain = { PHI: params.PHI ?? 0.6, GAMMA: params.GAMMA ?? 0 };
  const oxideThickness = params.TOX;
  if (oxideThickness === undefined || oxideThickness === 0) return { VTO: 0, KP: 2e-5, ...plain };
  const oxideCapacitance = OXIDE_PERMITTIVITY / oxideThickness;
  const KP = (params.UO ?? params.U0 ?? 600) * oxideCapacitance * 1e-4;
  const doping = params.NSUB === undefined ? 0 : params.NSUB * 1e6;
  const intrinsic = 1.45e16;
  if (!(doping > intrinsic)) return { VTO: 0, KP, ...plain };
  const vtnom = nominalKelvin * CONSTKOVERQ;
  const bandGap = siliconBandGap(nominalKelvin);
  const phi = params.PHI ?? Math.max(0.1, 2 * vtnom * Math.log(doping / intrinsic));
  const gateType = params.TPG ?? 1;
  const surfaceFermi = polarity * 0.5 * phi;
  const gateWorkFunction = gateType !== 0
    ? 3.25 + 0.5 * bandGap - polarity * gateType * 0.5 * bandGap
    : 3.2;
  const workFunctionDifference = gateWorkFunction - (3.25 + 0.5 * bandGap + surfaceFermi);
  const gamma = params.GAMMA ?? Math.sqrt(2 * SILICON_PERMITTIVITY * ELECTRON_CHARGE * doping) / oxideCapacitance;
  const flatBand = workFunctionDifference - (params.NSS ?? 0) * 1e4 * ELECTRON_CHARGE / oxideCapacitance;
  return { VTO: flatBand + polarity * (gamma * Math.sqrt(phi) + phi), KP, PHI: phi, GAMMA: gamma };
}

/** Reused [cdrain, gm, gds, gmbs, von] buffer written by MOSFET.evaluateChannel. */
const channelScratch = new Float64Array(5);

/**
 * ngspice mos1load.c bulk junction (bulk-source or bulk-drain), in the
 * polarity-adjusted domain, with `gmin` the circuit CKTgmin and `vt` the
 * thermal voltage at the device temperature. Writes [conductance, current]
 * into `out`.
 */
function bulkJunction(
  voltage: number, saturationCurrent: number, vt: number, gmin: number, out: Float64Array, offset: number,
): void {
  if (voltage <= -3 * vt) {
    out[offset] = gmin;
    out[offset + 1] = gmin * voltage - saturationCurrent;
    return;
  }
  const expTerm = Math.exp(Math.min(MAX_EXP_ARG, voltage / vt));
  out[offset] = saturationCurrent * expTerm / vt + gmin;
  out[offset + 1] = saturationCurrent * (expTerm - 1) + gmin * voltage;
}

function criticalVoltage(saturationCurrent: number, vt: number): number {
  return saturationCurrent > 0
    ? vt * Math.log(vt / (Math.SQRT2 * saturationCurrent))
    : Infinity;
}

/**
 * Reused [gbs, ceqbs, gbd, ceqbd, vbs, vbd, limited] buffer written by
 * {@link mos1BulkJunctions}; consumed immediately by each stamp.
 */
const junctionScratch = new Float64Array(7);

/**
 * ngspice mos1load.c bulk junctions at terminal voltages vD, vS, vB. As in
 * mos1load.c, vbs is limited with DEVpnjlim when vds >= 0 (vbd otherwise)
 * against the previous stamp's lastVbs/lastVbd, so a converged Newton point
 * is evaluated without limiting. Writes [gbs, ceqbs, gbd, ceqbd] (companion
 * terms, polarity domain), the limited [vbs, vbd] and whether DEVpnjlim
 * changed the junction voltage (1, mos1load.c icheck) or not (0) into `out`.
 */
function mos1BulkJunctions(
  out: Float64Array, vD: number, vS: number, vB: number, polarity: number,
  lastVbs: number, lastVbd: number, vt: number, sourceVcrit: number, drainVcrit: number,
  sourceSatCur: number, drainSatCur: number, gmin: number,
): void {
  const vds = polarity * (vD - vS);
  let vbs = polarity * (vB - vS);
  let vbd = vbs - vds;
  let limited: number;
  if (vds >= 0) {
    const raw = vbs;
    vbs = pnjlim(vbs, lastVbs, vt, sourceVcrit);
    limited = vbs !== raw ? 1 : 0;
    vbd = vbs - vds;
  } else {
    const raw = vbd;
    vbd = pnjlim(vbd, lastVbd, vt, drainVcrit);
    limited = vbd !== raw ? 1 : 0;
    vbs = vbd + vds;
  }
  bulkJunction(vbs, sourceSatCur, vt, gmin, out, 0);
  bulkJunction(vbd, drainSatCur, vt, gmin, out, 2);
  out[1] -= out[0] * vbs;
  out[3] -= out[2] * vbd;
  out[4] = vbs;
  out[5] = vbd;
  out[6] = limited;
}

/**
 * ngspice mos1load.c drain current in the polarity domain for a device in
 * normal mode (vds >= 0; callers swap drain and source otherwise and pass vbd
 * as vbs). Writes [cdrain, gm, gds, gmbs, von] into `out`.
 */
function mos1Channel(
  out: Float64Array, vgs: number, vds: number, vbs: number,
  tPhi: number, sqrtPhi: number, builtInVon: number, gamma: number, lambda: number, beta: number,
): Float64Array {
  let sarg: number;
  if (vbs <= 0) {
    sarg = Math.sqrt(tPhi - vbs);
  } else {
    sarg = sqrtPhi - vbs / (2 * sqrtPhi);
    sarg = Math.max(0, sarg);
  }
  const von = builtInVon + gamma * sarg;
  const vgst = vgs - von;
  const arg = sarg <= 0 ? 0 : gamma / (2 * sarg);
  out[4] = von;
  if (vgst <= 0) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    return out;
  }
  const betap = beta * (1 + lambda * vds);
  if (vgst <= vds) {
    out[0] = betap * vgst * vgst * 0.5;
    out[1] = betap * vgst;
    out[2] = lambda * beta * vgst * vgst * 0.5;
  } else {
    out[0] = betap * vds * (vgst - 0.5 * vds);
    out[1] = betap * vds;
    out[2] = betap * (vgst - vds) + lambda * beta * vds * (vgst - 0.5 * vds);
  }
  out[3] = out[1] * arg;
  return out;
}

// MosfetBatch.params row layout: the per-instance constants batchStamp reads.
const BP_POLARITY = 0;
const BP_VT = 1;
const BP_SOURCE_SAT = 2;
const BP_DRAIN_SAT = 3;
const BP_SOURCE_VCRIT = 4;
const BP_DRAIN_VCRIT = 5;
const BP_BETA = 6;
const BP_TPHI = 7;
const BP_SQRT_PHI = 8;
const BP_BUILT_IN_VON = 9;
const BP_GAMMA = 10;
const BP_LAMBDA = 11;
const BP_STRIDE = 12;
const BATCH_SLOTS = 11;

/**
 * Bumped whenever any MOSFET's temperature-derived constants change, so every
 * {@link MosfetBatch} copy of them is rebuilt before its next use.
 */
let constantsEpoch = 0;

/**
 * Struct-of-arrays copy of the constants {@link MOSFET.batchStamp} reads for
 * one device list on one locked topology: terminal nodes, value slots and
 * temperature-derived parameters, contiguous per device, so the hot loop
 * does not chase a dozen heap objects per device.
 */
interface MosfetBatch {
  readonly length: number;
  readonly stampIndex: (row: number, col: number) => number;
  readonly epoch: number;
  /** jD, nG, jS, jB per device. */
  readonly nodes: Int32Array;
  /** BATCH_SLOTS value slots per device, SLOT_* order. */
  readonly slots: Int32Array;
  /** BP_STRIDE constants per device, BP_* order. */
  readonly params: Float64Array;
  /** {@link stateStoreEpoch} the state rows below were resolved at. */
  readonly stateEpoch: number;
  /** The shared {@link MosfetStateStore} values of every device in the list. */
  readonly state: Float64Array;
  /** The store holding `state` (and the load cache). */
  readonly store: MosfetStateStore;
  /** Offset of each device's state in `state`. */
  readonly stateBases: Int32Array;
}

const mosfetBatches = new WeakMap<readonly MOSFET[], MosfetBatch>();

/**
 * What {@link MOSFET.batchNewtonStepScale} reads for one device list: D, G, S
 * nodes and polarity per device, and each device's row in the shared
 * {@link MosfetStateStore}, valid while {@link stateStoreEpoch} is unchanged.
 */
interface MosfetStepLimitBatch {
  readonly length: number;
  readonly stateEpoch: number;
  readonly nodes: Int32Array;
  readonly polarity: Float64Array;
  readonly state: Float64Array;
  readonly stateBases: Int32Array;
}

const stepLimitBatches = new WeakMap<readonly MOSFET[], MosfetStepLimitBatch>();

/** The shared {@link MosfetStateStore} of a device list, valid while {@link stateStoreEpoch} is unchanged. */
const predictorStores = new WeakMap<
  readonly MOSFET[], { readonly length: number; readonly stateEpoch: number; readonly store: MosfetStateStore }
>();

// MosfetStateStore.values layout per instance.
const STATE_VBS = 0;
const STATE_VBD = 1;
const STATE_VON = 2;
/** 1 when the last stamp limited a bulk junction (mos1load.c icheck -> CKTnoncon), else 0. */
const STATE_LIMITED = 3;
/**
 * The last load's linearisation, as mos1conv.c reads it from CKTstate0 and
 * the instance: the unswapped polarity-domain vgs/vds, the mode (+1 normal,
 * -1 inverse), MOS1cd = mode * cdrain - cbd and the junction currents cbs/cbd
 * (transient junction charge currents folded in) with their conductances.
 */
const STATE_VGS = 4;
const STATE_VDS = 5;
const STATE_MODE = 6;
const STATE_CD = 7;
const STATE_CBS = 8;
const STATE_CBD = 9;
const STATE_GM = 10;
const STATE_GDS = 11;
const STATE_GMBS = 12;
const STATE_GBS = 13;
const STATE_GBD = 14;
const STATE_STRIDE = 15;

/**
 * Record the load mos1conv.c tests against (see STATE_VGS). `junction` is the
 * mos1BulkJunctions output of the same load; vgs/vds are unswapped.
 */
function recordMos1Load(
  state: Float64Array, base: number, junction: Float64Array, vgs: number, vds: number,
  cdrain: number, gm: number, gds: number, gmbs: number,
): void {
  const mode = vds < 0 ? -1 : 1;
  const gbs = junction[0];
  const gbd = junction[2];
  const cbd = junction[3] + gbd * junction[5];
  state[base + STATE_VGS] = vgs;
  state[base + STATE_VDS] = vds;
  state[base + STATE_MODE] = mode;
  state[base + STATE_CD] = mode * cdrain - cbd;
  state[base + STATE_CBS] = junction[1] + gbs * junction[4];
  state[base + STATE_CBD] = cbd;
  state[base + STATE_GM] = gm;
  state[base + STATE_GDS] = gds;
  state[base + STATE_GMBS] = gmbs;
  state[base + STATE_GBS] = gbs;
  state[base + STATE_GBD] = gbd;
}

/** Bumped whenever MosfetStateStores merge, so batches re-resolve their state rows. */
let stateStoreEpoch = 0;

/**
 * Newton linearisation state of a set of MOSFETs, STATE_STRIDE values per
 * member in member order. Each instance starts in a store of its own; batch
 * stamping merges the stores of a device list into one, so its hot loop reads
 * and writes the state of consecutive devices contiguously instead of through
 * per-instance heap fields.
 */
class MosfetStateStore {
  readonly values: Float64Array;
  /** {@link MOSFET.batchStamp}'s last load per member, LOAD_* layout; allocated on first use. */
  private loads: Float64Array | undefined;
  /** {@link constantsEpoch} the cached evaluations were made with. */
  private loadsEpoch = -1;

  constructor(readonly members: readonly MOSFET[]) {
    this.values = new Float64Array(STATE_STRIDE * members.length);
  }

  /**
   * The load cache. Invariant: a member's row with a non-NaN key describes
   * the last load written to that member's state row, a batched load with
   * those inputs. Since that load, the row was at most changed by
   * {@link MOSFET.foldJunctionChargeCurrent} in STATE_CD/CBS/CBD/GBS/GBD,
   * which a hit restores from the cached pre-fold values. Every other writer
   * of a state row (the vbs/vbd/von setters, per-device stamp,
   * limitNewtonStep and the predictor's junction restore) calls
   * {@link invalidateLoad} first; store merges start a
   * fresh cache, and a constants change empties it (NaN keys match nothing).
   */
  loadCache(): Float64Array {
    let loads = this.loads;
    if (loads === undefined || this.loadsEpoch !== constantsEpoch) {
      loads ??= new Float64Array(LOAD_STRIDE * this.members.length);
      loads.fill(NaN);
      this.loads = loads;
      this.loadsEpoch = constantsEpoch;
    }
    return loads;
  }

  /** A state row is written outside {@link MOSFET.batchStamp}: forget its cached load. */
  invalidateLoad(stateBase: number): void {
    if (this.loads !== undefined) this.loads[(stateBase / STATE_STRIDE) * LOAD_STRIDE + LOAD_VD] = NaN;
  }

  // Transient predictor (mos1load.c MODEINITPRED), see beginPredictor.
  /** 1 for a member whose next load is the first iterate of a timepoint. */
  predictFlags: Uint8Array | undefined;
  /** Solution at the last accepted point (CKTstate1) and at the one before (CKTstate2). */
  predictAccepted: Float64Array | undefined;
  predictPrior: Float64Array | undefined;
  /** x = dt / dt(n) of the current attempt; 0 extrapolates nothing. */
  predictRatio = 0;
  /** Limited vbs, vbd per member loaded at the accepted point (CKTstate1). */
  private acceptedJunctions: Float64Array | undefined;
  /** Accepted points recorded: 0, 1 (predictAccepted) or 2 (predictPrior too). */
  private history = 0;
  /** Step that reached the last accepted point (CKTdeltaOld[1]). */
  private acceptedStep = 0;
  /** An accepted point not yet recorded: 1 after an operating point, 2 after a step of pendingStep. */
  private pending = 0;
  private pendingStep = 0;
  /** A transient Newton solve began since the last accepted point. */
  private inTransient = false;

  /** A member accepted a point reached by a step of `dt` (0 for an operating point). Idempotent per point. */
  markAccepted(dt: number): void {
    if (this.inTransient) {
      this.pending = 2;
      this.pendingStep = dt;
      this.inTransient = false;
    } else if (this.pending === 0) {
      this.pending = 1;
    }
  }

  resetPredictor(): void {
    this.history = 0;
    this.pending = 0;
    this.inTransient = false;
    this.predictRatio = 0;
    this.predictFlags?.fill(0);
  }

  /**
   * Start a transient Newton attempt of step `dt` from the accepted solution
   * `accepted` for every member (see {@link MOSFET.beginTransientNewton}).
   * The first attempt after an accepted point records it, a retry restores
   * the junction voltages loaded there. Idempotent within one attempt.
   */
  beginPredictor(dt: number, accepted: Float64Array): void {
    const count = this.members.length;
    const values = this.values;
    if (this.pending !== 0) {
      let point = this.predictAccepted;
      if (this.pending === 2 && this.history > 0) {
        const recycled = this.predictPrior;
        this.predictPrior = point;
        point = recycled;
        this.acceptedStep = this.pendingStep;
        this.history = 2;
      } else {
        this.history = 1;
      }
      if (point === undefined || point.length !== accepted.length) point = new Float64Array(accepted.length);
      point.set(accepted);
      this.predictAccepted = point;
      const junctions = this.acceptedJunctions ??= new Float64Array(2 * count);
      for (let m = 0; m < count; m++) {
        junctions[2 * m] = values[STATE_STRIDE * m + STATE_VBS];
        junctions[2 * m + 1] = values[STATE_STRIDE * m + STATE_VBD];
      }
      this.pending = 0;
    } else if (this.history > 0) {
      // A retried timepoint limits against the accepted point again (CKTstate0 = CKTstate1).
      const junctions = this.acceptedJunctions!;
      for (let m = 0; m < count; m++) {
        const base = STATE_STRIDE * m;
        const vbs = junctions[2 * m];
        const vbd = junctions[2 * m + 1];
        if (Object.is(values[base + STATE_VBS], vbs) && Object.is(values[base + STATE_VBD], vbd)) continue;
        this.invalidateLoad(base);
        values[base + STATE_VBS] = vbs;
        values[base + STATE_VBD] = vbd;
      }
    }
    this.inTransient = true;
    if (this.history === 0) return;
    const step = this.acceptedStep;
    this.predictRatio = this.history === 2 && step > 0 && dt > 0 ? dt / step : 0;
    (this.predictFlags ??= new Uint8Array(count)).fill(1);
  }

  /**
   * Predicted voltage of node `node` (-1 for ground): v(n) + x * (v(n) - v(n-1)),
   * mos1load.c (1 + x) * v(n) - x * v(n-1) written so that a node that did
   * not move is predicted exactly.
   */
  predictedVoltage(node: number): number {
    if (node < 0) return 0;
    const point = this.predictAccepted![node];
    const ratio = this.predictRatio;
    return ratio === 0 ? point : point + ratio * (point - this.predictPrior![node]);
  }
}

// MosfetStateStore load-cache row per member: the inputs of the member's last
// batched MOS1 load (terminal voltages, the previous limited junction voltages
// read from its state row, the junction gmin) and the companion values that
// load stamped.
const LOAD_VD = 0;
const LOAD_VG = 1;
const LOAD_VS = 2;
const LOAD_VB = 3;
const LOAD_LAST_VBS = 4;
const LOAD_LAST_VBD = 5;
const LOAD_GMIN = 6;
const LOAD_GBS = 7;
const LOAD_GBD = 8;
const LOAD_CEQBS = 9;
const LOAD_CEQBD = 10;
const LOAD_GM = 11;
const LOAD_GDS = 12;
const LOAD_GMBS = 13;
const LOAD_IEQ = 14;
// The load's pre-fold STATE_CD/CBS/CBD (its STATE_GBS/GBD are LOAD_GBS/GBD):
// a hit restores them, since stampTransientCharge folds the junction charge
// currents into those five state values after every load.
const LOAD_CD = 15;
const LOAD_CBS = 16;
const LOAD_CBD = 17;
const LOAD_STRIDE = 18;

/**
 * Scale on a whole Newton step proposed for one MOS1 instance (D, G, S nodes,
 * -1 for ground): no terminal voltage may move by more than
 * MAX_NEWTON_TERMINAL_STEP, and, as mos1load.c applies DEVfetlim to vgs
 * (vds >= 0) or vgd (vds < 0) against the previous threshold `von`, spice-ts
 * turns the limited gate voltage into a scale on the step. Allocation-free:
 * it runs for every device on every Newton iteration.
 */
function mos1NewtonStepScale(
  previous: Float64Array, candidate: Float64Array,
  nD: number, nG: number, nS: number, polarity: number, von: number,
): number {
  const prevD = nD >= 0 ? previous[nD] : 0;
  const prevG = nG >= 0 ? previous[nG] : 0;
  const prevS = nS >= 0 ? previous[nS] : 0;
  const candD = nD >= 0 ? candidate[nD] : 0;
  const candG = nG >= 0 ? candidate[nG] : 0;
  const candS = nS >= 0 ? candidate[nS] : 0;
  const vgsStep = Math.abs((candG - candS) - (prevG - prevS));
  const vdsStep = Math.abs((candD - candS) - (prevD - prevS));
  const largestStep = Math.max(vgsStep, vdsStep);
  const terminalScale = largestStep > MAX_NEWTON_TERMINAL_STEP
    ? MAX_NEWTON_TERMINAL_STEP / largestStep
    : 1;
  const previousVds = polarity * (prevD - prevS);
  const reverse = !(previousVds >= 0);
  const previousGate = polarity * (prevG - (reverse ? prevD : prevS));
  const proposedGate = polarity * (candG - (reverse ? candD : candS));
  const delta = proposedGate - previousGate;
  if (delta === 0) return Math.min(terminalScale, 1);
  const limited = fetlim(proposedGate, previousGate, von);
  return Math.min(terminalScale, Math.min(1, Math.max(0, (limited - previousGate) / delta)));
}

// batchStamp value-slot layout over the unswapped D, G, S and bulk terminals.
const SLOT_DG = 0;
const SLOT_DD = 1;
const SLOT_DS = 2;
const SLOT_SG = 3;
const SLOT_SD = 4;
const SLOT_SS = 5;
const SLOT_BB = 6;
const SLOT_BS = 7;
const SLOT_BD = 8;
const SLOT_SB = 9;
const SLOT_DB = 10;

/** Terminal indices (D, G, S, B) of G-D, G-S, G-B, B-D and B-S charges. */
const CHARGE_BRANCHES: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, 2], [1, 3], [3, 0], [3, 2]];
/** mos1trunc.c truncates all three Meyer gate charges, not the bulk junctions. */
const MOS_GATE_CHARGES: readonly number[] = [0, 1, 2];

function branchVoltage(ctx: StampContext, positive: number, negative: number): number {
  return (positive >= 0 ? ctx.getVoltage(positive) : 0)
    - (negative >= 0 ? ctx.getVoltage(negative) : 0);
}

export class MOSFET implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (MOS1trunc: qgs, qgd, qgb). */
  readonly truncationCoversCharges = true;
  readonly params: MOSFETParams;
  readonly suppliedParams: Readonly<Record<string, number>>;
  /** Bulk-drain / bulk-source junction saturation currents at the device temperature (mos1temp.c). */
  drainSatCur = 0;
  sourceSatCur = 0;
  private drainVcrit = 0;
  private sourceVcrit = 0;
  /**
   * Newton linearisation state (ngspice CKTstate0 vbs/vbd, MOS1von and the
   * mos1load.c icheck junction-limited flag):
   * STATE_STRIDE values at `stateBase` in a store shared with the other
   * instances batch-stamped alongside this one; see {@link MosfetStateStore}.
   */
  private stateStore: MosfetStateStore;
  private stateBase = 0;
  /** Effective channel length L - 2*LD (m), as used by mos1load.c and mos1noi.c. */
  readonly effectiveLength: number;
  /** Device temperature (C) and the mos1temp.c values derived from it. */
  private temperature = NOMINAL_TEMPERATURE_C;
  private circuitTemperature = NOMINAL_TEMPERATURE_C;
  private readonly nominalKelvin: number;
  /** Thermal voltage at the device temperature (mos1temp.c vt). */
  private vt = 0;
  /** mos1temp.c MOS1tPhi: the surface potential at the device temperature. */
  private tPhi = 0;
  /** mos1load.c Beta = tKP*W/Leff and the polarity-domain threshold terms. */
  private beta = 0;
  private sqrtPhi = 0;
  private zeroBiasVon = 0;
  private builtInVon = 0;
  private readonly overlaps: Float64Array;
  private readonly oxideCap: number;
  private drainDepletion!: MOS1DepletionCharge;
  private sourceDepletion!: MOS1DepletionCharge;
  private readonly capacitances = new Float64Array(CHARGE_BRANCHES.length);
  private readonly junctionCharges = new Float64Array(CHARGE_BRANCHES.length);
  private readonly meyerHalf = new Float64Array(3);
  /** Meyer incremental gate charges and exact depletion junction charges. */
  readonly integratesTransientCharge: boolean;
  readonly storesCharge: boolean;
  private readonly charges = new TransientChargeState(CHARGE_BRANCHES.length);
  /** {@link batchStamp} value slots and the topology lookup they belong to. */
  private batchSlots: Int32Array | null = null;
  private batchSlotKey: ((row: number, col: number) => number) | null = null;

  constructor(
    readonly name: string,
    readonly nodes: number[],
    params: Partial<MOSFETParams> & Record<string, number>,
    circuitTemperature = NOMINAL_TEMPERATURE_C,
  ) {
    this.stateStore = new MosfetStateStore([this]);
    this.suppliedParams = { ...params };
    const level = params.LEVEL ?? 1;
    // #530: only ngspice mos1 is implemented here; other levels must not run these equations.
    if (level !== 1) throw new UnsupportedModelLevelError(name, undefined, level, [1]);
    const polarity = params.polarity ?? 1;
    // mos1temp.c: TNOM defaults to CKTnomTemp (27 C).
    this.nominalKelvin = (params.TNOM ?? NOMINAL_TEMPERATURE_C) + CONSTCTOK;
    if (!(this.nominalKelvin > 0)) {
      throw new InvalidCircuitError(`MOSFET '${name}' has an invalid TNOM = ${params.TNOM}`);
    }
    const defaults = level1Defaults(polarity, params, this.nominalKelvin);
    this.params = {
      LEVEL: level,
      VTO: params.VTO ?? params.VT0 ?? defaults.VTO,
      KP: params.KP ?? params.KC ?? defaults.KP,
      LAMBDA: params.LAMBDA ?? params.LAMBDA0 ?? 0,
      GAMMA: defaults.GAMMA,
      PHI: defaults.PHI,
      LD: params.LD ?? 0,
      // cktinit.c CKTdefaultMosW / CKTdefaultMosL (.option defw / defl).
      W: params.W ?? DEFAULT_MOS_WIDTH,
      L: params.L ?? DEFAULT_MOS_LENGTH,
      KF: params.KF ?? 0,
      AF: params.AF ?? 1,
      NLEV: params.NLEV ?? 2,
      TOX: params.TOX,
      M: params.M ?? 1,
      polarity,
    };
    const { PHI, LD, L } = this.params;
    const effectiveLength = L - 2 * LD;
    if (!(effectiveLength > 0)) {
      throw new InvalidCircuitError(
        `MOSFET '${name}' has a non-positive effective channel length L - 2*LD = ${effectiveLength}`,
      );
    }
    if (!(PHI > 0)) throw new InvalidCircuitError(`MOSFET '${name}' requires PHI > 0, got ${PHI}`);
    this.effectiveLength = effectiveLength;
    // mos1load.c: the overlaps, OxideCap and Beta all carry the instance multiplier M.
    const multiplier = this.params.M;
    const width = this.params.W;
    this.overlaps = Float64Array.of(
      (this.suppliedParams.CGDO ?? 0) * multiplier * width,
      (this.suppliedParams.CGSO ?? 0) * multiplier * width,
      (this.suppliedParams.CGBO ?? 0) * multiplier * effectiveLength,
    );
    this.oxideCap = params.TOX ? OXIDE_PERMITTIVITY / params.TOX * multiplier * width * effectiveLength : 0;
    this.setTemperature(circuitTemperature);
    this.storesCharge = this.oxideCap !== 0 || this.overlaps.some(value => value !== 0)
      || this.drainDepletion.active || this.sourceDepletion.active;
    this.integratesTransientCharge = this.storesCharge;
  }

  setTemperature(value: number): void {
    // mos1temp.c: TEMP wins, otherwise add DTEMP to CKTtemp (not to the last effective temperature).
    const effective = this.suppliedParams.TEMP ?? value + (this.suppliedParams.DTEMP ?? 0);
    if (!Number.isFinite(effective) || effective <= -CONSTCTOK) {
      throw new InvalidCircuitError(`${this.name}: MOSFET level 1 effective temperature must be finite and above absolute zero (got ${effective} C)`);
    }
    this.temperature = effective;
    this.circuitTemperature = value;
    this.applyTemperature();
  }

  /** Junction voltage vbs used by the previous stamp (ngspice CKTstate0 vbs). */
  private get lastVbs(): number {
    return this.stateStore.values[this.stateBase + STATE_VBS];
  }

  private set lastVbs(value: number) {
    this.stateStore.invalidateLoad(this.stateBase);
    this.stateStore.values[this.stateBase + STATE_VBS] = value;
  }

  /** Junction voltage vbd used by the previous stamp (ngspice CKTstate0 vbd). */
  private get lastVbd(): number {
    return this.stateStore.values[this.stateBase + STATE_VBD];
  }

  private set lastVbd(value: number) {
    this.stateStore.invalidateLoad(this.stateBase);
    this.stateStore.values[this.stateBase + STATE_VBD] = value;
  }

  /** Threshold of the previous stamp (ngspice MOS1von), the DEVfetlim pivot. */
  private get lastVon(): number {
    return this.stateStore.values[this.stateBase + STATE_VON];
  }

  private set lastVon(value: number) {
    this.stateStore.invalidateLoad(this.stateBase);
    this.stateStore.values[this.stateBase + STATE_VON] = value;
  }

  /**
   * The {@link MosfetStateStore} holding the state of every instance in
   * `mosfets`. When they are spread over several stores, those stores are
   * merged into one holding all their members (state values copied
   * unchanged), so stores only ever grow and each instance has exactly one.
   */
  private static sharedStateStore(mosfets: readonly MOSFET[]): MosfetStateStore {
    const first = mosfets[0].stateStore;
    let shared = true;
    for (let m = 1; m < mosfets.length; m++) {
      if (mosfets[m].stateStore !== first) {
        shared = false;
        break;
      }
    }
    if (shared) return first;
    const involved = new Set<MosfetStateStore>();
    for (const mosfet of mosfets) involved.add(mosfet.stateStore);
    const members: MOSFET[] = [];
    for (const store of involved) {
      for (const member of store.members) members.push(member);
    }
    const merged = new MosfetStateStore(members);
    for (let row = 0; row < members.length; row++) {
      const member = members[row];
      const base = STATE_STRIDE * row;
      const from = member.stateStore.values;
      for (let i = 0; i < STATE_STRIDE; i++) merged.values[base + i] = from[member.stateBase + i];
      member.stateStore = merged;
      member.stateBase = base;
    }
    stateStoreEpoch++;
    return merged;
  }

  getTemperature(): number {
    return this.temperature;
  }

  getCircuitTemperature(): number {
    return this.circuitTemperature;
  }

  /**
   * ngspice-47 mos1temp.c instance loop at the device temperature: KP scales
   * by (T/TNOM)^-1.5, PHI and the built-in voltage follow the band gap, the
   * bulk saturation currents by exp(-EG(T)/vt + EG(TNOM)/vtnom), and the bulk
   * junction potential and capacitances by the REFTEMP-mapped law (the
   * sidewall with MJSW but the bottom PB). At T = TNOM every factor is 1.
   */
  private applyTemperature(): void {
    const supplied = this.suppliedParams;
    const { KP, VTO, GAMMA, PHI, W, M, polarity } = this.params;
    const kelvin = this.temperature + CONSTCTOK;
    const nominalKelvin = this.nominalKelvin;
    const vt = CONSTKOVERQ * kelvin;
    const vtnom = CONSTKOVERQ * nominalKelvin;
    const ratio = kelvin / nominalKelvin;
    const egfet = siliconBandGap(kelvin);
    const egfet1 = siliconBandGap(nominalKelvin);
    const phio = (PHI - junctionPotentialFactor(nominalKelvin)) / (nominalKelvin / REFTEMP);
    const tPhi = kelvin === nominalKelvin ? PHI : (kelvin / REFTEMP) * phio + junctionPotentialFactor(kelvin);
    const tVbi = VTO - polarity * GAMMA * Math.sqrt(PHI)
      + 0.5 * (egfet1 - egfet) + polarity * 0.5 * (tPhi - PHI);
    this.vt = vt;
    constantsEpoch++;
    this.tPhi = tPhi;
    this.beta = KP / (ratio * Math.sqrt(ratio)) * M * W / this.effectiveLength;
    this.sqrtPhi = Math.sqrt(tPhi);
    this.builtInVon = polarity * tVbi;
    this.zeroBiasVon = this.builtInVon + GAMMA * this.sqrtPhi;
    this.lastVon = this.zeroBiasVon;

    // mos1load.c: JS*AD / JS*AS only when JS and both areas are non-zero, times M; mos1temp.c
    // takes the critical voltages from the same M-scaled currents.
    const saturationScale = kelvin === nominalKelvin ? 1 : Math.exp(-egfet / vt + egfet1 / vtnom);
    const saturationCurrent = (supplied.IS ?? 1e-14) * saturationScale;
    const saturationDensity = (supplied.JS ?? 0) * saturationScale;
    const drainArea = supplied.AD ?? 0;
    const sourceArea = supplied.AS ?? 0;
    const useDensity = saturationDensity !== 0 && drainArea !== 0 && sourceArea !== 0;
    this.drainSatCur = M * (useDensity ? saturationDensity * drainArea : saturationCurrent);
    this.sourceSatCur = M * (useDensity ? saturationDensity * sourceArea : saturationCurrent);
    this.drainVcrit = criticalVoltage(this.drainSatCur, vt);
    this.sourceVcrit = criticalVoltage(this.sourceSatCur, vt);

    const potential = supplied.PB ?? 0.8;
    const grading = supplied.MJ ?? 0.5;
    const sideGrading = supplied.MJSW ?? 0.5;
    const bottom = kelvin === nominalKelvin
      ? { potential, capacitance: 1 }
      : temperatureJunction(potential, 1, grading, kelvin, nominalKelvin);
    const sidewall = kelvin === nominalKelvin
      ? 1
      : temperatureJunction(potential, 1, sideGrading, kelvin, nominalKelvin).capacitance;
    // mos1temp.c czbd/czbdsw (czbs/czbssw) carry M.
    const junction = (zeroBias: number, sidewallCap: number) => new MOS1DepletionCharge(
      M * zeroBias * bottom.capacitance, M * sidewallCap * sidewall,
      bottom.potential, grading, sideGrading, supplied.FC ?? 0.5,
    );
    this.drainDepletion = junction(
      supplied.CBD ?? (supplied.CJ ?? 0) * drainArea, (supplied.CJSW ?? 0) * (supplied.PD ?? 0),
    );
    this.sourceDepletion = junction(
      supplied.CBS ?? (supplied.CJ ?? 0) * sourceArea, (supplied.CJSW ?? 0) * (supplied.PS ?? 0),
    );
  }

  private get bulkNode(): number {
    return this.nodes[3] ?? this.nodes[2];
  }

  /**
   * {@link mos1BulkJunctions} for this instance against its previous stamp,
   * recording the limited vbs/vbd; writes into junctionScratch.
   */
  private evaluateBulkJunctions(vD: number, vS: number, vB: number, gmin: number): Float64Array {
    const out = junctionScratch;
    mos1BulkJunctions(
      out, vD, vS, vB, this.params.polarity, this.lastVbs, this.lastVbd, this.vt,
      this.sourceVcrit, this.drainVcrit, this.sourceSatCur, this.drainSatCur, gmin,
    );
    this.lastVbs = out[4];
    this.lastVbd = out[5];
    this.stateStore.invalidateLoad(this.stateBase);
    this.stateStore.values[this.stateBase + STATE_LIMITED] = out[6];
    return out;
  }

  /** {@link mos1Channel} for this instance; writes into channelScratch. */
  private evaluateChannel(vgs: number, vds: number, vbs: number): Float64Array {
    const { GAMMA, LAMBDA } = this.params;
    return mos1Channel(
      channelScratch, vgs, vds, vbs, this.tPhi, this.sqrtPhi, this.builtInVon, GAMMA, LAMBDA, this.beta,
    );
  }

  /**
   * Whether the last stamp limited a bulk junction with DEVpnjlim. As in
   * ngspice (mos1load.c icheck), Newton cannot converge on such an iterate:
   * the junction current was evaluated at a voltage the solution lacks.
   */
  limitedLastStamp(): boolean {
    return this.stateStore.values[this.stateBase + STATE_LIMITED] !== 0;
  }

  limitNewtonStep(previous: Float64Array, candidate: Float64Array): number {
    const nodes = this.nodes;
    return mos1NewtonStepScale(
      previous, candidate, nodes[0], nodes[1], nodes[2], this.params.polarity, this.lastVon,
    );
  }

  /**
   * Math.min of {@link limitNewtonStep} over `mosfets` (in any order, so the
   * same value), reading terminal nodes, polarity and the previous threshold
   * from the list's {@link MosfetStepLimitBatch} instead of per-instance
   * fields: no allocation and contiguous reads on every Newton iteration.
   */
  static batchNewtonStepScale(
    mosfets: readonly MOSFET[], previous: Float64Array, candidate: Float64Array,
  ): number {
    const length = mosfets.length;
    if (length === 0) return 1;
    let batch = stepLimitBatches.get(mosfets);
    if (batch === undefined || batch.stateEpoch !== stateStoreEpoch || batch.length !== length) {
      // Merging stores bumps the epoch, so resolve them before recording it.
      const store = MOSFET.sharedStateStore(mosfets);
      const nodes = new Int32Array(3 * length);
      const polarity = new Float64Array(length);
      const stateBases = new Int32Array(length);
      for (let m = 0; m < length; m++) {
        const mosfet = mosfets[m];
        nodes[3 * m] = mosfet.nodes[0];
        nodes[3 * m + 1] = mosfet.nodes[1];
        nodes[3 * m + 2] = mosfet.nodes[2];
        polarity[m] = mosfet.params.polarity;
        stateBases[m] = mosfet.stateBase;
      }
      batch = { length, stateEpoch: stateStoreEpoch, nodes, polarity, state: store.values, stateBases };
      stepLimitBatches.set(mosfets, batch);
    }
    const { nodes, polarity, state, stateBases } = batch;
    let scale = 1;
    for (let m = 0; m < length; m++) {
      const q = 3 * m;
      scale = Math.min(scale, mos1NewtonStepScale(
        previous, candidate, nodes[q], nodes[q + 1], nodes[q + 2],
        polarity[m], state[stateBases[m] + STATE_VON],
      ));
    }
    return scale;
  }

  /** ngspice mos1ask.c MOS1_CD: native load current, including bulk-drain charge.
   * Unlike terminal current, this retains the model's polarity-normalized sign.
   */
  outputDrainCurrent(): number {
    return this.stateStore.values[this.stateBase + STATE_CD];
  }

  /** Level-1 DC quantities used by the small-signal noise generators. */
  noiseOperatingPoint(solution: Float64Array): MOSFETOperatingPoint {
    const { polarity } = this.params;
    let drainNode = this.nodes[0];
    const gateNode = this.nodes[1];
    let sourceNode = this.nodes[2];
    const bulkNode = this.bulkNode;
    const voltage = (node: number): number => (node >= 0 ? solution[node] : 0);
    let vGS = polarity * (voltage(gateNode) - voltage(sourceNode));
    let vDS = polarity * (voltage(drainNode) - voltage(sourceNode));
    let vBS = polarity * (voltage(bulkNode) - voltage(sourceNode));

    if (vDS < 0) {
      [drainNode, sourceNode] = [sourceNode, drainNode];
      vGS -= vDS;
      vBS -= vDS;
      vDS = -vDS;
    }
    const channel = this.evaluateChannel(vGS, vDS, vBS);
    return { drainNode, sourceNode, drainCurrent: channel[0], transconductance: channel[1] };
  }

  stamp(ctx: StampContext): void {
    const polarity = this.params.polarity;
    const [jD, nG, jS] = this.nodes;
    const jB = this.bulkNode;
    // mos1load.c MODEINITPRED, as in batchStamp.
    const store = this.stateStore;
    const row = this.stateBase / STATE_STRIDE;
    const predict = store.predictFlags !== undefined && store.predictFlags[row] !== 0;
    if (predict) store.predictFlags![row] = 0;
    const vD = predict ? store.predictedVoltage(jD) : jD >= 0 ? ctx.getVoltage(jD) : 0;
    const vG = predict ? store.predictedVoltage(nG) : nG >= 0 ? ctx.getVoltage(nG) : 0;
    const vS = predict ? store.predictedVoltage(jS) : jS >= 0 ? ctx.getVoltage(jS) : 0;
    const vB = predict ? store.predictedVoltage(jB) : jB >= 0 ? ctx.getVoltage(jB) : 0;

    // Bulk junctions first: as in mos1load.c, the drain current uses the
    // DEVpnjlim-limited vbs/vbd. They stamp on the unswapped terminals.
    const junction = this.evaluateBulkJunctions(vD, vS, vB, ctx.gmin ?? DEVICE_GMIN);
    const gbs = junction[0];
    const gbd = junction[2];
    const ceqbs = polarity * junction[1];
    const ceqbd = polarity * junction[3];
    if (jB >= 0) {
      ctx.stampG(jB, jB, gbs + gbd);
      if (jS >= 0) ctx.stampG(jB, jS, -gbs);
      if (jD >= 0) ctx.stampG(jB, jD, -gbd);
      ctx.stampB(jB, -(ceqbs + ceqbd));
    }
    if (jS >= 0) {
      ctx.stampG(jS, jS, gbs);
      if (jB >= 0) ctx.stampG(jS, jB, -gbs);
      ctx.stampB(jS, ceqbs);
    }
    if (jD >= 0) {
      ctx.stampG(jD, jD, gbd);
      if (jB >= 0) ctx.stampG(jD, jB, -gbd);
      ctx.stampB(jD, ceqbd);
    }

    // Polarity-domain terminal voltages. For vds < 0 the device runs in
    // reverse mode (ngspice MOS1mode = -1): drain and source swap and the body
    // effect uses vbd.
    let nD = jD;
    let nS = jS;
    let vGS = polarity * (vG - vS);
    let vDS = polarity * (vD - vS);
    let vBS = this.lastVbs;
    if (vDS < 0) {
      nD = jS;
      nS = jD;
      vGS -= vDS;
      vDS = -vDS;
      vBS = this.lastVbd;
    }

    const channel = this.evaluateChannel(vGS, vDS, vBS);
    const ID = channel[0];
    const gm = channel[1];
    const gds = channel[2] + GMIN;
    const gmbs = channel[3];
    this.lastVon = channel[4];
    this.stateStore.invalidateLoad(this.stateBase);
    recordMos1Load(
      this.stateStore.values, this.stateBase, junction,
      polarity * (vG - vS), polarity * (vD - vS), ID, gm, gds, gmbs,
    );

    // NR companion: ID ~ ID0 + gm*dVGS + gds*dVDS + gmbs*dVBS around the
    // (possibly swapped) effective drain/source; physical current = polarity*ID.
    const Ieq = ID - gm * vGS - gds * vDS - gmbs * vBS;
    if (nD >= 0) {
      if (nG >= 0) ctx.stampG(nD, nG, gm);
      ctx.stampG(nD, nD, gds);
      if (nS >= 0) ctx.stampG(nD, nS, -(gm + gds + gmbs));
      if (jB >= 0 && gmbs !== 0) ctx.stampG(nD, jB, gmbs);
      ctx.stampB(nD, -polarity * Ieq);
    }
    if (nS >= 0) {
      if (nG >= 0) ctx.stampG(nS, nG, -gm);
      if (nD >= 0) ctx.stampG(nS, nD, -gds);
      ctx.stampG(nS, nS, gm + gds + gmbs);
      if (jB >= 0 && gmbs !== 0) ctx.stampG(nS, jB, -gmbs);
      ctx.stampB(nS, polarity * Ieq);
    }
  }

  stampDynamic(ctx: StampContext): void {
    if (!this.storesCharge) return;
    this.evaluateCharges(ctx);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [positive, negative] = CHARGE_BRANCHES[index];
      this.stampCapacitance(
        ctx, this.chargeNode(positive), this.chargeNode(negative), this.capacitances[index],
      );
    }
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    if (!this.storesCharge) return;
    const charges = this.charges;
    this.evaluateCharges(ctx);
    charges.begin(integration);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const capacitance = this.capacitances[index];
      const [p, n] = CHARGE_BRANCHES[index];
      const positive = this.chargeNode(p);
      const negative = this.chargeNode(n);
      const voltage = branchVoltage(ctx, positive, negative);
      const gate = index < 3;
      const charge = gate ? charges.incrementalCharge(index, voltage, capacitance, true) : this.junctionCharges[index];
      const effective = gate ? charges.incrementalCapacitance(index, capacitance, true) : capacitance;
      const current = charges.current(index, charge);
      const conductance = charges.factor * effective;
      stampChargeBranch(ctx, positive, negative, current, conductance, voltage);
      if (!gate) this.foldJunctionChargeCurrent(index, current, conductance);
    }
  }

  /**
   * mos1load.c folds the bulk junction charge currents into the currents
   * mos1conv.c tests: cbd += cqbd, cd -= cqbd, gbd += geq, and cbs += cqbs,
   * gbs += geq. `current` and `conductance` are node-domain.
   */
  private foldJunctionChargeCurrent(index: number, current: number, conductance: number): void {
    const state = this.stateStore.values;
    const base = this.stateBase;
    const deviceCurrent = this.params.polarity * current;
    if (index === 3) {
      state[base + STATE_CBD] += deviceCurrent;
      state[base + STATE_CD] -= deviceCurrent;
      state[base + STATE_GBD] += conductance;
    } else {
      state[base + STATE_CBS] += deviceCurrent;
      state[base + STATE_GBS] += conductance;
    }
  }

  /**
   * ngspice-47 mos1conv.c: the drain current and the bulk junction currents
   * predicted at the new Newton solution from the last load's linearisation
   * must match the loaded currents within RELTOL * max + ABSTOL.
   */
  convergenceTest(solution: Float64Array, tolerances: ConvergenceTolerances): boolean {
    const state = this.stateStore.values;
    const base = this.stateBase;
    const { polarity } = this.params;
    const [nD, nG, nS] = this.nodes;
    const nB = this.bulkNode;
    const vS = nS >= 0 ? solution[nS] : 0;
    const vbs = polarity * ((nB >= 0 ? solution[nB] : 0) - vS);
    const vgs = polarity * ((nG >= 0 ? solution[nG] : 0) - vS);
    const vds = polarity * ((nD >= 0 ? solution[nD] : 0) - vS);
    const vgsOld = state[base + STATE_VGS];
    const vdsOld = state[base + STATE_VDS];
    const delvbs = vbs - state[base + STATE_VBS];
    const delvbd = vbs - vds - state[base + STATE_VBD];
    const delvgs = vgs - vgsOld;
    const delvds = vds - vdsOld;
    const delvgd = vgs - vds - (vgsOld - vdsOld);
    const cd = state[base + STATE_CD];
    const gm = state[base + STATE_GM];
    const gds = state[base + STATE_GDS];
    const gmbs = state[base + STATE_GMBS];
    const gbd = state[base + STATE_GBD];
    const cdhat = state[base + STATE_MODE] >= 0
      ? cd - gbd * delvbd + gmbs * delvbs + gm * delvgs + gds * delvds
      : cd - (gbd - gmbs) * delvbd - gm * delvgd + gds * delvds;
    const { reltol, abstol } = tolerances;
    if (Math.abs(cdhat - cd) >= reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + abstol) return false;
    const cb = state[base + STATE_CBS] + state[base + STATE_CBD];
    const cbhat = cb + gbd * delvbd + state[base + STATE_GBS] * delvbs;
    return Math.abs(cbhat - cb) <= reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + abstol;
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      stampChargeCurrent(ctx, this.chargeNode(p), this.chargeNode(n), this.charges.acceptedChargeCurrent(index));
    }
  }

  acceptTransientStep(ctx: StampContext): void {
    // The accepted solution itself is recorded by the next beginTransientNewton.
    this.stateStore.markAccepted(ctx.dt);
    if (this.integratesTransientCharge) this.acceptCharges(ctx);
  }

  /**
   * Start a transient Newton solve at a new or retried timepoint of step
   * `dt` from the accepted solution `accepted`, as ngspice-47 mos1load.c
   * MODEINITPRED: the first iterate is linearised at vgs, vds and vbs
   * extrapolated from the two accepted points, v = (1 + x) * v(n) - x * v(n-1)
   * with x = dt / dt(n), and limited against the junction voltages loaded at
   * the accepted point (CKTstate0 = CKTstate1, also on a retry). After the
   * operating point, with one accepted point, the prediction is that point
   * (dctran.c copies CKTstate1 into CKTstate2).
   *
   * The extrapolation runs on the node voltages, the same linear map for the
   * branch voltages, and is shared by every instance of the state store
   * (one vector copy per timepoint instead of per-instance history). ngspice
   * extrapolates the branch voltages of the last load of each accepted point
   * (the iterate before the accepted solution); spice-ts uses the accepted
   * solution, within the Newton tolerance of it, and the junction voltages
   * of the last load before the step (after the trapezoidal history restamp).
   * A node that did not move is predicted exactly, so a settled device keeps
   * its cached load (#842).
   *
   * ponytail: the Meyer and junction charge companions are still evaluated
   * at the iterate; ngspice extrapolates qgs/qgd/qgb on this iterate too.
   */
  beginTransientNewton(dt: number, accepted: Float64Array): void {
    this.stateStore.beginPredictor(dt, accepted);
  }

  /** {@link beginTransientNewton} for every instance in `mosfets`, once per state store. */
  static batchBeginTransientNewton(mosfets: readonly MOSFET[], dt: number, accepted: Float64Array): void {
    const length = mosfets.length;
    if (length === 0) return;
    let cached = predictorStores.get(mosfets);
    if (cached === undefined || cached.stateEpoch !== stateStoreEpoch || cached.length !== length) {
      // Merging stores bumps the epoch, so resolve them before recording it.
      const store = MOSFET.sharedStateStore(mosfets);
      cached = { length, stateEpoch: stateStoreEpoch, store };
      predictorStores.set(mosfets, cached);
    }
    cached.store.beginPredictor(dt, accepted);
  }

  private acceptCharges(ctx: StampContext): void {
    this.evaluateCharges(ctx);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      const voltage = branchVoltage(ctx, this.chargeNode(p), this.chargeNode(n));
      const capacitance = this.capacitances[index];
      const charge = index < 3
        ? this.charges.incrementalCharge(index, voltage, capacitance, true) : this.junctionCharges[index];
      this.charges.accept(index, charge, voltage, capacitance);
    }
    this.charges.commit();
  }

  resetTransient(): void {
    this.charges.reset();
    this.stateStore.resetPredictor();
  }

  /** ngspice MOS1trunc: the gate charges only, not the bulk junctions. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptCharges(ctx), MOS_GATE_CHARGES);
  }

  stampAC(ctx: StampContext, _omega: number): void {
    this.stampDynamic(ctx);
  }

  private stampCapacitance(ctx: StampContext, n1: number, n2: number, value: number): void {
    // Include initially-zero Meyer entries in the locked sparsity pattern.
    if (n1 === n2) return;
    if (n1 >= 0) {
      ctx.stampC(n1, n1, value);
      if (n2 >= 0) ctx.stampC(n1, n2, -value);
    }
    if (n2 >= 0) {
      ctx.stampC(n2, n2, value);
      if (n1 >= 0) ctx.stampC(n2, n1, -value);
    }
  }

  private chargeNode(index: number): number {
    return index === 3 ? this.bulkNode : this.nodes[index];
  }

  /** mos1load.c DEVqmeyer plus qbd/qbs, evaluated without mutating accepted history. */
  private evaluateCharges(ctx: StampContext): void {
    const { polarity } = this.params;
    const vgs = polarity * branchVoltage(ctx, this.nodes[1], this.nodes[2]);
    const vds = polarity * branchVoltage(ctx, this.nodes[0], this.nodes[2]);
    const vbs = polarity * branchVoltage(ctx, this.bulkNode, this.nodes[2]);
    const vbd = vbs - vds;
    const inverse = vds < 0;
    const gate = inverse ? vgs - vds : vgs;
    const channel = this.evaluateChannel(gate, Math.abs(vds), inverse ? vbd : vbs);
    const von = channel[4];
    // mos1load.c passes the temperature-adjusted MOS1tPhi to DEVqmeyer.
    meyerHalfCapacitances(gate, inverse ? vgs : vgs - vds, von,
      Math.max(0, gate - von), this.tPhi, this.oxideCap, this.meyerHalf);
    this.capacitances[0] = 2 * this.meyerHalf[inverse ? 0 : 1] + this.overlaps[0];
    this.capacitances[1] = 2 * this.meyerHalf[inverse ? 1 : 0] + this.overlaps[1];
    this.capacitances[2] = 2 * this.meyerHalf[2] + this.overlaps[2];
    this.capacitances[3] = this.drainDepletion.capacitance(vbd);
    this.capacitances[4] = this.sourceDepletion.capacitance(vbs);
    this.junctionCharges[3] = polarity * this.drainDepletion.charge(vbd);
    this.junctionCharges[4] = polarity * this.sourceDepletion.charge(vbs);
  }

  /**
   * Value slots of this instance's G entries for the locked topology behind
   * `stampIndex`, in SLOT_* order (-1 where a terminal is ground). Resolved
   * once per topology, like ngspice TSTALLOC matrix pointers.
   */
  private resolveBatchSlots(stampIndex: (row: number, col: number) => number): Int32Array {
    const d = this.nodes[0];
    const g = this.nodes[1];
    const s = this.nodes[2];
    const bulk = this.bulkNode;
    const at = (row: number, col: number): number => (row >= 0 && col >= 0 ? stampIndex(row, col) : -1);
    const slots = Int32Array.of(
      at(d, g), at(d, d), at(d, s), at(s, g), at(s, d), at(s, s),
      at(bulk, bulk), at(bulk, s), at(bulk, d), at(s, bulk), at(d, bulk),
    );
    this.batchSlots = slots;
    this.batchSlotKey = stampIndex;
    return slots;
  }

  /**
   * True when every G entry {@link batchStamp} writes for this instance lies
   * in the locked topology behind `stampIndex` (resolving its slots).
   */
  canBatchStamp(stampIndex: (row: number, col: number) => number): boolean {
    try {
      this.resolveBatchSlots(stampIndex);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The list's {@link MosfetBatch} for `stampIndex`, rebuilt when the
   * topology, the list length or any MOSFET's constants changed.
   */
  private static batchFor(
    mosfets: readonly MOSFET[], stampIndex: (row: number, col: number) => number,
  ): MosfetBatch {
    const cached = mosfetBatches.get(mosfets);
    if (
      cached !== undefined && cached.stampIndex === stampIndex
      && cached.epoch === constantsEpoch && cached.stateEpoch === stateStoreEpoch
      && cached.length === mosfets.length
    ) {
      return cached;
    }
    const length = mosfets.length;
    // Merging stores bumps the epoch, so resolve them before recording it.
    const store = MOSFET.sharedStateStore(mosfets);
    const stateBases = new Int32Array(length);
    const nodes = new Int32Array(4 * length);
    const slots = new Int32Array(BATCH_SLOTS * length);
    const params = new Float64Array(BP_STRIDE * length);
    for (let m = 0; m < length; m++) {
      const mosfet = mosfets[m];
      const own = mosfet.batchSlotKey === stampIndex && mosfet.batchSlots !== null
        ? mosfet.batchSlots
        : mosfet.resolveBatchSlots(stampIndex);
      slots.set(own, BATCH_SLOTS * m);
      nodes[4 * m] = mosfet.nodes[0];
      nodes[4 * m + 1] = mosfet.nodes[1];
      nodes[4 * m + 2] = mosfet.nodes[2];
      nodes[4 * m + 3] = mosfet.bulkNode;
      const k = BP_STRIDE * m;
      params[k + BP_POLARITY] = mosfet.params.polarity;
      params[k + BP_VT] = mosfet.vt;
      params[k + BP_SOURCE_SAT] = mosfet.sourceSatCur;
      params[k + BP_DRAIN_SAT] = mosfet.drainSatCur;
      params[k + BP_SOURCE_VCRIT] = mosfet.sourceVcrit;
      params[k + BP_DRAIN_VCRIT] = mosfet.drainVcrit;
      params[k + BP_BETA] = mosfet.beta;
      params[k + BP_TPHI] = mosfet.tPhi;
      params[k + BP_SQRT_PHI] = mosfet.sqrtPhi;
      params[k + BP_BUILT_IN_VON] = mosfet.builtInVon;
      params[k + BP_GAMMA] = mosfet.params.GAMMA;
      params[k + BP_LAMBDA] = mosfet.params.LAMBDA;
      stateBases[m] = mosfet.stateBase;
    }
    const batch: MosfetBatch = {
      length, stampIndex, epoch: constantsEpoch, nodes, slots, params,
      stateEpoch: stateStoreEpoch, state: store.values, store, stateBases,
    };
    mosfetBatches.set(mosfets, batch);
    return batch;
  }

  /**
   * Batch-stamp multiple MOSFETs with direct typed-array writes,
   * bypassing StampContext closures for better performance on the fast path.
   * Performs exactly the additions of {@link stamp} for each device, in list
   * order, reading the per-device constants from the list's
   * {@link MosfetBatch}. A device whose inputs are bit-identical to its last
   * batched load (a settled stage of a large circuit, issue #842) stamps that
   * load's companion values without evaluating the model again.
   */
  static batchStamp(
    mosfets: MOSFET[],
    gValues: Float64Array,
    b: Float64Array,
    solution: Float64Array,
    stampIndex: (row: number, col: number) => number,
    gmin: number = DEVICE_GMIN,
  ): void {
    if (mosfets.length === 0) return;
    const batch = MOSFET.batchFor(mosfets, stampIndex);
    const nodes = batch.nodes;
    const allSlots = batch.slots;
    const params = batch.params;
    const state = batch.state;
    const stateBases = batch.stateBases;
    const store = batch.store;
    const loads = store.loadCache();
    const predictFlags = store.predictFlags;
    const junction = junctionScratch;
    const channel = channelScratch;
    for (let m = 0; m < mosfets.length; m++) {
      const q = 4 * m;
      const s = BATCH_SLOTS * m;
      const k = BP_STRIDE * m;
      const r = stateBases[m];
      const row = r / STATE_STRIDE;
      const c = row * LOAD_STRIDE;
      const jD = nodes[q];
      const nG = nodes[q + 1];
      const jS = nodes[q + 2];
      const jB = nodes[q + 3];
      const polarity = params[k + BP_POLARITY];
      // The first iterate of a transient timepoint is linearised at the
      // predicted terminal voltages (mos1load.c MODEINITPRED).
      const predict = predictFlags !== undefined && predictFlags[row] !== 0;
      if (predict) predictFlags![row] = 0;
      const vD = predict ? store.predictedVoltage(jD) : jD >= 0 ? solution[jD] : 0;
      const vG = predict ? store.predictedVoltage(nG) : nG >= 0 ? solution[nG] : 0;
      const vS = predict ? store.predictedVoltage(jS) : jS >= 0 ? solution[jS] : 0;
      const vB = predict ? store.predictedVoltage(jB) : jB >= 0 ? solution[jB] : 0;
      const inVbs = state[r + STATE_VBS];
      const inVbd = state[r + STATE_VBD];

      // Reverse mode swaps drain and source, their value slots, and uses vbd.
      let nD = jD;
      let nS = jS;
      let vGS = polarity * (vG - vS);
      let vDS = polarity * (vD - vS);
      const reverse = vDS < 0;
      if (reverse) {
        nD = jS;
        nS = jD;
        vGS -= vDS;
        vDS = -vDS;
      }

      let gbs: number, gbd: number, ceqbs: number, ceqbd: number;
      let gm: number, gds: number, gmbs: number, Ieq: number;
      // Same IEEE-754 values: `===` rejects NaN (an invalidated key), Object.is
      // tells -0 from +0. V8 lowers both inline.
      const kD = loads[c + LOAD_VD], kG = loads[c + LOAD_VG];
      const kS = loads[c + LOAD_VS], kB = loads[c + LOAD_VB];
      const kVbs = loads[c + LOAD_LAST_VBS], kVbd = loads[c + LOAD_LAST_VBD];
      const kGmin = loads[c + LOAD_GMIN];
      if (
        kD === vD && kG === vG && kS === vS && kB === vB
        && kVbs === inVbs && kVbd === inVbd && kGmin === gmin
        && Object.is(kD, vD) && Object.is(kG, vG) && Object.is(kS, vS) && Object.is(kB, vB)
        && Object.is(kVbs, inVbs) && Object.is(kVbd, inVbd) && Object.is(kGmin, gmin)
      ) {
        // The device's last load had exactly these inputs, and its state row
        // still holds that load's writes except for junction charge folds
        // (see MosfetStateStore.loadCache), so evaluating again would rewrite
        // the same state and stamp the same values: restore the fold-affected
        // state and reuse the rest.
        gbs = loads[c + LOAD_GBS];
        gbd = loads[c + LOAD_GBD];
        state[r + STATE_CD] = loads[c + LOAD_CD];
        state[r + STATE_CBS] = loads[c + LOAD_CBS];
        state[r + STATE_CBD] = loads[c + LOAD_CBD];
        state[r + STATE_GBS] = gbs;
        state[r + STATE_GBD] = gbd;
        ceqbs = loads[c + LOAD_CEQBS];
        ceqbd = loads[c + LOAD_CEQBD];
        gm = loads[c + LOAD_GM];
        gds = loads[c + LOAD_GDS];
        gmbs = loads[c + LOAD_GMBS];
        Ieq = loads[c + LOAD_IEQ];
      } else {
        // Bulk junctions first (limited vbs/vbd feed the drain current), on the unswapped terminals.
        mos1BulkJunctions(
          junction, vD, vS, vB, polarity, inVbs, inVbd, params[k + BP_VT],
          params[k + BP_SOURCE_VCRIT], params[k + BP_DRAIN_VCRIT],
          params[k + BP_SOURCE_SAT], params[k + BP_DRAIN_SAT], gmin,
        );
        const lastVbs = junction[4];
        const lastVbd = junction[5];
        state[r + STATE_VBS] = lastVbs;
        state[r + STATE_VBD] = lastVbd;
        state[r + STATE_LIMITED] = junction[6];
        gbs = junction[0];
        gbd = junction[2];
        ceqbs = polarity * junction[1];
        ceqbd = polarity * junction[3];

        const vBS = reverse ? lastVbd : lastVbs;
        mos1Channel(
          channel, vGS, vDS, vBS, params[k + BP_TPHI], params[k + BP_SQRT_PHI],
          params[k + BP_BUILT_IN_VON], params[k + BP_GAMMA], params[k + BP_LAMBDA], params[k + BP_BETA],
        );
        const ID = channel[0];
        gm = channel[1];
        gds = channel[2] + GMIN;
        gmbs = channel[3];
        state[r + STATE_VON] = channel[4];
        recordMos1Load(state, r, junction, polarity * (vG - vS), polarity * (vD - vS), ID, gm, gds, gmbs);
        Ieq = ID - gm * vGS - gds * vDS - gmbs * vBS;

        loads[c + LOAD_VD] = vD;
        loads[c + LOAD_VG] = vG;
        loads[c + LOAD_VS] = vS;
        loads[c + LOAD_VB] = vB;
        loads[c + LOAD_LAST_VBS] = inVbs;
        loads[c + LOAD_LAST_VBD] = inVbd;
        loads[c + LOAD_GMIN] = gmin;
        loads[c + LOAD_GBS] = gbs;
        loads[c + LOAD_GBD] = gbd;
        loads[c + LOAD_CEQBS] = ceqbs;
        loads[c + LOAD_CEQBD] = ceqbd;
        loads[c + LOAD_GM] = gm;
        loads[c + LOAD_GDS] = gds;
        loads[c + LOAD_GMBS] = gmbs;
        loads[c + LOAD_IEQ] = Ieq;
        loads[c + LOAD_CD] = state[r + STATE_CD];
        loads[c + LOAD_CBS] = state[r + STATE_CBS];
        loads[c + LOAD_CBD] = state[r + STATE_CBD];
      }

      if (jB >= 0) {
        gValues[allSlots[s + SLOT_BB]] += gbs + gbd;
        if (jS >= 0) gValues[allSlots[s + SLOT_BS]] -= gbs;
        if (jD >= 0) gValues[allSlots[s + SLOT_BD]] -= gbd;
        b[jB] -= ceqbs + ceqbd;
      }
      if (jS >= 0) {
        gValues[allSlots[s + SLOT_SS]] += gbs;
        if (jB >= 0) gValues[allSlots[s + SLOT_SB]] -= gbs;
        b[jS] += ceqbs;
      }
      if (jD >= 0) {
        gValues[allSlots[s + SLOT_DD]] += gbd;
        if (jB >= 0) gValues[allSlots[s + SLOT_DB]] -= gbd;
        b[jD] += ceqbd;
      }

      let slotDG = allSlots[s + SLOT_DG], slotDD = allSlots[s + SLOT_DD];
      let slotDS = allSlots[s + SLOT_DS], slotDB = allSlots[s + SLOT_DB];
      let slotSG = allSlots[s + SLOT_SG], slotSD = allSlots[s + SLOT_SD];
      let slotSS = allSlots[s + SLOT_SS], slotSB = allSlots[s + SLOT_SB];
      if (reverse) {
        slotDG = allSlots[s + SLOT_SG]; slotDD = allSlots[s + SLOT_SS];
        slotDS = allSlots[s + SLOT_SD]; slotDB = allSlots[s + SLOT_SB];
        slotSG = allSlots[s + SLOT_DG]; slotSD = allSlots[s + SLOT_DS];
        slotSS = allSlots[s + SLOT_DD]; slotSB = allSlots[s + SLOT_DB];
      }

      if (nD >= 0) {
        if (nG >= 0) gValues[slotDG] += gm;
        gValues[slotDD] += gds;
        if (nS >= 0) gValues[slotDS] -= gm + gds + gmbs;
        if (jB >= 0 && gmbs !== 0) gValues[slotDB] += gmbs;
        b[nD] -= polarity * Ieq;
      }
      if (nS >= 0) {
        if (nG >= 0) gValues[slotSG] -= gm;
        if (nD >= 0) gValues[slotSD] -= gds;
        gValues[slotSS] += gm + gds + gmbs;
        if (jB >= 0 && gmbs !== 0) gValues[slotSB] -= gmbs;
        b[nS] += polarity * Ieq;
      }
    }
  }
}
