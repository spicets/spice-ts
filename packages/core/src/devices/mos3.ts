import {
  DEVICE_GMIN, type ChargeIntegration, type ChargeTruncation, type ConvergenceTolerances, type DeviceModel,
  type StampContext,
} from './device.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';
import {
  branchVoltage, meyerHalfCapacitances, stampCapacitance,
} from './mos6.js';
import { fetlim, limvds, pnjlim, stepScale } from './devsup.js';
import { InvalidCircuitError, UnsupportedTemperatureError } from '../errors.js';

/**
 * MOSFET level 3 (semi-empirical short-channel model) and level 9 (ngspice
 * MOS9, Alan Gillespie's modified level 3), ported from ngspice-47
 * src/spicelib/devices/mos3 and mos9: mos3set.c defaults, mos3temp.c
 * temperature and parameter preprocessing, mos3load.c moseq3 drain current,
 * bulk junctions, limiting and charges, mos3conv.c convergence test and
 * mos3trun.c truncation, plus devsup.c DEVqmeyer for the Meyer gate
 * capacitances.
 *
 * mos9load.c/mos9temp.c are mos3load.c/mos3temp.c with exactly two
 * differences, selected by {@link MOS3ModelParams.level}:
 * - mos9temp.c rejects an effective length or width below 1e-6 m (mos3temp.c:
 *   not positive);
 * - mos9load.c divides by `argb` in the velocity-saturated channel-length
 *   modulation without the `argb != 0` guard of mos3load.c.
 *
 * As in mos3load.c the multiplier M is folded into the saturation currents,
 * Beta, the oxide capacitance, the overlap capacitances and the zero-bias
 * junction capacitances; the junction GMIN is not scaled by M. The
 * drain/source series resistances (RD, RS, or RSH with NRD/NRS) are linear
 * conductances M/R between the external and the prime nodes; the circuit
 * expands them into resistors ({@link mos3SeriesResistances}).
 *
 * Not ported: CKTbadMos3 (`.options badmos3`, default off), sensitivity and
 * the ngspice bypass (spice-ts never bypasses a device load).
 */

// ngspice const.h
const CHARGE = 1.6021766208e-19;
const CONSTBOLTZ = 1.38064852e-23;
const CONSTKOVERQ = CONSTBOLTZ / CHARGE;
const CONSTCTOK = 273.15;
const REFTEMP = 27 + CONSTCTOK;
const CONSTROOT2 = Math.SQRT2;
const CONSTE = Math.exp(1);
const MAX_EXP_ARG = 709;
// ngspice CKTdefaultMosL / CKTdefaultMosW.
const DEFAULT_MOS_LENGTH = 100e-6;
const DEFAULT_MOS_WIDTH = 100e-6;
/** mos3defs.h EPSSIL. */
const EPSSIL = 11.7 * 8.854214871e-12;
const EPS_OX = 3.9 * 8.854214871e-12;
/** mos3load.c moseq3 short-channel coefficients. */
const COEFF0 = 0.0631353e0;
const COEFF1 = 0.8013292e0;
const COEFF2 = -0.01110777e0;

/** Resolved MOS3/MOS9 model card after mos3set.c defaulting and mos3temp.c model preprocessing. */
export interface MOS3ModelParams {
  /** mos3noi.c selectors; mos9noi.c always uses the legacy current-based form. */
  KF: number;
  AF: number;
  NLEV: number;
  /** 3 (ngspice mos3) or 9 (ngspice mos9). */
  level: 3 | 9;
  polarity: number;
  VTO: number;
  KP: number;
  GAMMA: number;
  PHI: number;
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
  XL: number;
  WD: number;
  XW: number;
  DELVTO: number;
  U0: number;
  VMAX: number;
  XJ: number;
  NFS: number;
  ETA: number;
  THETA: number;
  KAPPA: number;
  TNOM: number;
  /** First supplied field outside the ported DC/charge parameter surface. */
  unsupportedTemperatureParameter?: string;
  /** mos3temp.c MOS3oxideCapFactor = EPS_OX / TOX (TOX defaults to 1e-7 m). */
  oxideCapFactor: number;
  /** mos3temp.c MOS3alpha = 2 EPSSIL / (q NSUB) (0 without NSUB). */
  alpha: number;
  /** mos3temp.c MOS3coeffDepLayWidth = sqrt(alpha). */
  coeffDepLayWidth: number;
  /** mos3temp.c MOS3narrowFactor = DELTA * pi/2 * EPSSIL / Cox'. */
  narrowFactor: number;
  given: {
    CBD: boolean;
    CBS: boolean;
    CJ: boolean;
    CJSW: boolean;
  };
}

export interface MOS3InstanceParams {
  W: number;
  L: number;
  M: number;
  AD: number;
  AS: number;
  PD: number;
  PS: number;
  /** Instance TEMP/DTEMP overrides are not part of the validated circuit-temperature surface. */
  TEMP?: number;
  DTEMP?: number;
}

