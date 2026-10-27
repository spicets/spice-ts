import {
  DEVICE_GMIN, type ChargeIntegration, type ChargeTruncation, type ConvergenceTolerances, type DeviceModel,
  type StampContext,
} from './device.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';
import {
  branchVoltage, meyerHalfCapacitances, stampCapacitance,
} from './mos6.js';
import { fetlim, limvds, pnjlim, stepScale } from './devsup.js';
import { InvalidCircuitError } from '../errors.js';

/**
 * MOSFET level 2: the Grove-Frohman analytical model, ported from ngspice-47
 * src/spicelib/devices/mos2 (mos2set.c defaults, mos2temp.c temperature and
 * parameter preprocessing, mos2load.c moseq2 drain current, bulk junctions,
 * limiting and charges, mos2trun.c truncation) plus devsup.c DEVqmeyer for
 * the Meyer gate capacitances.
 *
 * As in mos2load.c the multiplier M is folded into the saturation currents,
 * Beta, the oxide capacitance, the overlap capacitances and the zero-bias
 * junction capacitances; the junction GMIN is not scaled by M.
 *
 * Transient charges are integrated as mos2load.c does with NIintegrate
 * (TransientChargeState): the Meyer gate charges advance from the accepted
 * point with the averaged DEVqmeyer capacitance plus the overlap capacitance,
 * and the bulk junction charges are the exact depletion charges qbs/qbd.
 *
 * Drain/source series resistances are expanded by Circuit into linear
 * resistors ahead of the prime nodes, shared by DC, AC and transient loads.
 */

// ngspice const.h
const CHARGE = 1.6021766208e-19;
const CONSTBOLTZ = 1.38064852e-23;
const CONSTKOVERQ = CONSTBOLTZ / CHARGE;
const CONSTCTOK = 273.15;
const REFTEMP = 27 + CONSTCTOK;
const CONSTROOT2 = Math.SQRT2;
const MAX_EXP_ARG = 709;
// ngspice CKTdefaultMosL / CKTdefaultMosW.
const DEFAULT_MOS_LENGTH = 100e-6;
const DEFAULT_MOS_WIDTH = 100e-6;
/** mos2load.c / mos2temp.c EPSSIL. */
const EPSSIL = 11.7 * 8.854214871e-12;
const EPS_OX = 3.9 * 8.854214871e-12;
/** mos2load.c sig1/sig2 root sign tables of the Baum velocity-saturation quartic. */
const SIG1 = [1, -1, 1, -1];
const SIG2 = [1, 1, -1, -1];

/** Resolved MOS2 model card after mos2set.c defaulting and mos2temp.c model preprocessing. */
export interface MOS2ModelParams {
  /** mos2noi.c, default NLEV=2 from mos2set.c. */
  KF: number;
  AF: number;
  NLEV: number;
  polarity: number;
  VTO: number;
  KP: number;
  GAMMA: number;
  PHI: number;
  LAMBDA: number;
  IS: number;
  JS: number;
  PB: number;
  CJ: number;
  CJSW: number;
  MJ: number;
  MJSW: number;
  FC: number;
  CBD: number;
  CBS: number;
  CGSO: number;
  CGDO: number;
  CGBO: number;
  LD: number;
  U0: number;
  NSUB: number;
  DELTA: number;
  UEXP: number;
  UCRIT: number;
  VMAX: number;
  XJ: number;
  NEFF: number;
  NFS: number;
  TNOM: number;
  /** mos2temp.c MOS2oxideCapFactor = EPS_OX / TOX (TOX defaults to 1e-7 m). */
  oxideCapFactor: number;
  /** mos2temp.c MOS2xd, the depletion width factor (0 without NSUB). */
  xd: number;
  given: {
    CBD: boolean;
    CBS: boolean;
    CJ: boolean;
    CJSW: boolean;
  };
}

export interface MOS2InstanceParams {
  W: number;
  L: number;
  M: number;
  AD: number;
  AS: number;
  PD: number;
  PS: number;
}

/** Temperature-dependent instance quantities (mos2temp.c), M included. */
interface MOS2TemperatureState {
  vt: number;
  tTransconductance: number;
  tPhi: number;
  tVbi: number;
  tVto: number;
  tBulkPot: number;
  tDepCap: number;
  drainSatCur: number;
  sourceSatCur: number;
  drainVcrit: number;
  sourceVcrit: number;
  Cbd: number;
  Cbdsw: number;
  Cbs: number;
  Cbssw: number;
  f2d: number;
  f3d: number;
  f4d: number;
  f2s: number;
  f3s: number;
  f4s: number;
}

/**
 * mos2set.c creates a prime node for nonzero RD/RS or RSH*squares.
 * mos2temp.c then gives RD/RS precedence, including explicit zero (open).
 * Return 0 for a short, Infinity for an open, otherwise ohms divided by M.
 * NRD/NRS default to one square; zero squares suppress the sheet resistor.
 */
export function mos2SeriesResistances(
  card: Readonly<Record<string, number | undefined>>,
  instance: Readonly<Record<string, number | undefined>> | undefined,
): { drain: number; source: number } {
  const m = instance?.M ?? 1;
  const sheet = card.RSH ?? 0;
  const resistance = (direct: number | undefined, squares: number): number => {
    if ((direct ?? 0) === 0 && (sheet === 0 || squares === 0)) return 0;
    if (direct !== undefined) return direct !== 0 ? direct / m : Infinity;
    return sheet * squares / m;
  };
  return {
    drain: resistance(card.RD, instance?.NRD ?? 1),
    source: resistance(card.RS, instance?.NRS ?? 1),
  };
}