/** Temperature-dependent instance quantities (mos3temp.c), M included. */
interface MOS3TemperatureState {
  vt: number;
  tTransconductance: number;
  tSurfMob: number;
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

function given(params: Readonly<Record<string, number | undefined>>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = params[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Apply mos3set.c defaults and the model-level part of mos3temp.c (identical
 * in mos9). Throws the same fatal model errors ngspice reports (non-positive
 * PHI, NSUB below the intrinsic density at TNOM).
 */
export function resolveMOS3Model(
  name: string,
  params: Readonly<Record<string, number | undefined>>,
  polarity: number,
  level: 3 | 9 = 3,
): MOS3ModelParams {
  const tnom = (params.TNOM ?? 27) + CONSTCTOK;
  const vtnom = tnom * CONSTKOVERQ;
  const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
  let nifact = (tnom / 300) * Math.sqrt(tnom / 300);
  nifact *= Math.exp(0.5 * egfet1 * ((1 / 300) - (1 / tnom)) / CONSTKOVERQ);
  const niTemp = 1.45e16 * nifact;

  let phi = params.PHI ?? 0.6;
  let gamma = params.GAMMA ?? 0;
  let vto = given(params, 'VTO', 'VT0') ?? 0;
  if (phi <= 0) {
    throw new InvalidCircuitError(`MOSFET level ${level} model '${name}': Phi is not positive`);
  }

  const tox = params.TOX ?? 1e-7;
  const oxideCapFactor = EPS_OX / tox;
  const mobility = given(params, 'U0', 'UO') ?? 600;
  const kp = params.KP ?? mobility * oxideCapFactor * 1e-4;

  let alpha = 0;
  let coeffDepLayWidth = 0;
  if (params.NSUB !== undefined) {
    const nsub = params.NSUB;
    if (nsub * 1e6 > niTemp) {
      if (params.PHI === undefined) {
        phi = 2 * vtnom * Math.log(nsub * 1e6 / niTemp);
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
        gamma = Math.sqrt(2 * EPSSIL * CHARGE * nsub * 1e6) / oxideCapFactor;
      }
      if (given(params, 'VTO', 'VT0') === undefined) {
        const nss = params.NSS ?? 0;
        const vfb = wkfngs - nss * 1e4 * CHARGE / oxideCapFactor;
        vto = vfb + polarity * (gamma * Math.sqrt(phi) + phi);
      }
      alpha = (EPSSIL + EPSSIL) / (CHARGE * nsub * 1e6);
      coeffDepLayWidth = Math.sqrt(alpha);
    } else {
      throw new InvalidCircuitError(`MOSFET level ${level} model '${name}': Nsub < Ni`);
    }
  }

  const delta = params.DELTA ?? 0;
  // ngspice-47 mos3.c:114-157, mos3temp.c:41-114,214-339.
  // No extra UTE/XTI/TCV/TRD laws are part of MOS3. Do not silently accept
  // dialect extensions or unported fields when enabling circuit temperature.
  const temperatureParameters = new Set([
    'LEVEL', 'VTO', 'VT0', 'KP', 'GAMMA', 'PHI', 'RD', 'RS', 'CBD', 'CBS',
    'IS', 'PB', 'CGSO', 'CGDO', 'CGBO', 'RSH', 'CJ', 'MJ', 'CJSW', 'MJSW',
    'JS', 'TOX', 'LD', 'XL', 'WD', 'XW', 'DELVTO', 'DELVT0', 'U0', 'UO',
    'FC', 'NSUB', 'TPG', 'NSS', 'VMAX', 'XJ', 'NFS', 'ETA', 'DELTA',
    'THETA', 'KAPPA', 'TNOM', 'KF', 'AF', 'NLEV',
  ]);
  return {
    level,
    polarity,
    VTO: vto,
    KP: kp,
    GAMMA: gamma,
    PHI: phi,
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
    XL: params.XL ?? 0,
    WD: params.WD ?? 0,
    XW: params.XW ?? 0,
    DELVTO: given(params, 'DELVTO', 'DELVT0') ?? 0,
    U0: mobility,
    VMAX: params.VMAX ?? 0,
    XJ: params.XJ ?? 0,
    NFS: params.NFS ?? 0,
    ETA: params.ETA ?? 0,
    THETA: params.THETA ?? 0,
    KAPPA: params.KAPPA ?? 0.2,
    TNOM: tnom,
    KF: params.KF ?? 0,
    AF: params.AF ?? 1,
    NLEV: params.NLEV ?? 2,
    unsupportedTemperatureParameter: Object.keys(params).find(key => params[key] !== undefined
      && !temperatureParameters.has(key)),
    oxideCapFactor,
    alpha,
    coeffDepLayWidth,
    narrowFactor: delta * 0.5 * Math.PI * EPSSIL / oxideCapFactor,
    given: {
      CBD: params.CBD !== undefined,
      CBS: params.CBS !== undefined,
      CJ: params.CJ !== undefined,
      CJSW: params.CJSW !== undefined,
    },
  };
}

/**
 * mos3temp.c drain/source series resistances (ohms) for one instance: RD/RS
 * when given (0 means none), otherwise RSH * NRD / RSH * NRS (NRD/NRS default
 * 1), divided by M. 0 means no series resistance (no prime node).
 */
export function mos3SeriesResistances(
  model: Readonly<Record<string, number | undefined>>,
  instance: Readonly<Record<string, number | undefined>> | undefined,
): { drain: number; source: number } {
  const m = instance?.M ?? 1;
  const resistance = (direct: number | undefined, squares: number): number => {
    if (direct !== undefined) return direct !== 0 ? direct / m : 0;
    const sheet = model.RSH;
    if (sheet !== undefined && sheet !== 0 && squares !== 0) return sheet * squares / m;
    return 0;
  };
  return {
    drain: resistance(model.RD, instance?.NRD ?? 1),
    source: resistance(model.RS, instance?.NRS ?? 1),
  };
}

/** moseq3 result (polarity domain, source/drain swapped by mode). */
export interface MOS3Channel {
  /** +1 normal mode (vds >= 0), -1 inverse mode. */
  mode: number;
  cdrain: number;
  gm: number;
  gds: number;
  gmbs: number;
  von: number;
  vdsat: number;
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
/** mos3trun.c truncates the three Meyer gate charges only, not the bulk junctions. */
const TRUNCATED_CHARGES: readonly number[] = [GATE_SOURCE, GATE_DRAIN, GATE_BULK];
/** Terminal indices (D, G, S, B) of each charge, positive then negative, in charge-index order. */
const CHARGE_BRANCHES: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [1, 0], [1, 3], [3, 2], [3, 0],
];

/**
 * The linearisation of the last load, as ngspice-47 keeps it in CKTstate0 and
 * the instance struct (M included): the junction and terminal voltages it was
 * evaluated at and the drain and bulk currents with their conductances,
 * transient junction charge currents folded in.
 */
interface MOS3Load {
  vbs: number;
  vbd: number;
  vgs: number;
  vds: number;
  mode: number;
  /** MOS3cd = mode * cdrain - cbd (minus cqbd in transient). */
  cd: number;
  cbs: number;
  cbd: number;
  gm: number;
  gds: number;
  gmbs: number;
  gbs: number;
  gbd: number;
  /** mos3load.c Check: DEVpnjlim limited a junction (CKTnoncon). */
  limited: boolean;
}

export class MOS3 implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (MOS3trunc: qgs, qgd, qgb). */
  readonly truncationCoversCharges = true;
  readonly model: MOS3ModelParams;
  readonly instance: MOS3InstanceParams;
  private readonly effectiveLength: number;
  private readonly effectiveWidth: number;
  /** mos3load.c OxideCap (with M). */
  private readonly oxideCap: number;
  private readonly overlapGS: number;
  private readonly overlapGD: number;
  private readonly overlapGB: number;
  private temperature = 27;
  private temp!: MOS3TemperatureState;
  /** Beta = tKP * M * Weff / Leff (mos3load.c). */
  private beta = 0;
  /** ngspice CKTstate0 vbs/vbd and MOS3von of the previous load. */
  private lastVbs = 0;
  private lastVbd = 0;
  private lastVon = 0;
  private readonly lastLoad: MOS3Load = {
    vbs: 0, vbd: 0, vgs: 0, vds: 0, mode: 1, cd: 0, cbs: 0, cbd: 0, gm: 0, gds: 0, gmbs: 0, gbs: 0, gbd: 0,
    limited: false,
  };
  /** Transient gate and bulk-junction charges (ngspice MOS3qgs..MOS3qbd), integrated by the device. */
  readonly integratesTransientCharge = true;
  readonly storesCharge: boolean;
  private readonly charges = new TransientChargeState(CHARGE_BRANCHES.length);
  private readonly chargeScratch = new Float64Array(CHARGE_BRANCHES.length);
  private readonly capacitanceScratch = new Float64Array(CHARGE_BRANCHES.length);

  constructor(
    readonly name: string,
    /** [drain', gate, source', bulk] */
    readonly nodes: number[],
    model: MOS3ModelParams,
    instance: Partial<MOS3InstanceParams>,
  ) {
    this.model = model;
    // Do not silently replace ngspice's mos3temp.c:131-137 instance overrides
    // with CKTtemp. Fail closed until these inputs have an identical-byte oracle.
    for (const parameter of ['TEMP', 'DTEMP'] as const) {
      if (instance[parameter] !== undefined) {
        throw new UnsupportedTemperatureError(name, instance.TEMP ?? 27 + (instance.DTEMP ?? 0), parameter);
      }
    }
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
    this.effectiveLength = L - 2 * model.LD + model.XL;
    this.effectiveWidth = W - 2 * model.WD + model.XW;
    // mos3temp.c rejects a non-positive effective size; mos9temp.c anything below 1 um.
    const minimum = model.level === 9 ? 1e-6 : 0;
    const tooSmall = (size: number) => (model.level === 9 ? size < minimum : size <= minimum);
    if (tooSmall(this.effectiveLength)) {
      throw new InvalidCircuitError(`${name}: effective channel length less than zero`);
    }
    if (tooSmall(this.effectiveWidth)) {
      throw new InvalidCircuitError(`${name}: effective channel width less than zero`);
    }
    const leff = this.effectiveLength;
    const weff = this.effectiveWidth;
    this.oxideCap = model.oxideCapFactor * leff * M * weff;
    this.overlapGS = model.CGSO * M * weff;
    this.overlapGD = model.CGDO * M * weff;
    this.overlapGB = model.CGBO * M * leff;
    this.applyTemperature();
    this.lastVon = this.temp.tVto * model.polarity;
    const { Cbs, Cbssw, Cbd, Cbdsw } = this.temp;
    this.storesCharge = [this.oxideCap, this.overlapGS, this.overlapGD, this.overlapGB, Cbs, Cbssw, Cbd, Cbdsw]
      .some(value => value !== 0);
  }

  setTemperature(value: number): void {
    // LEVEL=9 remains outside this validation slice, including direct hooks
    // used by .dc/.step TEMP (not just the circuit compilation guard).
    if (this.model.level !== 3 && value !== 27) throw new UnsupportedTemperatureError(this.name, value);
    if (value !== this.model.TNOM - CONSTCTOK && this.model.unsupportedTemperatureParameter !== undefined) {
      throw new UnsupportedTemperatureError(this.name, value, this.model.unsupportedTemperatureParameter);
    }
    this.temperature = value;
    this.applyTemperature();
  }

  getTemperature(): number {
    return this.temperature;
  }

  /**
   * ngspice-47 mos3temp.c:44-50 (nominal factors),131-145 (instance factors),
   * 214-251 (KP/U0, PHI/VTO, IS/JS and junction capacitance laws),253-339
   * (Vcrit and depletion coefficients). These equations were already ported;
   * #1057 validates and enables their use beyond the circuit's 27 C default.
   * Source: https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/mos3/mos3temp.c
   */
  private applyTemperature(): void {
    const model = this.model;
    const { M, AD, AS, PD, PS } = this.instance;
    const tnom = model.TNOM;
    const fact1 = tnom / REFTEMP;
    const vtnom = tnom * CONSTKOVERQ;
    const kt1 = CONSTBOLTZ * tnom;
    const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
    const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTBOLTZ * (REFTEMP + REFTEMP));
    const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);

    const temp = this.temperature + CONSTCTOK;
    const vt = temp * CONSTKOVERQ;
    const ratio = temp / tnom;
    const fact2 = temp / REFTEMP;
    const kt = temp * CONSTBOLTZ;
    const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
    const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTBOLTZ * (REFTEMP + REFTEMP));
    const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);

    const ratio4 = ratio * Math.sqrt(ratio);
    const tTransconductance = model.KP / ratio4;
    const tSurfMob = model.U0 / ratio4;
    const phio = (model.PHI - pbfact1) / fact1;
    const tPhi = fact2 * phio + pbfact;
    const type = model.polarity;
    const tVbi = model.DELVTO + model.VTO - type * (model.GAMMA * Math.sqrt(model.PHI))
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

    // mos3temp.c tests JS (the model value) for Vcrit, mos3load.c tSatCurDens
    // for the saturation currents; both are zero together.
    const useDensity = !(tSatCurDens === 0 || AD === 0 || AS === 0);
    let drainVcrit: number;
    let sourceVcrit: number;
    if (!useDensity) {
      drainVcrit = sourceVcrit = vt * Math.log(vt / (CONSTROOT2 * M * tSatCur));
    } else {
      drainVcrit = vt * Math.log(vt / (CONSTROOT2 * M * tSatCurDens * AD));
      sourceVcrit = vt * Math.log(vt / (CONSTROOT2 * M * tSatCurDens * AS));
    }
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

    this.beta = tTransconductance * M * this.effectiveWidth / this.effectiveLength;
    this.temp = {
      vt, tTransconductance, tSurfMob, tPhi, tVbi, tVto, tBulkPot, tDepCap,
      drainSatCur, sourceSatCur, drainVcrit, sourceVcrit,
      Cbd: czbd, Cbdsw: czbdsw, Cbs: czbs, Cbssw: czbssw,
      f2d: drain.f2, f3d: drain.f3, f4d: drain.f4,
      f2s: source.f2, f3s: source.f3, f4s: source.f4,
    };
  }

  /**
   * mos3load.c moseq3 block: drain current and derivatives in the polarity
   * domain for terminal voltages vgs, vds, vbs (polarity domain, unswapped).
   */
  evaluateChannel(vgs: number, vds: number, vbs: number): MOS3Channel {
    const model = this.model;
    // mos3load.c:111,152-154,567-575,615,626-638,657,1081-1087 consume
    // instance vt, tKP, tPhi, tVbi, tSurfMob, never the nominal model values.
    const { tPhi, tVbi, tSurfMob, vt } = this.temp;
    const leff = this.effectiveLength;
    const weff = this.effectiveWidth;
    const mode = vds >= 0 ? 1 : -1;
    const vbd = vbs - vds;
    const vgd = vgs - vds;
    const lvbs = mode === 1 ? vbs : vbd;
    const lvgs = mode === 1 ? vgs : vgd;
    const lvds = mode * vds;
    let beta = this.beta;
    let cdrain: number;
    let gm: number;
    let gds: number;
    let gmbs: number;
    let vdsat = 0.0;
    const oneoverxl = 1.0 / leff;
    const eta = model.ETA * 8.15e-22 / (model.oxideCapFactor * leff * leff * leff);

    // Square root term.
    let phibs: number;
    let sqphbs: number;
    let dsqdvb: number;
    if (lvbs <= 0.0) {
      phibs = tPhi - lvbs;
      sqphbs = Math.sqrt(phibs);
      dsqdvb = -0.5 / sqphbs;
    } else {
      const sqphis = Math.sqrt(tPhi);
      const sqphs3 = tPhi * sqphis;
      sqphbs = sqphis / (1.0 + lvbs / (tPhi + tPhi));
      phibs = sqphbs * sqphbs;
      dsqdvb = -phibs / (sqphs3 + sqphs3);
    }
    // Short channel effect factor.
    let fshort: number;
    let dfsdvb: number;
    if (model.XJ !== 0.0 && model.coeffDepLayWidth !== 0.0) {
      const wps = model.coeffDepLayWidth * sqphbs;
      const oneoverxj = 1.0 / model.XJ;
      const xjonxl = model.XJ * oneoverxl;
      const djonxj = model.LD * oneoverxj;
      const wponxj = wps * oneoverxj;
      const wconxj = COEFF0 + COEFF1 * wponxj + COEFF2 * wponxj * wponxj;
      const arga = wconxj + djonxj;
      const argc = wponxj / (1.0 + wponxj);
      const argb = Math.sqrt(1.0 - argc * argc);
      fshort = 1.0 - xjonxl * (arga * argb - djonxj);
      const dwpdvb = model.coeffDepLayWidth * dsqdvb;
      const dadvb = (COEFF1 + COEFF2 * (wponxj + wponxj)) * dwpdvb * oneoverxj;
      const dbdvb = -argc * argc * (1.0 - argc) * dwpdvb / (argb * wps);
      dfsdvb = -xjonxl * (dadvb * argb + arga * dbdvb);
    } else {
      fshort = 1.0;
      dfsdvb = 0.0;
    }
    // Body effect.
    const gammas = model.GAMMA * fshort;
    const fbodys = 0.5 * gammas / (sqphbs + sqphbs);
    const fbody = fbodys + model.narrowFactor / weff;
    const onfbdy = 1.0 / (1.0 + fbody);
    const dfbdvb = -fbodys * dsqdvb / sqphbs + fbodys * dfsdvb / fshort;
    const qbonco = gammas * sqphbs + model.narrowFactor * phibs / weff;
    const dqbdvb = gammas * dsqdvb + model.GAMMA * dfsdvb * sqphbs - model.narrowFactor / weff;
    // Static feedback effect.
    const vbix = tVbi * model.polarity - eta * lvds;
    // Threshold voltage.
    const vth = vbix + qbonco;
    const dvtdvd = -eta;
    const dvtdvb = dqbdvb;
    // Joint weak inversion and strong inversion.
    let von = vth;
    let xn = 0.0;
    let dxndvb = 0.0;
    let dvodvd = 0.0;
    let dvodvb = 0.0;
    if (model.NFS !== 0.0) {
      const csonco = CHARGE * model.NFS * 1e4 * leff * weff * this.instance.M / this.oxideCap;
      const cdonco = qbonco / (phibs + phibs);
      xn = 1.0 + csonco + cdonco;
      von = vth + vt * xn;
      dxndvb = dqbdvb / (phibs + phibs) - qbonco * dsqdvb / (phibs * sqphbs);
      dvodvd = dvtdvd;
      dvodvb = dvtdvb + vt * dxndvb;
    } else if (lvgs <= von) {
      // Cutoff region.
      return { mode, cdrain: 0, gm: 0, gds: 0, gmbs: 0, von, vdsat };
    }
    // Device is on.
    const vgsx = Math.max(lvgs, von);
    // Mobility modulation by gate voltage.
    const onfg = 1.0 + model.THETA * (vgsx - vth);
    const fgate = 1.0 / onfg;
    const us = tSurfMob * 1e-4 * fgate;
    const dfgdvg = -model.THETA * fgate * fgate;
    const dfgdvd = -dfgdvg * dvtdvd;
    const dfgdvb = -dfgdvg * dvtdvb;
    // Saturation voltage.
    vdsat = (vgsx - vth) * onfbdy;
    let dvsdvg: number;
    let dvsdvd: number;
    let dvsdvb: number;
    let onvdsc = 0.0;
    if (model.VMAX <= 0.0) {
      dvsdvg = onfbdy;
      dvsdvd = -dvsdvg * dvtdvd;
      dvsdvb = -dvsdvg * dvtdvb - vdsat * dfbdvb * onfbdy;
    } else {
      const vdsc = leff * model.VMAX / us;
      onvdsc = 1.0 / vdsc;
      const arga = (vgsx - vth) * onfbdy;
      const argb = Math.sqrt(arga * arga + vdsc * vdsc);
      vdsat = arga + vdsc - argb;
      const dvsdga = (1.0 - arga / argb) * onfbdy;
      dvsdvg = dvsdga - (1.0 - vdsc / argb) * vdsc * dfgdvg * onfg;
      dvsdvd = -dvsdvg * dvtdvd;
      dvsdvb = -dvsdvg * dvtdvb - arga * dvsdga * dfbdvb;
    }
    // Current factors in linear region.
    const vdsx = Math.min(lvds, vdsat);
    if (vdsx === 0.0) {
      // line900: special case of vds = 0.
      beta *= fgate;
      gds = beta * (vgsx - vth);
      if (model.NFS !== 0.0 && lvgs < von) {
        gds *= Math.exp((lvgs - von) / (vt * xn));
      }
      return { mode, cdrain: 0, gm: 0, gds, gmbs: 0, von, vdsat };
    }
    const cdo = vgsx - vth - 0.5 * (1.0 + fbody) * vdsx;
    const dcodvb = -dvtdvb - 0.5 * dfbdvb * vdsx;
    // Normalized drain current.
    const cdnorm = cdo * vdsx;
    gm = vdsx;
    if (lvds > vdsat) gds = -dvtdvd * vdsx;
    else gds = vgsx - vth - (1.0 + fbody + dvtdvd) * vdsx;
    gmbs = dcodvb * vdsx;
    // Drain current without velocity saturation effect.
    let cd1 = beta * cdnorm;
    beta *= fgate;
    cdrain = beta * cdnorm;
    gm = beta * gm + dfgdvg * cd1;
    gds = beta * gds + dfgdvd * cd1;
    gmbs = beta * gmbs + dfgdvb * cd1;
    // Velocity saturation factor.
    let fdrain = 0.0;
    let dfddvg = 0.0;
    let dfddvd = 0.0;
    let dfddvb = 0.0;
    if (model.VMAX > 0.0) {
      fdrain = 1.0 / (1.0 + vdsx * onvdsc);
      const fd2 = fdrain * fdrain;
      const arga = fd2 * vdsx * onvdsc * onfg;
      dfddvg = -dfgdvg * arga;
      if (lvds > vdsat) dfddvd = -dfgdvd * arga;
      else dfddvd = -dfgdvd * arga - fd2 * onvdsc;
      dfddvb = -dfgdvb * arga;
      // Drain current.
      gm = fdrain * gm + dfddvg * cdrain;
      gds = fdrain * gds + dfddvd * cdrain;
      gmbs = fdrain * gmbs + dfddvb * cdrain;
      cdrain = fdrain * cdrain;
      beta *= fdrain;
    }

    // Channel length modulation (skipped to line700 when it does not apply).
    let gds0 = 0.0;
    let delxl = 0.0;
    let dldvd = 0.0;
    let ddldvg = 0.0;
    let ddldvd = 0.0;
    let ddldvb = 0.0;
    let modulate = true;
    if (lvds <= vdsat) {
      if (model.VMAX > 0.0 || model.alpha === 0.0) {
        modulate = false;
      } else {
        let arga = lvds / vdsat;
        delxl = Math.sqrt(model.KAPPA * model.alpha * vdsat / 8);
        dldvd = 4 * delxl * arga * arga * arga / vdsat;
        arga *= arga;
        arga *= arga;
        delxl *= arga;
        ddldvg = 0.0;
        ddldvd = -dldvd;
        ddldvb = 0.0;
      }
    } else if (model.VMAX <= 0.0) {
      // line510
      delxl = Math.sqrt(model.KAPPA * model.alpha * (lvds - vdsat + (vdsat / 8)));
      dldvd = 0.5 * delxl / (lvds - vdsat + (vdsat / 8));
      ddldvg = 0.0;
      ddldvd = -dldvd;
      ddldvb = 0.0;
    } else if (model.alpha === 0.0) {
      modulate = false;
    } else {
      const cdsat = cdrain;
      let gdsat = cdsat * (1.0 - fdrain) * onvdsc;
      gdsat = Math.max(1.0e-12, gdsat);
      const gdoncd = gdsat / cdsat;
      const gdonfd = gdsat / (1.0 - fdrain);
      const gdonfg = gdsat * onfg;
      const dgdvg = gdoncd * gm - gdonfd * dfddvg + gdonfg * dfgdvg;
      const dgdvd = gdoncd * gds - gdonfd * dfddvd + gdonfg * dfgdvd;
      const dgdvb = gdoncd * gmbs - gdonfd * dfddvb + gdonfg * dfgdvb;
      const emax = model.KAPPA * cdsat * oneoverxl / gdsat;
      const emoncd = emax / cdsat;
      const emongd = emax / gdsat;
      const demdvg = emoncd * gm - emongd * dgdvg;
      const demdvd = emoncd * gds - emongd * dgdvd;
      const demdvb = emoncd * gmbs - emongd * dgdvb;
      const arga = 0.5 * emax * model.alpha;
      const argc = model.KAPPA * model.alpha;
      const argb = Math.sqrt(arga * arga + argc * (lvds - vdsat));
      delxl = argb - arga;
      let dldem: number;
      if (argb !== 0.0 || model.level === 9) {
        // mos9load.c has no argb != 0 guard.
        dldvd = argc / (argb + argb);
        dldem = 0.5 * (arga / argb - 1.0) * model.alpha;
      } else {
        dldvd = 0.0;
        dldem = 0.0;
      }
      ddldvg = dldem * demdvg;
      ddldvd = dldem * demdvd - dldvd;
      ddldvb = dldem * demdvb;
    }
    if (modulate) {
      // line520: punch through approximation.
      if (delxl > (0.5 * leff)) {
        delxl = leff - (leff * leff / (4.0 * delxl));
        const arga = 4.0 * (leff - delxl) * (leff - delxl) / (leff * leff);
        ddldvg *= arga;
        ddldvd *= arga;
        ddldvb *= arga;
        dldvd *= arga;
      }
      // Saturation region.
      const dlonxl = delxl * oneoverxl;
      const xlfact = 1.0 / (1.0 - dlonxl);
      cd1 = cdrain;
      cdrain *= xlfact;
      const diddl = cdrain / (leff - delxl);
      gm = gm * xlfact + diddl * ddldvg;
      gmbs = gmbs * xlfact + diddl * ddldvb;
      gds0 = diddl * ddldvd;
      gm += gds0 * dvsdvg;
      gmbs += gds0 * dvsdvb;
      gds = gds * xlfact + diddl * dldvd + gds0 * dvsdvd;
    }

    // line700: finish strong inversion case.
    if (lvgs < von) {
      // Weak inversion.
      const onxn = 1.0 / xn;
      const ondvt = onxn / vt;
      const wfact = Math.exp((lvgs - von) * ondvt);
      cdrain *= wfact;
      const gms = gm * wfact;
      const gmw = cdrain * ondvt;
      gm = gmw;
      if (lvds > vdsat) gm += gds0 * dvsdvg * wfact;
      gds = gds * wfact + (gms - gmw) * dvodvd;
      gmbs = gmbs * wfact + (gms - gmw) * dvodvb - gmw * (lvgs - von) * onxn * dxndvb;
    }
    return { mode, cdrain, gm, gds, gmbs, von, vdsat };
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
    const read = (solution: Float64Array) => (node: number) => (node >= 0 ? solution[node] : 0);
    const [vgsOld, vdsOld] = this.terminalVoltages(read(previous));
    const [vgsNew, vdsNew] = this.terminalVoltages(read(candidate));
    const vgdOld = vgsOld - vdsOld;
    const vgdNew = vgsNew - vdsNew;
    const von = this.lastVon;
    // mos3load.c limits vgs (vgd in inverse mode) with DEVfetlim and vds with
    // DEVlimvds; spice-ts scales the whole Newton step by the tightest limit,
    // as MOS2 and MOS6 do.
    const gateScale = vdsOld >= 0
      ? stepScale(vgsOld, vgsNew, fetlim(vgsNew, vgsOld, von))
      : stepScale(vgdOld, vgdNew, fetlim(vgdNew, vgdOld, von));
    const drainScale = vdsOld >= 0
      ? stepScale(vdsOld, vdsNew, limvds(vdsNew, vdsOld))
      : stepScale(-vdsOld, -vdsNew, limvds(-vdsNew, -vdsOld));
    return Math.min(gateScale, drainScale);
  }

  /** mos3load.c ideal bulk diode with the cubic reverse tail below -3 vt; returns [current, conductance]. */
  private junctionCurrent(voltage: number, satCur: number, gmin: number): [number, number] {
    const { vt } = this.temp;
    if (voltage <= -3 * vt) {
      let arg = 3 * vt / (voltage * CONSTE);
      arg = arg * arg * arg;
      return [-satCur * (1 + arg) + gmin * voltage, satCur * 3 * arg / voltage + gmin];
    }
    const ev = Math.exp(Math.min(MAX_EXP_ARG, voltage / vt));
    return [satCur * (ev - 1) + gmin * voltage, satCur * ev / vt + gmin];
  }

  stamp(ctx: StampContext): void {
    const type = this.model.polarity;
    const { vt, sourceVcrit, drainVcrit, sourceSatCur, drainSatCur } = this.temp;
    const gmin = ctx.gmin ?? DEVICE_GMIN;
    const [nD, nG, nS, nB] = this.nodes;
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const [vgs, vds, vbsRaw] = this.terminalVoltages(voltage);

    // mos3load.c junction limiting against the previous load.
    let vbs = vbsRaw;
    let vbd = vbs - vds;
    let limited: boolean;
    if (vds >= 0) {
      vbs = pnjlim(vbs, this.lastVbs, vt, sourceVcrit);
      limited = vbs !== vbsRaw;
      vbd = vbs - vds;
    } else {
      const vbdRaw = vbd;
      vbd = pnjlim(vbd, this.lastVbd, vt, drainVcrit);
      limited = vbd !== vbdRaw;
      vbs = vbd + vds;
    }
    this.lastVbs = vbs;
    this.lastVbd = vbd;

    const [cbs, gbs] = this.junctionCurrent(vbs, sourceSatCur, gmin);
    const [cbd, gbd] = this.junctionCurrent(vbd, drainSatCur, gmin);

    const channel = this.evaluateChannel(vgs, vds, vbs);
    this.lastVon = channel.von;
    const { mode, cdrain, gm, gds, gmbs } = channel;
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
   * ngspice (mos3load.c Check), Newton cannot converge on such an iterate.
   */
  limitedLastStamp(): boolean {
    return this.lastLoad.limited;
  }

  /**
   * ngspice-47 mos3conv.c: the drain current and the bulk junction currents
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

  /** Noise geometry in mos3noi.c/mos9noi.c excludes the DC-only XL/XW offsets. */
  noiseOperatingPoint(): { gm: number; cd: number; length: number; width: number } {
    return { gm: this.lastLoad.gm, cd: this.lastLoad.cd,
      length: this.instance.L - 2 * this.model.LD,
      width: this.instance.W - 2 * this.model.WD };
  }

  /** Meyer half capacitances [gs, gd, gb] at the given solution. */
  private meyerHalf(voltage: (node: number) => number, out: Float64Array): void {
    const [vgs, vds, vbs] = this.terminalVoltages(voltage);
    const channel = this.evaluateChannel(vgs, vds, vbs);
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
    const charges = this.charges;
    const capacitances = this.capacitanceScratch;
    const junctionCharges = this.chargeScratch;
    this.evaluateCharges(ctx, capacitances, junctionCharges);
    charges.begin(integration);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      const positive = this.nodes[p];
      const negative = this.nodes[n];
      if (positive === negative) continue;
      const voltage = branchVoltage(ctx, positive, negative);
      const capacitance = capacitances[index];
      if (index < GATE_CHARGES) {
        const charge = charges.incrementalCharge(index, voltage, capacitance, true);
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
   * mos3load.c folds the bulk junction charge currents into the junction
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

  acceptTransientStep(ctx: StampContext): void {
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

  /** ngspice MOS3trunc: CKTterr on the three Meyer gate charges. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx), TRUNCATED_CHARGES);
  }

  resetTransient(): void {
    this.charges.reset();
  }

  /**
   * Node-domain capacitances of every charge at the present solution, and the
   * exact bulk-junction charges (mos3load.c qbs/qbd, scaled by the polarity so
   * q and C refer to the node-domain branch voltage). The gate entries are the
   * full Meyer capacitance 2 * half + overlap; TransientChargeState averages
   * it with the accepted value, which yields mos3load.c's
   * capgs = half(n+1) + half(n) + overlap.
   */
  private evaluateCharges(ctx: StampContext, capacitances: Float64Array, junctionCharges: Float64Array): void {
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const half = halfScratch;
    this.meyerHalf(voltage, half);
    capacitances[GATE_SOURCE] = 2 * half[0] + this.overlapGS;
    capacitances[GATE_DRAIN] = 2 * half[1] + this.overlapGD;
    capacitances[GATE_BULK] = 2 * half[2] + this.overlapGB;
    const type = this.model.polarity;
    const [, vds, vbs] = this.terminalVoltages(voltage);
    const vbd = vbs - vds;
    const { Cbs, Cbssw, Cbd, Cbdsw, f2s, f3s, f4s, f2d, f3d, f4d } = this.temp;
    capacitances[BULK_SOURCE] = this.depletionCapacitance(vbs, Cbs, Cbssw, f2s, f3s);
    capacitances[BULK_DRAIN] = this.depletionCapacitance(vbd, Cbd, Cbdsw, f2d, f3d);
    junctionCharges[BULK_SOURCE] = type * this.depletionCharge(vbs, Cbs, Cbssw, f2s, f3s, f4s);
    junctionCharges[BULK_DRAIN] = type * this.depletionCharge(vbd, Cbd, Cbdsw, f2d, f3d, f4d);
  }

  /** mos3load.c (1-v/pb)^-MJ and (1-v/pb)^-MJSW, with its sqrt fast path for 0.5. */
  private gradingFactors(arg: number): [number, number] {
    const { MJ, MJSW } = this.model;
    const sarg = MJ === 0.5 ? 1 / Math.sqrt(arg) : Math.exp(-MJ * Math.log(arg));
    const sargsw = MJSW === 0.5 ? 1 / Math.sqrt(arg) : Math.exp(-MJSW * Math.log(arg));
    return [sarg, sargsw];
  }

  /** mos3load.c bulk junction depletion charge (MOS3qbs / MOS3qbd). */
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

  /** mos3load.c bulk junction depletion capacitance (MOS3capbs / MOS3capbd). */
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