function given(params: Readonly<Record<string, number | undefined>>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = params[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Apply mos2set.c defaults and the model-level part of mos2temp.c. Throws the
 * same fatal model errors ngspice reports (non-positive PHI, NSUB < Ni).
 */
export function resolveMOS2Model(
  name: string,
  params: Readonly<Record<string, number | undefined>>,
  polarity: number,
): MOS2ModelParams {
  const tnom = (params.TNOM ?? 27) + CONSTCTOK;
  const vtnom = tnom * CONSTKOVERQ;
  const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);

  let phi = params.PHI ?? 0.6;
  let gamma = params.GAMMA ?? 0;
  let vto = given(params, 'VTO', 'VT0') ?? 0;
  if (phi <= 0) {
    throw new InvalidCircuitError(`MOSFET level 2 model '${name}': Phi is not positive`);
  }

  const tox = params.TOX ?? 1e-7;
  const oxideCapFactor = EPS_OX / tox;
  const mobility = given(params, 'U0', 'UO') ?? 600;
  const kp = params.KP ?? mobility * 1e-4 * oxideCapFactor;

  let nsub = 0;
  let xd = 0;
  if (params.NSUB !== undefined) {
    nsub = params.NSUB;
    if (nsub * 1e6 > 1.45e16) {
      if (params.PHI === undefined) {
        phi = 2 * vtnom * Math.log(nsub * 1e6 / 1.45e16);
        phi = Math.max(0.1, phi);
      }
      const fermis = polarity * 0.5 * phi;
      let wkfng = 3.2;
      const gateType = params.TPG ?? 1;
      if (gateType !== 0) {
        const fermig = polarity * gateType * 0.5 * egfet1;
        wkfng = 3.25 + 0.5 * egfet1 - fermig;
      }
      const wkfngs = wkfng - (3.25 + 0.5 * egfet1 + fermis);
      if (params.GAMMA === undefined) {
        gamma = Math.sqrt(2 * 11.70 * 8.854214871e-12 * CHARGE * nsub * 1e6) / oxideCapFactor;
      }
      if (given(params, 'VTO', 'VT0') === undefined) {
        const nss = params.NSS ?? 0;
        const vfb = wkfngs - nss * 1e4 * CHARGE / oxideCapFactor;
        vto = vfb + polarity * (gamma * Math.sqrt(phi) + phi);
      }
      xd = Math.sqrt((EPSSIL + EPSSIL) / (CHARGE * nsub * 1e6));
    } else {
      throw new InvalidCircuitError(`MOSFET level 2 model '${name}': Nsub < Ni`);
    }
  }

  return {
    polarity,
    VTO: vto,
    KP: kp,
    GAMMA: gamma,
    PHI: phi,
    LAMBDA: params.LAMBDA ?? 0,
    IS: params.IS ?? 1e-14,
    JS: params.JS ?? 0,
    PB: params.PB ?? 0.8,
    CJ: params.CJ ?? 0,
    CJSW: params.CJSW ?? 0,
    MJ: params.MJ ?? 0.5,
    MJSW: params.MJSW ?? 0.33,
    FC: params.FC ?? 0.5,
    CBD: params.CBD ?? 0,
    CBS: params.CBS ?? 0,
    CGSO: params.CGSO ?? 0,
    CGDO: params.CGDO ?? 0,
    CGBO: params.CGBO ?? 0,
    LD: params.LD ?? 0,
    U0: mobility,
    NSUB: nsub,
    DELTA: params.DELTA ?? 0,
    UEXP: params.UEXP ?? 0,
    UCRIT: params.UCRIT ?? 1e4,
    VMAX: params.VMAX ?? 0,
    XJ: params.XJ ?? 0,
    NEFF: params.NEFF ?? 1,
    NFS: params.NFS ?? 0,
    TNOM: tnom,
    KF: params.KF ?? 0,
    AF: params.AF ?? 1,
    NLEV: params.NLEV ?? 2,
    oxideCapFactor,
    xd,
    given: {
      CBD: params.CBD !== undefined,
      CBS: params.CBS !== undefined,
      CJ: params.CJ !== undefined,
      CJSW: params.CJSW !== undefined,
    },
  };
}

/** moseq2 result (polarity domain, source/drain swapped by mode). */
export interface MOS2Channel {
  /** +1 normal mode (vds >= 0), -1 inverse mode. */
  mode: number;
  cdrain: number;
  gm: number;
  gds: number;
  gmbs: number;
  von: number;
  vdsat: number;
}

/** Linearisation of the last load, read by the mos2conv.c convergence test (polarity domain). */
interface MOS2Load {
  vbs: number;
  vbd: number;
  vgs: number;
  vds: number;
  mode: number;
  /** MOS2cd = mode * cdrain - cbd (minus cqbd in transient). */
  cd: number;
  cbs: number;
  cbd: number;
  gm: number;
  gds: number;
  gmbs: number;
  gbs: number;
  gbd: number;
  /** mos2load.c Check: DEVpnjlim limited a junction (CKTnoncon). */
  limited: boolean;
}

/** Reused scratch buffer for the Meyer half capacitances; consumed immediately. */
const halfScratch = new Float64Array(3);

/** Charge indices of the gate-source, gate-drain, gate-bulk, bulk-source and bulk-drain charges. */
const GATE_SOURCE = 0;
const GATE_DRAIN = 1;
const GATE_BULK = 2;
const BULK_SOURCE = 3;
const BULK_DRAIN = 4;
/** Number of Meyer gate charges (indices below this use the averaged DEVqmeyer increment). */
const GATE_CHARGES = 3;
/** mos2trun.c truncates the three Meyer gate charges only, not the bulk junctions. */
const TRUNCATED_CHARGES: readonly number[] = [GATE_SOURCE, GATE_DRAIN, GATE_BULK];
/** Terminal indices (D, G, S, B) of each charge, positive then negative, in charge-index order. */
const CHARGE_BRANCHES: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [1, 0], [1, 3], [3, 2], [3, 0],
];

export class MOS2 implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  readonly initializesOperatingPoint = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (MOS2trunc: qgs, qgd, qgb). */
  readonly truncationCoversCharges = true;
  readonly model: MOS2ModelParams;
  readonly instance: MOS2InstanceParams;
  private readonly effectiveLength: number;
  /** mos2load.c unscaledOxideCap (no M) and OxideCap (with M). */
  private readonly unscaledOxideCap: number;
  private readonly oxideCap: number;
  private readonly overlapGS: number;
  private readonly overlapGD: number;
  private readonly overlapGB: number;
  /** mos2load.c narrow-channel factor (constant per device). */
  private readonly narrowFactor: number;
  private temperature = 27;
  private readonly instanceTemperature: number | undefined;
  private readonly deltaTemperature: number;
  private temp!: MOS2TemperatureState;
  /** Beta = tKP * W * M / Leff (mos2load.c). */
  private beta = 0;
  /** ngspice CKTstate0 vbs/vbd and MOS2von of the previous load. */
  private lastVbs = 0;
  private lastVbd = 0;
  private lastVon = 0;
  /** MOS2gm / MOS2gmbs of the previous load (moseq2 keeps them on one subthreshold path). */
  private lastGm = 0;
  private lastGmbs = 0;
  private operatingPointLoad = false;
  private readonly lastLoad: MOS2Load = {
    vbs: 0, vbd: 0, vgs: 0, vds: 0, mode: 1, cd: 0, cbs: 0, cbd: 0, gm: 0, gds: 0, gmbs: 0, gbs: 0, gbd: 0,
    limited: false,
  };
  /** Transient gate and bulk-junction charges (ngspice MOS2qgs..MOS2qbd), integrated by the device. */
  readonly integratesTransientCharge = true;
  readonly storesCharge: boolean;
  private readonly charges = new TransientChargeState(CHARGE_BRANCHES.length);
  private readonly chargeScratch = new Float64Array(CHARGE_BRANCHES.length);
  private readonly capacitanceScratch = new Float64Array(CHARGE_BRANCHES.length);
  /** Accepted polarity-domain [vgs, vds, vbs], used only for MODEINITPRED. */
  private acceptedTerminals: [number, number, number] | undefined;
  private previousTerminals: [number, number, number] | undefined;
  private acceptedDt = 0;
  private predictedTerminals: [number, number, number] | undefined;
  private predictorFactor = 0;
  private transientLoadContext: StampContext | undefined;
  private readonly loadedCharge = new Float64Array(CHARGE_BRANCHES.length);
  private readonly loadedVoltage = new Float64Array(CHARGE_BRANCHES.length);
  private readonly loadedCapacitance = new Float64Array(CHARGE_BRANCHES.length);
  private hasLoadedCharge = false;

  constructor(
    readonly name: string,
    /** [drain, gate, source, bulk] */
    readonly nodes: number[],
    model: MOS2ModelParams,
    instance: Partial<MOS2InstanceParams> & { TEMP?: number; DTEMP?: number },
    circuitTemperature = 27,
  ) {
    this.instanceTemperature = instance.TEMP;
    this.deltaTemperature = instance.DTEMP ?? 0;
    this.model = model;
    this.instance = {
      W: instance.W ?? DEFAULT_MOS_WIDTH,
      L: instance.L ?? DEFAULT_MOS_LENGTH,
      M: instance.M ?? 1,
      AD: instance.AD ?? 0,
      AS: instance.AS ?? 0,
      PD: instance.PD ?? 0,
      PS: instance.PS ?? 0,
    };
    const { W, L, M } = this.instance;
    this.effectiveLength = L - 2 * model.LD;
    if (!(this.effectiveLength > 0)) {
      throw new InvalidCircuitError(`${name}: MOSFET level 2 effective channel length is not positive`);
    }
    const leff = this.effectiveLength;
    this.unscaledOxideCap = model.oxideCapFactor * leff * W;
    this.oxideCap = this.unscaledOxideCap * M;
    this.overlapGS = model.CGSO * M * W;
    this.overlapGD = model.CGDO * M * W;
    this.overlapGB = model.CGBO * M * leff;
    this.narrowFactor = 0.125 * model.DELTA * 2.0 * Math.PI * EPSSIL / this.unscaledOxideCap * leff;
    this.setTemperature(circuitTemperature);
    this.lastVon = this.temp.tVto * model.polarity;
    const { Cbs, Cbssw, Cbd, Cbdsw } = this.temp;
    this.storesCharge = [this.oxideCap, this.overlapGS, this.overlapGD, this.overlapGB, Cbs, Cbssw, Cbd, Cbdsw]
      .some(value => value !== 0);
  }

  setTemperature(value: number): void {
    const effective = this.instanceTemperature ?? value + this.deltaTemperature;
    if (!Number.isFinite(effective) || effective + CONSTCTOK <= 0) {
      throw new InvalidCircuitError(`${this.name}: MOS2 effective temperature must be finite and positive Kelvin (TEMP=${effective} C)`);
    }
    this.temperature = value;
    this.applyTemperature();
  }

  getTemperature(): number {
    // mos2temp.c: explicit TEMP ignores DTEMP; otherwise add DTEMP to CKTtemp.
    return this.instanceTemperature ?? this.temperature + this.deltaTemperature;
  }

  getCircuitTemperature(): number {
    return this.temperature;
  }

  /** mos2temp.c instance loop. */
  private applyTemperature(): void {
    const model = this.model;
    const { W, M, AD, AS, PD, PS } = this.instance;
    const tnom = model.TNOM;
    const fact1 = tnom / REFTEMP;
    const vtnom = tnom * CONSTKOVERQ;
    const kt1 = CONSTBOLTZ * tnom;
    const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
    const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTBOLTZ * (REFTEMP + REFTEMP));
    const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);

    const temp = this.getTemperature() + CONSTCTOK;
    const vt = temp * CONSTKOVERQ;
    const ratio = temp / tnom;
    const fact2 = temp / REFTEMP;
    const kt = temp * CONSTBOLTZ;
    const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
    const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTBOLTZ * (REFTEMP + REFTEMP));
    const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);

    const ratio4 = ratio * Math.sqrt(ratio);
    const tTransconductance = model.KP / ratio4;
    const phio = (model.PHI - pbfact1) / fact1;
    const tPhi = fact2 * phio + pbfact;
    const type = model.polarity;
    const tVbi = model.VTO - type * (model.GAMMA * Math.sqrt(model.PHI))
      + 0.5 * (egfet1 - egfet) + type * 0.5 * (tPhi - model.PHI);
    const tVto = tVbi + type * model.GAMMA * Math.sqrt(tPhi);
    const satScale = Math.exp(-egfet / vt + egfet1 / vtnom);
    const tSatCur = model.IS * satScale;
    const tSatCurDens = model.JS * satScale;
    const pbo = (model.PB - pbfact1) / fact1;
    const gmaold = (model.PB - pbo) / pbo;
    let capfact = 1 / (1 + model.MJ * (4e-4 * (tnom - REFTEMP) - gmaold));
    let tCbd = model.CBD * capfact;
    let tCbs = model.CBS * capfact;
    let tCj = model.CJ * capfact;
    capfact = 1 / (1 + model.MJSW * (4e-4 * (tnom - REFTEMP) - gmaold));
    let tCjsw = model.CJSW * capfact;
    const tBulkPot = fact2 * pbo + pbfact;
    const gmanew = (tBulkPot - pbo) / pbo;
    capfact = 1 + model.MJ * (4e-4 * (temp - REFTEMP) - gmanew);
    tCbd *= capfact;
    tCbs *= capfact;
    tCj *= capfact;
    capfact = 1 + model.MJSW * (4e-4 * (temp - REFTEMP) - gmanew);
    tCjsw *= capfact;
    const tDepCap = model.FC * tBulkPot;

    const useDensity = !(tSatCurDens === 0 || AD === 0 || AS === 0);
    let drainVcrit: number;
    let sourceVcrit: number;
    if (!useDensity) {
      drainVcrit = sourceVcrit = vt * Math.log(vt / (CONSTROOT2 * M * tSatCur));
    } else {
      drainVcrit = vt * Math.log(vt / (CONSTROOT2 * M * tSatCurDens * AD));
      sourceVcrit = vt * Math.log(vt / (CONSTROOT2 * M * tSatCurDens * AS));
    }
    // mos2load.c DrainSatCur / SourceSatCur.
    const drainSatCur = useDensity ? M * tSatCurDens * AD : M * tSatCur;
    const sourceSatCur = useDensity ? M * tSatCurDens * AS : M * tSatCur;

    const junction = (zeroBias: number, sidewall: number) => {
      const argFc = 1 - model.FC;
      const sarg = Math.exp(-model.MJ * Math.log(argFc));
      const sargsw = Math.exp(-model.MJSW * Math.log(argFc));
      const f2 = zeroBias * (1 - model.FC * (1 + model.MJ)) * sarg / argFc
        + sidewall * (1 - model.FC * (1 + model.MJSW)) * sargsw / argFc;
      const f3 = zeroBias * model.MJ * sarg / argFc / tBulkPot
        + sidewall * model.MJSW * sargsw / argFc / tBulkPot;
      const f4 = zeroBias * tBulkPot * (1 - argFc * sarg) / (1 - model.MJ)
        + sidewall * tBulkPot * (1 - argFc * sargsw) / (1 - model.MJSW)
        - f3 / 2 * (tDepCap * tDepCap)
        - tDepCap * f2;
      return { f2, f3, f4 };
    };
    const czbd = model.given.CBD ? tCbd * M : model.given.CJ ? tCj * AD * M : 0;
    const czbdsw = model.given.CJSW ? tCjsw * PD * M : 0;
    const czbs = model.given.CBS ? tCbs * M : model.given.CJ ? tCj * AS * M : 0;
    const czbssw = model.given.CJSW ? tCjsw * PS * M : 0;
    const drain = junction(czbd, czbdsw);
    const source = junction(czbs, czbssw);

    this.beta = tTransconductance * W * M / this.effectiveLength;
    this.temp = {
      vt, tTransconductance, tPhi, tVbi, tVto, tBulkPot, tDepCap,
      drainSatCur, sourceSatCur, drainVcrit, sourceVcrit,
      Cbd: czbd, Cbdsw: czbdsw, Cbs: czbs, Cbssw: czbssw,
      f2d: drain.f2, f3d: drain.f3, f4d: drain.f4,
      f2s: source.f2, f3s: source.f3, f4s: source.f4,
    };
  }

  /**
   * mos2load.c moseq2 block: drain current and derivatives in the polarity
   * domain for terminal voltages vgs, vds, vbs (polarity domain, unswapped).
   * `previousGm`/`previousGmbs` are MOS2gm/MOS2gmbs of the previous load,
   * which one NFS subthreshold path keeps unchanged as ngspice does.
   */
  evaluateChannel(vgs: number, vds: number, vbs: number, previousGm = 0, previousGmbs = 0): MOS2Channel {
    const model = this.model;
    const { tPhi, tVbi, tBulkPot, vt } = this.temp;
    const leff = this.effectiveLength;
    const oxideCap = this.oxideCap;
    const xd = model.xd;
    const mode = vds >= 0 ? 1 : -1;
    const vbd = vbs - vds;
    const vgd = vgs - vds;
    const lvbs = mode === 1 ? vbs : vbd;
    const lvds = mode * vds;
    const lvgs = mode === 1 ? vgs : vgd;
    const phiMinVbs = tPhi - lvbs;
    let xlamda = model.LAMBDA;
    let tmp: number;
    let sphi: number;
    let sphi3: number;

    let sarg1: number;
    let dsrgdb: number;
    let d2sdb2: number;
    if (lvbs <= 0.0) {
      sarg1 = Math.sqrt(phiMinVbs);
      dsrgdb = -0.5 / sarg1;
      d2sdb2 = 0.5 * dsrgdb / phiMinVbs;
    } else {
      sphi = Math.sqrt(tPhi);
      sphi3 = tPhi * sphi;
      sarg1 = sphi / (1.0 + 0.5 * lvbs / tPhi);
      tmp = sarg1 / sphi3;
      dsrgdb = -0.5 * sarg1 * tmp;
      d2sdb2 = -dsrgdb * tmp;
    }
    let barg: number;
    let dbrgdb: number;
    let d2bdb2: number;
    if ((lvbs - lvds) <= 0) {
      barg = Math.sqrt(phiMinVbs + lvds);
      dbrgdb = -0.5 / barg;
      d2bdb2 = 0.5 * dbrgdb / (phiMinVbs + lvds);
    } else {
      sphi = Math.sqrt(tPhi);
      sphi3 = tPhi * sphi;
      barg = sphi / (1.0 + 0.5 * (lvbs - lvds) / tPhi);
      tmp = barg / sphi3;
      dbrgdb = -0.5 * barg * tmp;
      d2bdb2 = -dbrgdb * tmp;
    }

    // Threshold voltage (von), narrow-channel effect.
    const factor = this.narrowFactor;
    const eta = 1.0 + factor;
    const vbin = tVbi * model.polarity + factor * phiMinVbs;
    let gamasd: number;
    let dgddvb: number;
    let dgdvds: number;
    let dgddb2: number;
    if (model.GAMMA > 0.0 || model.NSUB > 0.0) {
      const xwd = xd * barg;
      const xws = xd * sarg1;
      // Short-channel effect with vds != 0.
      let argss = 0.0;
      let argsd = 0.0;
      let dbargs = 0.0;
      let dbargd = 0.0;
      let args = 0.0;
      let argd = 0.0;
      let argxs = 0.0;
      let argxd = 0.0;
      dgdvds = 0.0;
      dgddb2 = 0.0;
      if (model.XJ > 0) {
        tmp = 2.0 / model.XJ;
        argxs = 1.0 + xws * tmp;
        argxd = 1.0 + xwd * tmp;
        args = Math.sqrt(argxs);
        argd = Math.sqrt(argxd);
        tmp = 0.5 * model.XJ / leff;
        argss = tmp * (args - 1.0);
        argsd = tmp * (argd - 1.0);
      }
      gamasd = model.GAMMA * (1.0 - argss - argsd);
      const dbxwd = xd * dbrgdb;
      const dbxws = xd * dsrgdb;
      if (model.XJ > 0) {
        tmp = 0.5 / leff;
        dbargs = tmp * dbxws / args;
        dbargd = tmp * dbxwd / argd;
        const dasdb2 = -xd * (d2sdb2 + dsrgdb * dsrgdb * xd / (model.XJ * argxs)) / (leff * args);
        const daddb2 = -xd * (d2bdb2 + dbrgdb * dbrgdb * xd / (model.XJ * argxd)) / (leff * argd);
        dgddb2 = -0.5 * model.GAMMA * (dasdb2 + daddb2);
      }
      dgddvb = -model.GAMMA * (dbargs + dbargd);
      if (model.XJ > 0) {
        const ddxwd = -dbxwd;
        dgdvds = -model.GAMMA * 0.5 * ddxwd / (leff * argd);
      }
    } else {
      gamasd = model.GAMMA;
      dgddvb = 0.0;
      dgdvds = 0.0;
      dgddb2 = 0.0;
    }
    let von = vbin + gamasd * sarg1;
    const vth = von;
    let vdsat = 0.0;
    const surfaceStates = model.NFS !== 0.0 && oxideCap !== 0.0;
    let xn = 0.0;
    let argg = 0.0;
    let vgst: number;
    const cutoff = (gds: number): MOS2Channel => ({ mode, cdrain: 0, gm: 0, gds, gmbs: 0, von, vdsat });
    if (surfaceStates) {
      const cfs = CHARGE * model.NFS * 1e4;
      const cdonco = -(gamasd * dsrgdb + dgddvb * sarg1) + factor;
      xn = 1.0 + cfs / this.unscaledOxideCap * this.instance.W * leff + cdonco;
      tmp = vt * xn;
      von = von + tmp;
      argg = 1.0 / tmp;
      vgst = lvgs - von;
    } else {
      vgst = lvgs - von;
      if (lvgs <= vbin) return cutoff(0.0);
    }

    const sarg3 = sarg1 * sarg1 * sarg1;
    const sbiarg = Math.sqrt(tBulkPot);
    let gammad = gamasd;
    let dgdvbs = dgddvb;
    let body = barg * barg * barg - sarg3;
    let gdbdv = 2.0 * gammad * (barg * barg * dbrgdb - sarg1 * sarg1 * dsrgdb);
    let dodvbs = -factor + dgdvbs * sarg1 + gammad * dsrgdb;
    let dodvds = 0.0;
    let dxndvd = 0.0;
    let dxndvb = 0.0;
    let ufact: number;
    let ueff: number;
    let dudvgs: number;
    let dudvbs: number;
    const dudvds = 0.0;
    let mobilityDegraded = false;
    if (model.NFS === 0.0 || oxideCap !== 0.0) {
      if (model.NFS !== 0.0) {
        dxndvb = 2.0 * dgdvbs * dsrgdb + gammad * d2sdb2 + dgddb2 * sarg1;
        dodvbs = dodvbs + vt * dxndvb;
        dxndvd = dgdvds * dsrgdb;
        dodvds = dgdvds * sarg1 + vt * dxndvd;
      }
      // line400: effective mobility and its derivatives.
      if (oxideCap > 0.0) {
        const udenom = vgst;
        tmp = model.UCRIT * 100 * EPSSIL / model.oxideCapFactor;
        if (udenom > tmp) mobilityDegraded = true;
      }
    }
    if (mobilityDegraded) {
      const udenom = vgst;
      tmp = model.UCRIT * 100 * EPSSIL / model.oxideCapFactor;
      ufact = Math.exp(model.UEXP * Math.log(tmp / udenom));
      ueff = model.U0 * 1e-4 * ufact;
      dudvgs = -ufact * model.UEXP / udenom;
      dudvbs = model.UEXP * ufact * dodvbs / vgst;
    } else {
      // line410
      ufact = 1.0;
      ueff = model.U0 * 1e-4;
      dudvgs = 0.0;
      dudvbs = 0.0;
    }

    // line500: saturation voltage (Grove-Frohman).
    let vgsx = lvgs;
    gammad = gamasd / eta;
    dgdvbs = dgddvb;
    if (surfaceStates) vgsx = Math.max(lvgs, von);
    let dsdvgs: number;
    let dsdvbs: number;
    if (gammad > 0) {
      const gammd2 = gammad * gammad;
      const argv = (vgsx - vbin) / eta + phiMinVbs;
      if (argv <= 0.0) {
        vdsat = 0.0;
        dsdvgs = 0.0;
        dsdvbs = 0.0;
      } else {
        const arg1 = Math.sqrt(1.0 + 4.0 * argv / gammd2);
        vdsat = (vgsx - vbin) / eta + gammd2 * (1.0 - arg1) / 2.0;
        vdsat = Math.max(vdsat, 0.0);
        dsdvgs = (1.0 - 1.0 / arg1) / eta;
        dsdvbs = (gammad * (1.0 - arg1) + 2.0 * argv / (gammad * arg1)) / eta * dgdvbs
          + 1.0 / arg1 + factor * dsdvgs;
      }
    } else {
      vdsat = (vgsx - vbin) / eta;
      vdsat = Math.max(vdsat, 0.0);
      dsdvgs = 1.0;
      dsdvbs = 0.0;
    }
    if (model.VMAX > 0) {
      // Baum's theory of scattering-velocity saturation.
      const gammd2 = gammad * gammad;
      const v1 = (vgsx - vbin) / eta + phiMinVbs;
      const v2 = phiMinVbs;
      const xv = model.VMAX * leff / ueff;
      const a1 = gammad / 0.75;
      const b1 = -2.0 * (v1 + xv);
      const c1 = -2.0 * gammad * xv;
      const d1 = 2.0 * v1 * (v2 + xv) - v2 * v2 - 4.0 / 3.0 * gammad * sarg3;
      const a = -b1;
      const b = a1 * c1 - 4.0 * d1;
      const c = -d1 * (a1 * a1 - 4.0 * b1) - c1 * c1;
      const r = -a * a / 3.0 + b;
      const s = 2.0 * a * a * a / 27.0 - a * b / 3.0 + c;
      const r3 = r * r * r;
      const s2 = s * s;
      const p = s2 / 4.0 + r3 / 27.0;
      const p0 = Math.abs(p);
      const p2 = Math.sqrt(p0);
      let y3: number;
      if (p < 0) {
        let ro = Math.sqrt(s2 / 4.0 + p0);
        ro = Math.log(ro) / 3.0;
        ro = Math.exp(ro);
        const fi = Math.atan(-2.0 * p2 / s);
        y3 = 2.0 * ro * Math.cos(fi / 3.0) - a / 3.0;
      } else {
        let p3 = (-s / 2.0 + p2);
        p3 = Math.exp(Math.log(Math.abs(p3)) / 3.0);
        let p4 = (-s / 2.0 - p2);
        p4 = Math.exp(Math.log(Math.abs(p4)) / 3.0);
        y3 = p3 + p4 - a / 3.0;
      }
      const x4: number[] = [];
      const a3 = Math.sqrt(a1 * a1 / 4.0 - b1 + y3);
      const b3 = Math.sqrt(y3 * y3 / 4.0 - d1);
      for (let i = 0; i < 4; i++) {
        const a4 = a1 / 2.0 + SIG1[i] * a3;
        const b4 = y3 / 2.0 + SIG2[i] * b3;
        const delta4 = a4 * a4 / 4.0 - b4;
        if (delta4 < 0) continue;
        tmp = Math.sqrt(delta4);
        x4.push(-a4 / 2.0 + tmp);
        x4.push(-a4 / 2.0 - tmp);
      }
      let jknt = 0;
      let xvalid = 0.0;
      for (const x of x4) {
        if (x <= 0) continue;
        let poly4 = x * x * x * x + a1 * x * x * x;
        poly4 = poly4 + b1 * x * x + c1 * x + d1;
        if (Math.abs(poly4) > 1.0e-6) continue;
        jknt = jknt + 1;
        if (jknt <= 1) xvalid = x;
        if (x > xvalid) continue;
        xvalid = x;
      }
      if (jknt > 0) vdsat = xvalid * xvalid - phiMinVbs;
    }

    // Effective channel length and its derivatives.
    let dldvgs = 0.0;
    let dldvds = 0.0;
    let dldvbs = 0.0;
    let bsarg = 0.0;
    let dbsrdb = 0.0;
    let bodys = 0.0;
    let gdbdvs = 0.0;
    if (lvds !== 0.0) {
      gammad = gamasd;
      if ((lvbs - vdsat) <= 0) {
        bsarg = Math.sqrt(vdsat + phiMinVbs);
        dbsrdb = -0.5 / bsarg;
      } else {
        sphi = Math.sqrt(tPhi);
        sphi3 = tPhi * sphi;
        bsarg = sphi / (1.0 + 0.5 * (lvbs - vdsat) / tPhi);
        dbsrdb = -0.5 * bsarg * bsarg / sphi3;
      }
      bodys = bsarg * bsarg * bsarg - sarg3;
      gdbdvs = 2.0 * gammad * (bsarg * bsarg * dbsrdb - sarg1 * sarg1 * dsrgdb);
      let dldsat: number | undefined;
      if (model.VMAX <= 0) {
        if (model.NSUB !== 0.0 && !(xlamda > 0.0)) {
          const argv = (lvds - vdsat) / 4.0;
          const sargv = Math.sqrt(1.0 + argv * argv);
          const arg1 = Math.sqrt(argv + sargv);
          const xlfact = xd / (leff * lvds);
          xlamda = xlfact * arg1;
          dldsat = lvds * xlamda / (8.0 * sargv);
        }
      } else {
        const argv = (vgsx - vbin) / eta - vdsat;
        const xdv = xd / Math.sqrt(model.NEFF);
        const xlv = model.VMAX * xdv / (2.0 * ueff);
        const vqchan = argv - gammad * bsarg;
        const dqdsat = -1.0 + gammad * dbsrdb;
        const vl = model.VMAX * leff;
        const dfunds = vl * dqdsat - ueff * vqchan;
        const dfundg = (vl - ueff * vdsat) / eta;
        const dfundb = -vl * (1.0 + dqdsat - factor / eta) + ueff * (gdbdvs - dgdvbs * bodys / 1.5) / eta;
        dsdvgs = -dfundg / dfunds;
        dsdvbs = -dfundb / dfunds;
        if (model.NSUB !== 0.0 && !(xlamda > 0.0)) {
          const argvSat = Math.max(lvds - vdsat, 0.0);
          const xls = Math.sqrt(xlv * xlv + argvSat);
          dldsat = xdv / (2.0 * xls);
          const xlfact = xdv / (leff * lvds);
          xlamda = xlfact * (xls - xlv);
          dldsat = dldsat / leff;
        }
      }
      if (dldsat !== undefined) {
        dldvgs = dldsat * dsdvgs;
        dldvds = -xlamda + dldsat;
        dldvbs = dldsat * dsdvbs;
      }
    }

    // Limit channel shortening at punch-through.
    let xwb = xd * sbiarg;
    const xld = leff - xwb;
    let clfact = 1.0 - xlamda * lvds;
    dldvds = -xlamda - dldvds;
    let xleff = leff * clfact;
    const deltal = xlamda * lvds * leff;
    if (model.NSUB === 0.0) xwb = 0.25e-6;
    if (xleff < xwb) {
      xleff = xwb / (1.0 + (deltal - xld) / xwb);
      clfact = xleff / leff;
      const dfact = xleff * xleff / (xwb * xwb);
      dldvgs = dfact * dldvgs;
      dldvds = dfact * dldvds;
      dldvbs = dfact * dldvbs;
    }

    // Effective beta (effective kp).
    const beta1 = this.beta * ufact / clfact;
    gammad = gamasd;
    dgdvbs = dgddvb;
    if (lvds <= 1.0e-10) {
      if (lvgs <= von) {
        if (!surfaceStates) return cutoff(0.0);
        return cutoff(beta1 * (von - vbin - gammad * sarg1) * Math.exp(argg * (lvgs - von)));
      }
      return cutoff(beta1 * (lvgs - vbin - gammad * sarg1));
    }

    const result = (cdrain: number, gm: number, gds: number, gmbs: number): MOS2Channel => (
      { mode, cdrain, gm, gds, gmbs, von, vdsat }
    );
    if (surfaceStates ? lvgs <= von : lvgs <= vbin) {
      // mos2load.c `goto doneval` without NFS keeps MOS2gds/gm/gmbs; unreachable,
      // since lvgs <= vbin already returned through the cutoff above.
      if (!surfaceStates) return result(0, previousGm, 0, previousGmbs);
      // Subthreshold region.
      if (vdsat <= 0) {
        // mos2load.c `goto doneval` above vth keeps cdrain, MOS2gm and
        // MOS2gmbs of the previous evaluation; cdrain is a function-local
        // that ngspice zeroes per load call.
        if (lvgs > vth) return result(0, previousGm, 0, previousGmbs);
        return cutoff(0.0);
      }
      const vdson = Math.min(vdsat, lvds);
      if (lvds > vdsat) {
        barg = bsarg;
        dbrgdb = dbsrdb;
        body = bodys;
        gdbdv = gdbdvs;
      }
      const cdson = beta1 * ((von - vbin - eta * vdson * 0.5) * vdson - gammad * body / 1.5);
      const didvds = beta1 * (von - vbin - eta * vdson - gammad * barg);
      let gdson = -cdson * dldvds / clfact - beta1 * dgdvds * body / 1.5;
      if (lvds < vdsat) gdson = gdson + didvds;
      let gbson = -cdson * dldvbs / clfact + beta1
        * (dodvbs * vdson + factor * vdson - dgdvbs * body / 1.5 - gdbdv);
      if (lvds > vdsat) gbson = gbson + didvds * dsdvbs;
      const expg = Math.exp(argg * (lvgs - von));
      const cdrain = cdson * expg;
      const gmw = cdrain * argg;
      let gm = gmw;
      if (lvds > vdsat) gm = gmw + didvds * dsdvgs * expg;
      tmp = gmw * (lvgs - von) / xn;
      const gds = gdson * expg - gm * dodvds - tmp * dxndvd;
      const gmbs = gbson * expg - gm * dodvbs - tmp * dxndvb;
      return result(cdrain, gm, gds, gmbs);
    }

    // line900
    if (lvds <= vdsat) {
      // Linear region.
      const cdrain = beta1 * ((lvgs - vbin - eta * lvds / 2.0) * lvds - gammad * body / 1.5);
      let arg1 = cdrain * (dudvgs / ufact - dldvgs / clfact);
      const gm = arg1 + beta1 * lvds;
      arg1 = cdrain * (dudvds / ufact - dldvds / clfact);
      const gds = arg1 + beta1 * (lvgs - vbin - eta * lvds - gammad * barg - dgdvds * body / 1.5);
      arg1 = cdrain * (dudvbs / ufact - dldvbs / clfact);
      const gmbs = arg1 - beta1 * (gdbdv + dgdvbs * body / 1.5 - factor * lvds);
      return result(cdrain, gm, gds, gmbs);
    }
    // Saturation region.
    const cdrain = beta1 * ((lvgs - vbin - eta * vdsat / 2.0) * vdsat - gammad * bodys / 1.5);
    let arg1 = cdrain * (dudvgs / ufact - dldvgs / clfact);
    const gm = arg1 + beta1 * vdsat + beta1 * (lvgs - vbin - eta * vdsat - gammad * bsarg) * dsdvgs;
    const gds = -cdrain * dldvds / clfact - beta1 * dgdvds * bodys / 1.5;
    arg1 = cdrain * (dudvbs / ufact - dldvbs / clfact);
    const gmbs = arg1 - beta1 * (gdbdvs + dgdvbs * bodys / 1.5 - factor * vdsat)
      + beta1 * (lvgs - vbin - eta * vdsat - gammad * bsarg) * dsdvbs;
    return result(cdrain, gm, gds, gmbs);
  }

  /** Terminal voltages [vgs, vds, vbs] in the polarity domain. */
  private terminalVoltages(voltage: (node: number) => number): [number, number, number] {
    const [nD, nG, nS, nB] = this.nodes;
    const type = this.model.polarity;
    const vS = voltage(nS);
    return [
      type * (voltage(nG) - vS),
      type * (voltage(nD) - vS),
      type * (voltage(nB) - vS),
    ];
  }

  limitNewtonStep(previous: Float64Array, candidate: Float64Array): number {
    if (this.operatingPointLoad) return 1;
    const read = (solution: Float64Array) => (node: number) => (node >= 0 ? solution[node] : 0);
    const [vgsOld, vdsOld] = this.terminalVoltages(read(previous));
    const [vgsNew, vdsNew] = this.terminalVoltages(read(candidate));
    const vgdOld = vgsOld - vdsOld;
    const vgdNew = vgsNew - vdsNew;
    const von = this.lastVon;
    // mos2load.c limits vgs (vgd in inverse mode) with DEVfetlim and vds with
    // DEVlimvds; spice-ts scales the whole Newton step by the tightest limit,
    // as MOS6 does.
    const gateScale = vdsOld >= 0
      ? stepScale(vgsOld, vgsNew, fetlim(vgsNew, vgsOld, von))
      : stepScale(vgdOld, vgdNew, fetlim(vgdNew, vgdOld, von));
    const drainScale = vdsOld >= 0
      ? stepScale(vdsOld, vdsNew, limvds(vdsNew, vdsOld))
      : stepScale(-vdsOld, -vdsNew, limvds(-vdsNew, -vdsOld));
    return Math.min(gateScale, drainScale);
  }

  /**
   * mos2load.c MODEINITPRED: extrapolate the first load of each timepoint,
   * retries included. The first step has only the OP, so it is unextrapolated.
   * Rotate the last-loaded terminal state, not a post-solve reevaluation.
   */
  beginTransientNewton(dt: number, _accepted: Float64Array): void {
    const accepted = this.acceptedTerminals;
    const previous = this.previousTerminals;
    const factor = previous && this.acceptedDt > 0 ? dt / this.acceptedDt : 0;
    this.predictorFactor = factor;
    this.predictedTerminals = accepted?.map((v, i) =>
      factor === 0 ? v : (1 + factor) * v - factor * previous![i],
    ) as [number, number, number] | undefined;
    // MODEINITPRED restores the junction limiting references from state1.
    if (accepted) {
      this.lastVbs = accepted[2];
      this.lastVbd = accepted[2] - accepted[1];
    }
  }

  stamp(ctx: StampContext): void {
    const predicted = this.predictedTerminals;
    this.predictedTerminals = undefined;
    if (predicted && ctx.dt > 0) {
      const [d, g, s, b] = this.nodes;
      const type = this.model.polarity;
      // A grounded non-source terminal anchors the predicted source too.
      // Otherwise its fixed zero would undo the predicted branch voltage.
      const source = s < 0 ? 0
        : b < 0 ? -type * predicted[2]
          : d < 0 ? -type * predicted[1]
            : g < 0 ? -type * predicted[0] : ctx.getVoltage(s);
      const original = ctx;
      ctx = { ...ctx, getVoltage: node => {
        if (node < 0) return 0;
        if (node === g) return source + type * predicted[0];
        if (node === d) return source + type * predicted[1];
        if (node === b) return source + type * predicted[2];
        if (node === s) return source;
        return original.getVoltage(node);
      } };
    }
    // The static and charge loads must linearise at the same first iterate.
    this.transientLoadContext = predicted && ctx.dt > 0 ? ctx : undefined;
    const type = this.model.polarity;
    const { vt, sourceVcrit, drainVcrit, sourceSatCur, drainSatCur } = this.temp;
    const gmin = ctx.gmin ?? DEVICE_GMIN;
    const [nD, nG, nS, nB] = this.nodes;
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const initializing = ctx.operatingPointPhase === 'junction';
    this.operatingPointLoad = ctx.operatingPointPhase !== undefined;
    // mos2load.c MODEINITJCT for the supported default non-OFF, zero-IC
    // instance. Model-local Vbs=-1 is not a globally consistent node seed.
    const bias = initializing
      ? [type * this.temp.tVto, 0, -1]
      : this.terminalVoltages(voltage);
    let [vgs, vds] = bias;
    const vbsRaw = bias[2];
    // mos2load.c computes vbd before gate/drain limiting. In inverse mode
    // DEVpnjlim must see this raw junction bias, not vbsRaw - limited vds.
    const vbdRaw = vbsRaw - vds;
    // DC uses ngspice's previous-load fetlim/limvds, not a scaled global
    // solution. Leave the existing transient step-limiting path unchanged.
    if (this.operatingPointLoad && !initializing) {
      const vgdRaw = vgs - vds;
      if (this.lastLoad.vds >= 0) {
        vgs = fetlim(vgs, this.lastLoad.vgs, this.lastVon);
        vds = limvds(vgs - vgdRaw, this.lastLoad.vds);
      } else {
        const vgd = fetlim(vgdRaw, this.lastLoad.vgs - this.lastLoad.vds, this.lastVon);
        vds = -limvds(-(vgs - vgd), -this.lastLoad.vds);
        vgs = vgd + vds;
      }
    }

    // mos2load.c junction limiting against the previous load.
    let vbs = vbsRaw;
    let vbd = vbdRaw;
    let limited: boolean;
    if (initializing) {
      limited = false;
    } else if (vds >= 0) {
      vbs = pnjlim(vbs, this.lastVbs, vt, sourceVcrit);
      limited = vbs !== vbsRaw;
      vbd = vbs - vds;
    } else {
      vbd = pnjlim(vbd, this.lastVbd, vt, drainVcrit);
      limited = vbd !== vbdRaw;
      vbs = vbd + vds;
    }
    this.lastVbs = vbs;
    this.lastVbd = vbd;

    let gbs: number;
    let cbs: number;
    if (vbs <= -3 * vt) {
      gbs = gmin;
      cbs = gbs * vbs - sourceSatCur;
    } else {
      const evbs = Math.exp(Math.min(MAX_EXP_ARG, vbs / vt));
      gbs = sourceSatCur * evbs / vt + gmin;
      cbs = sourceSatCur * (evbs - 1) + gmin * vbs;
    }
    let gbd: number;
    let cbd: number;
    if (vbd <= -3 * vt) {
      gbd = gmin;
      cbd = gbd * vbd - drainSatCur;
    } else {
      const evbd = Math.exp(Math.min(MAX_EXP_ARG, vbd / vt));
      gbd = drainSatCur * evbd / vt + gmin;
      cbd = drainSatCur * (evbd - 1) + gmin * vbd;
    }

    const channel = this.evaluateChannel(vgs, vds, vbs, this.lastGm, this.lastGmbs);
    this.lastVon = channel.von;
    const { mode, cdrain, gm, gds, gmbs } = channel;
    this.lastGm = gm;
    this.lastGmbs = gmbs;
    const load = this.lastLoad;
    load.vbs = vbs;
    load.vbd = vbd;
    load.vgs = vgs;
    load.vds = vds;
    load.mode = mode;
    load.cd = mode * cdrain - cbd;
    load.cbs = cbs;
    load.cbd = cbd;
    load.gm = gm;
    load.gds = gds;
    load.gmbs = gmbs;
    load.gbs = gbs;
    load.gbd = gbd;
    load.limited = limited;

    const ceqbs = type * (cbs - gbs * vbs);
    const ceqbd = type * (cbd - gbd * vbd);
    const xnrm = mode >= 0 ? 1 : 0;
    const xrev = 1 - xnrm;
    const cdreq = mode >= 0
      ? type * (cdrain - gds * vds - gm * vgs - gmbs * vbs)
      : -type * (cdrain - gds * (-vds) - gm * (vgs - vds) - gmbs * vbd);

    const g = (row: number, col: number, value: number) => {
      if (row >= 0 && col >= 0) ctx.stampG(row, col, value);
    };
    const b = (row: number, value: number) => {
      if (row >= 0) ctx.stampB(row, value);
    };
    b(nB, -(ceqbs + ceqbd));
    b(nD, ceqbd - cdreq);
    b(nS, cdreq + ceqbs);

    g(nB, nB, gbd + gbs);
    g(nD, nD, gds + gbd + xrev * (gm + gmbs));
    g(nS, nS, gds + gbs + xnrm * (gm + gmbs));
    g(nB, nD, -gbd);
    g(nB, nS, -gbs);
    g(nD, nG, (xnrm - xrev) * gm);
    g(nD, nB, -gbd + (xnrm - xrev) * gmbs);
    g(nD, nS, -gds - xnrm * (gm + gmbs));
    g(nS, nG, -(xnrm - xrev) * gm);
    g(nS, nB, -gbs - (xnrm - xrev) * gmbs);
    g(nS, nD, -gds - xrev * (gm + gmbs));
  }

  /**
   * Whether the last stamp limited a bulk junction with DEVpnjlim. As in
   * ngspice (mos2load.c Check), Newton cannot converge on such an iterate.
   */
  limitedLastStamp(): boolean {
    return this.lastLoad.limited;
  }

  /**
   * ngspice-47 mos2conv.c: the drain current and the bulk junction currents
   * predicted at the new Newton solution from the last load's linearisation
   * must match the loaded currents within RELTOL * max + ABSTOL.
   */
  convergenceTest(solution: Float64Array, tolerances: ConvergenceTolerances): boolean {
    const load = this.lastLoad;
    const [vgs, vds, vbs] = this.terminalVoltages(node => (node >= 0 ? solution[node] : 0));
    const vbd = vbs - vds;
    const vgd = vgs - vds;
    const delvbs = vbs - load.vbs;
    const delvbd = vbd - load.vbd;
    const delvgs = vgs - load.vgs;
    const delvds = vds - load.vds;
    const delvgd = vgd - (load.vgs - load.vds);
    const cdhat = load.mode >= 0
      ? load.cd - load.gbd * delvbd + load.gmbs * delvbs + load.gm * delvgs + load.gds * delvds
      : load.cd - (load.gbd - load.gmbs) * delvbd - load.gm * delvgd + load.gds * delvds;
    const { reltol, abstol } = tolerances;
    if (Math.abs(cdhat - load.cd) >= reltol * Math.max(Math.abs(cdhat), Math.abs(load.cd)) + abstol) {
      return false;
    }
    const cb = load.cbs + load.cbd;
    const cbhat = cb + load.gbd * delvbd + load.gbs * delvbs;
    return Math.abs(cbhat - cb) <= reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + abstol;
  }

  /** mos2noi.c reads the loaded gm and cd (including the drain bulk junction). */
  noiseOperatingPoint(): { gm: number; cd: number; length: number; width: number } {
    return { gm: this.lastLoad.gm, cd: this.lastLoad.cd,
      length: this.effectiveLength, width: this.instance.W };
  }

  /** Meyer half capacitances [gs, gd, gb] at the given solution. */
  private meyerHalf(voltage: (node: number) => number, out: Float64Array, bias?: [number, number, number]): void {
    const [vgs, vds, vbs] = bias ?? this.terminalVoltages(voltage);
    const channel = this.evaluateChannel(vgs, vds, vbs, this.lastGm, this.lastGmbs);
    const vgd = vgs - vds;
    const { tPhi } = this.temp;
    if (channel.mode > 0) {
      meyerHalfCapacitances(vgs, vgd, channel.von, channel.vdsat, tPhi, this.oxideCap, out);
    } else {
      meyerHalfCapacitances(vgd, vgs, channel.von, channel.vdsat, tPhi, this.oxideCap, out);
      const capgs = out[0];
      out[0] = out[1];
      out[1] = capgs;
    }
  }

  stampDynamic(ctx: StampContext): void {
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const half = halfScratch;
    this.meyerHalf(voltage, half);
    const [nD, nG, nS, nB] = this.nodes;
    stampCapacitance(ctx, nG, nS, 2 * half[0] + this.overlapGS);
    stampCapacitance(ctx, nG, nD, 2 * half[1] + this.overlapGD);
    stampCapacitance(ctx, nG, nB, 2 * half[2] + this.overlapGB);

    const { Cbs, Cbssw, Cbd, Cbdsw } = this.temp;
    if (Cbs !== 0 || Cbssw !== 0 || Cbd !== 0 || Cbdsw !== 0) {
      const [, vds, vbs] = this.terminalVoltages(voltage);
      const vbd = vbs - vds;
      stampCapacitance(ctx, nB, nS, this.depletionCapacitance(vbs, Cbs, Cbssw, this.temp.f2s, this.temp.f3s));
      stampCapacitance(ctx, nB, nD, this.depletionCapacitance(vbd, Cbd, Cbdsw, this.temp.f2d, this.temp.f3d));
    }
  }

  stampAC(ctx: StampContext, _omega: number): void {
    this.stampDynamic(ctx);
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    ctx = this.transientLoadContext ?? ctx;
    const charges = this.charges;
    const capacitances = this.capacitanceScratch;
    const junctionCharges = this.chargeScratch;
    this.evaluateCharges(ctx, capacitances, junctionCharges);
    charges.begin(integration);
    this.loadedCapacitance.set(capacitances);
    this.hasLoadedCharge = true;
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      const positive = this.nodes[p];
      const negative = this.nodes[n];
      const voltage = branchVoltage(ctx, positive, negative);
      const capacitance = capacitances[index];
      const charge = index < GATE_CHARGES
        ? this.transientLoadContext
          ? charges.predictedCharge(index, this.predictorFactor)
          : charges.incrementalCharge(index, voltage, capacitance, true)
        : junctionCharges[index];
      this.loadedCharge[index] = charge;
      this.loadedVoltage[index] = voltage;
      if (positive === negative) continue;
      if (index < GATE_CHARGES) {
        const effective = charges.factor * charges.incrementalCapacitance(index, capacitance, true);
        stampChargeBranch(ctx, positive, negative, charges.current(index, charge), effective, voltage);
      } else {
        const current = charges.current(index, junctionCharges[index]);
        const conductance = charges.factor * capacitance;
        stampChargeBranch(ctx, positive, negative, current, conductance, voltage);
        this.foldJunctionChargeCurrent(index, current, conductance);
      }
    }
  }

  /**
   * mos2load.c folds the bulk junction charge currents into the junction
   * currents the convergence test reads: cbd += cqbd, cd -= cqbd, gbd += geq
   * (and cbs, gbs for the source junction). `current` is node-domain.
   */
  private foldJunctionChargeCurrent(index: number, current: number, conductance: number): void {
    const load = this.lastLoad;
    const deviceCurrent = this.model.polarity * current;
    if (index === BULK_SOURCE) {
      load.cbs += deviceCurrent;
      load.gbs += conductance;
    } else {
      load.cbd += deviceCurrent;
      load.cd -= deviceCurrent;
      load.gbd += conductance;
    }
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      if (this.nodes[p] === this.nodes[n]) continue;
      stampChargeCurrent(ctx, this.nodes[p], this.nodes[n], this.charges.acceptedChargeCurrent(index));
    }
  }

  /** OPtran MODEINITTRAN copies terminal state from the last DC load, not rhsOld. */
  initializeTransientOperatingPoint(ctx: StampContext, transientOperatingPoint: boolean): void {
    const { vgs, vds, vbs } = this.lastLoad;
    const type = this.model.polarity;
    this.resetTransient();
    const voltages = [type * vgs, type * (vgs - vds), type * (vgs - vbs), type * vbs, type * (vbs - vds)];
    const capacitances = this.capacitanceScratch;
    const junctionCharges = this.chargeScratch;
    capacitances.fill(0);
    junctionCharges.fill(0);
    if (transientOperatingPoint) {
      // DC junction initialization can be model-local (e.g. Vbs=-1 with
      // bulk tied to source). Do not try to encode it in a global node vector.
      this.evaluateCharges(ctx, capacitances, junctionCharges, [vgs, vds, vbs]);
    }
    // MODEDCOP loads no charges/capacitances; MODETRANOP loads C*V and Qj.
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const charge = index < GATE_CHARGES ? capacitances[index] * voltages[index] : junctionCharges[index];
      this.charges.accept(index, charge, voltages[index], capacitances[index]);
    }
    this.charges.commit();
    this.acceptedTerminals = [vgs, vds, vbs];
  }

  acceptTransientStep(ctx: StampContext): void {
    this.acceptCharges(ctx);
    this.previousTerminals = this.acceptedTerminals;
    this.acceptedTerminals = ctx.dt > 0
      ? [this.lastLoad.vgs, this.lastLoad.vds, this.lastLoad.vbs]
      : this.terminalVoltages(node => node >= 0 ? ctx.getVoltage(node) : 0);
    this.acceptedDt = ctx.dt;
  }

  private acceptCharges(ctx: StampContext): void {
    if (this.hasLoadedCharge) {
      // NIiter returns without a final load. Keep its q, voltage and Meyer C
      // together when rotating state0 to state1, including the truncation trial.
      for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
        this.charges.accept(index, this.loadedCharge[index], this.loadedVoltage[index], this.loadedCapacitance[index]);
      }
      this.charges.commit();
      return;
    }
    const charges = this.charges;
    const capacitances = this.capacitanceScratch;
    const junctionCharges = this.chargeScratch;
    this.evaluateCharges(ctx, capacitances, junctionCharges);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      const voltage = branchVoltage(ctx, this.nodes[p], this.nodes[n]);
      const capacitance = capacitances[index];
      const charge = index < GATE_CHARGES
        ? charges.incrementalCharge(index, voltage, capacitance, true)
        : junctionCharges[index];
      charges.accept(index, charge, voltage, capacitance);
    }
    charges.commit();
  }

  /** ngspice MOS2trunc: CKTterr on the three Meyer gate charges. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptCharges(ctx), TRUNCATED_CHARGES);
  }

  resetTransient(): void {
    this.charges.reset();
    this.acceptedTerminals = undefined;
    this.previousTerminals = undefined;
    this.acceptedDt = 0;
    this.predictedTerminals = undefined;
    this.transientLoadContext = undefined;
    this.hasLoadedCharge = false;
  }

  /**
   * Node-domain capacitances of every charge at the present solution, and the
   * exact bulk-junction charges (mos2load.c qbs/qbd, scaled by the polarity so
   * q and C refer to the node-domain branch voltage). The gate entries are the
   * full Meyer capacitance 2 * half + overlap; TransientChargeState averages
   * it with the accepted value, which yields mos2load.c's
   * capgs = half(n+1) + half(n) + overlap.
   */
  private evaluateCharges(ctx: StampContext, capacitances: Float64Array, junctionCharges: Float64Array, bias?: [number, number, number]): void {
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const half = halfScratch;
    this.meyerHalf(voltage, half, bias);
    capacitances[GATE_SOURCE] = 2 * half[0] + this.overlapGS;
    capacitances[GATE_DRAIN] = 2 * half[1] + this.overlapGD;
    capacitances[GATE_BULK] = 2 * half[2] + this.overlapGB;
    const type = this.model.polarity;
    const [, vds, vbs] = bias ?? this.terminalVoltages(voltage);
    const vbd = vbs - vds;
    const { Cbs, Cbssw, Cbd, Cbdsw, f2s, f3s, f4s, f2d, f3d, f4d } = this.temp;
    capacitances[BULK_SOURCE] = this.depletionCapacitance(vbs, Cbs, Cbssw, f2s, f3s);
    capacitances[BULK_DRAIN] = this.depletionCapacitance(vbd, Cbd, Cbdsw, f2d, f3d);
    junctionCharges[BULK_SOURCE] = type * this.depletionCharge(vbs, Cbs, Cbssw, f2s, f3s, f4s);
    junctionCharges[BULK_DRAIN] = type * this.depletionCharge(vbd, Cbd, Cbdsw, f2d, f3d, f4d);
  }

  /** mos2load.c (1-v/pb)^-MJ and (1-v/pb)^-MJSW, with its sqrt fast path for 0.5. */
  private gradingFactors(arg: number): [number, number] {
    const { MJ, MJSW } = this.model;
    const sarg = MJ === 0.5 ? 1 / Math.sqrt(arg) : Math.exp(-MJ * Math.log(arg));
    const sargsw = MJSW === 0.5 ? 1 / Math.sqrt(arg) : Math.exp(-MJSW * Math.log(arg));
    return [sarg, sargsw];
  }

  /** mos2load.c bulk junction depletion charge (MOS2qbs / MOS2qbd). */
  private depletionCharge(
    voltage: number, bottom: number, sidewall: number, f2: number, f3: number, f4: number,
  ): number {
    if (bottom === 0 && sidewall === 0) return 0;
    const { tDepCap, tBulkPot } = this.temp;
    if (voltage < tDepCap) {
      const arg = 1 - voltage / tBulkPot;
      const [sarg, sargsw] = this.gradingFactors(arg);
      return tBulkPot * (bottom * (1 - arg * sarg) / (1 - this.model.MJ)
        + sidewall * (1 - arg * sargsw) / (1 - this.model.MJSW));
    }
    return f4 + voltage * (f2 + voltage * (f3 / 2));
  }

  /** mos2load.c bulk junction depletion capacitance (MOS2capbs / MOS2capbd). */
  private depletionCapacitance(voltage: number, bottom: number, sidewall: number, f2: number, f3: number): number {
    if (bottom === 0 && sidewall === 0) return 0;
    const { tDepCap, tBulkPot } = this.temp;
    if (voltage < tDepCap) {
      const arg = 1 - voltage / tBulkPot;
      const [sarg, sargsw] = this.gradingFactors(arg);
      return bottom * sarg + sidewall * sargsw;
    }
    return f2 + f3 * voltage;
  }
}
