import {
  DEVICE_GMIN, type ChargeIntegration, type ChargeTruncation, type ConvergenceTolerances, type DeviceModel, type StampContext,
} from './device.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';
import { InvalidCircuitError, UnsupportedTemperatureError } from '../errors.js';
import { fetlim, limvds, pnjlim, stepScale } from './devsup.js';

/**
 * MOSFET level 6: Sakurai-Newton n-th power law model, ported from ngspice-47
 * src/spicelib/devices/mos6 (mos6set.c defaults, mos6temp.c temperature and
 * parameter preprocessing, mos6load.c DC equations, junctions and limiting)
 * plus devsup.c DEVqmeyer for the Meyer gate capacitances.
 *
 * Transient charges are integrated as mos6load.c does with NIintegrate
 * (TransientChargeState): the Meyer gate charges advance from the accepted
 * point with the half capacitance at the current iterate plus the half
 * capacitance at the accepted point plus the constant overlap capacitance
 * (DEVqmeyer), and the bulk junction charges are the exact depletion charges
 * qbs/qbd. AC and other small-signal analyses stamp the capacitances through
 * stampDynamic.
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
const EPS_OX = 3.9 * 8.854214871e-12;
const EPS_SI = 11.70 * 8.854214871e-12;
const MEYER_MAGIC_VDS = 0.025;

/** Resolved MOS6 model card after mos6set.c defaulting and mos6temp.c preprocessing. */
export interface MOS6ModelParams {
  polarity: number;
  VTO: number;
  KV: number;
  NV: number;
  KC: number;
  NC: number;
  GAMMA: number;
  GAMMA1: number;
  SIGMA: number;
  PHI: number;
  LAMBDA0: number;
  LAMBDA1: number;
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
  TNOM: number;
  unsupportedTemperatureParameter?: string;
  oxideCapFactor: number;
  given: {
    CBD: boolean;
    CBS: boolean;
    CJ: boolean;
    CJSW: boolean;
  };
}

export interface MOS6InstanceParams {
  W: number;
  L: number;
  M: number;
  AD: number;
  AS: number;
  PD: number;
  PS: number;
}

/** Temperature-dependent instance quantities (mos6temp.c). */
interface MOS6TemperatureState {
  vt: number;
  tKc: number;
  tPhi: number;
  tVbi: number;
  tVto: number;
  tSatCur: number;
  tSatCurDens: number;
  tBulkPot: number;
  tDepCap: number;
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
 * mos6set.c creates prime nodes for nonzero RD/RS or RSH*squares.
 * mos6temp.c gives explicit RD/RS precedence, even zero (an open prime
 * terminal). mos6load.c multiplies conductance by M. Unlike MOS1/MOS2,
 * mos6set.c leaves omitted squares at zero, suppressing the prime node;
 * the later mos6temp.c reset to one square cannot create that missing node.
 * Return 0 for a short, Infinity for an open, otherwise ohms divided by M.
 */
export function mos6SeriesResistances(
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
    drain: resistance(card.RD, instance?.NRD ?? 0),
    source: resistance(card.RS, instance?.NRS ?? 0),
  };
}

function given(params: Record<string, number | undefined>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = params[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Apply mos6set.c defaults and the model-level part of mos6temp.c. Throws the
 * same fatal model errors ngspice reports (non-positive PHI, NSUB < Ni).
 */
export function resolveMOS6Model(
  name: string,
  params: Readonly<Record<string, number | undefined>>,
  polarity: number,
): MOS6ModelParams {
  const tnom = (params.TNOM ?? 27) + CONSTCTOK;
  const vtnom = tnom * CONSTKOVERQ;
  const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);

  const lambda = given(params, 'LAMBDA0') ?? given(params, 'LAMBDA') ?? 0;
  let kc = params.KC ?? 5e-5;
  let phi = params.PHI ?? 0.6;
  let gamma = params.GAMMA ?? 0;
  const gamma1 = params.GAMMA1 ?? 0;
  let vto = given(params, 'VTO', 'VT0') ?? 0;

  if (phi <= 0) {
    throw new InvalidCircuitError(`MOSFET level 6 model '${name}': Phi is not positive`);
  }

  let oxideCapFactor = 0;
  const tox = params.TOX;
  if (tox !== undefined && tox !== 0) {
    oxideCapFactor = EPS_OX / tox;
    if (params.KC === undefined) {
      const mobility = given(params, 'U0', 'UO') ?? 600;
      kc = 0.5 * mobility * oxideCapFactor * 1e-4;
    }
    const nsub = params.NSUB;
    if (nsub !== undefined) {
      if (nsub * 1e6 > 1.45e16) {
        if (params.PHI === undefined) {
          phi = Math.max(0.1, 2 * vtnom * Math.log(nsub * 1e6 / 1.45e16));
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
          gamma = Math.sqrt(2 * EPS_SI * CHARGE * nsub * 1e6) / oxideCapFactor;
        }
        if (given(params, 'VTO', 'VT0') === undefined) {
          const nss = params.NSS ?? 0;
          const vfb = wkfngs - nss * 1e4 * CHARGE / oxideCapFactor;
          vto = vfb + polarity * (gamma * Math.sqrt(phi) + phi);
        }
      } else {
        throw new InvalidCircuitError(`MOSFET level 6 model '${name}': Nsub < Ni`);
      }
    }
  }

  // mos6temp.c covers these standard fields, not dialect-specific UTE/TCV/XTI laws.
  const temperatureParameters = new Set([
    'LEVEL', 'VTO', 'VT0', 'KV', 'NV', 'KC', 'NC', 'GAMMA', 'GAMMA1', 'SIGMA',
    'PHI', 'LAMBDA', 'LAMBDA0', 'LAMBDA1', 'IS', 'JS', 'PB', 'CJ', 'CJSW',
    'MJ', 'MJSW', 'FC', 'CBD', 'CBS', 'CGSO', 'CGDO', 'CGBO', 'LD', 'TNOM',
    'TOX', 'U0', 'UO', 'NSUB', 'TPG', 'NSS', 'RD', 'RS', 'RSH',
  ]);
  return {
    polarity,
    unsupportedTemperatureParameter: Object.keys(params).find(key => params[key] !== undefined
      && !temperatureParameters.has(key)),
    VTO: vto,
    KV: params.KV ?? 2,
    NV: params.NV ?? 0.5,
    KC: kc,
    NC: params.NC ?? 1,
    GAMMA: gamma,
    GAMMA1: gamma1,
    SIGMA: params.SIGMA ?? 0,
    PHI: phi,
    LAMBDA0: lambda,
    LAMBDA1: params.LAMBDA1 ?? 0,
    IS: params.IS ?? 1e-14,
    JS: params.JS ?? 0,
    PB: params.PB ?? 0.8,
    CJ: params.CJ ?? 0,
    CJSW: params.CJSW ?? 0,
    MJ: params.MJ ?? 0.5,
    MJSW: params.MJSW ?? 0.5,
    FC: params.FC ?? 0.5,
    CBD: params.CBD ?? 0,
    CBS: params.CBS ?? 0,
    CGSO: params.CGSO ?? 0,
    CGDO: params.CGDO ?? 0,
    CGBO: params.CGBO ?? 0,
    LD: params.LD ?? 0,
    TNOM: tnom,
    oxideCapFactor,
    given: {
      CBD: params.CBD !== undefined,
      CBS: params.CBS !== undefined,
      CJ: params.CJ !== undefined,
      CJSW: params.CJSW !== undefined,
    },
  };
}

/** devsup.c DEVqmeyer: half of the non-constant Meyer capacitances. */
export function meyerHalfCapacitances(
  vgs: number,
  vgd: number,
  von: number,
  vdsatIn: number,
  phi: number,
  cox: number,
  out: Float64Array,
): void {
  const vgst = vgs - von;
  const vdsat = Math.max(vdsatIn, MEYER_MAGIC_VDS);
  let capgs: number;
  let capgd: number;
  let capgb: number;
  if (vgst <= -phi) {
    capgb = cox / 2;
    capgs = 0;
    capgd = 0;
  } else if (vgst <= -phi / 2) {
    capgb = -vgst * cox / (2 * phi);
    capgs = 0;
    capgd = 0;
  } else if (vgst <= 0) {
    capgb = -vgst * cox / (2 * phi);
    capgs = vgst * cox / (1.5 * phi) + cox / 3;
    const vds = vgs - vgd;
    if (vds >= vdsat) {
      capgd = 0;
    } else {
      const vddif = 2 * vdsat - vds;
      const vddif1 = vdsat - vds;
      const vddif2 = vddif * vddif;
      capgd = capgs * (1 - vdsat * vdsat / vddif2);
      capgs = capgs * (1 - vddif1 * vddif1 / vddif2);
    }
  } else {
    const vds = vgs - vgd;
    if (vdsat <= vds) {
      capgs = cox / 3;
      capgd = 0;
      capgb = 0;
    } else {
      const vddif = 2 * vdsat - vds;
      const vddif1 = vdsat - vds;
      const vddif2 = vddif * vddif;
      capgd = cox * (1 - vdsat * vdsat / vddif2) / 3;
      capgs = cox * (1 - vddif1 * vddif1 / vddif2) / 3;
      capgb = 0;
    }
  }
  out[0] = capgs;
  out[1] = capgd;
  out[2] = capgb;
}

/** Channel evaluation result (polarity domain). */
export interface MOS6Channel {
  /** +1 normal mode (vds >= 0), -1 inverse mode. */
  mode: number;
  cdrain: number;
  gm: number;
  gds: number;
  gmbs: number;
  von: number;
  vdsat: number;
}

/** Reused scratch buffers; consumed immediately by each caller. */
const halfScratch = new Float64Array(3);

/** Charge indices of the gate-source, gate-drain, gate-bulk, bulk-source and bulk-drain charges. */
const GATE_SOURCE = 0;
const GATE_DRAIN = 1;
const GATE_BULK = 2;
const BULK_SOURCE = 3;
const BULK_DRAIN = 4;
/** Number of Meyer gate charges (indices below this use the averaged DEVqmeyer increment). */
const GATE_CHARGES = 3;
/** Charges ngspice-47 MOS6trunc bounds with CKTterr: the Meyer gate charges only. */
const TRUNCATED_CHARGES: readonly number[] = [GATE_SOURCE, GATE_DRAIN, GATE_BULK];
/** Terminal indices (D, G, S, B) of each charge, positive then negative, in charge-index order. */
const CHARGE_BRANCHES: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [1, 0], [1, 3], [3, 2], [3, 0],
];

/**
 * The linearisation of the last load, per instance (before the M multiplier),
 * as ngspice-47 keeps it in CKTstate0 and the instance struct: the junction
 * and terminal voltages it was evaluated at and the drain and bulk currents
 * with their conductances, transient junction charge currents folded in.
 */
interface MOS6Load {
  vbs: number;
  vbd: number;
  vgs: number;
  vds: number;
  mode: number;
  /** MOS6cd = mode * cdrain - cbd (minus cqbd in transient). */
  cd: number;
  cbs: number;
  cbd: number;
  gm: number;
  gds: number;
  gmbs: number;
  gbs: number;
  gbd: number;
}

export class MOS6 implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (MOS6trunc: qgs, qgd, qgb). */
  readonly truncationCoversCharges = true;
  readonly model: MOS6ModelParams;
  readonly instance: MOS6InstanceParams;
  private readonly effectiveLength: number;
  private readonly betaFactor: number;
  private readonly oxideCap: number;
  private readonly overlapGS: number;
  private readonly overlapGD: number;
  private readonly overlapGB: number;
  private temperature = 27;
  private temp!: MOS6TemperatureState;
  /** ngspice CKTstate0 vbs/vbd/von of the previous load. */
  private lastVbs = 0;
  private lastVbd = 0;
  private lastVon: number;
  private readonly lastLoad: MOS6Load = {
    vbs: 0, vbd: 0, vgs: 0, vds: 0, mode: 1, cd: 0, cbs: 0, cbd: 0, gm: 0, gds: 0, gmbs: 0, gbs: 0, gbd: 0,
  };
  /** Transient gate and bulk-junction charges (ngspice MOS6qgs..MOS6qbd), integrated by the device. */
  readonly integratesTransientCharge = true;
  readonly storesCharge: boolean;
  private readonly charges = new TransientChargeState(CHARGE_BRANCHES.length);
  /** Capacitance (gate) or charge/capacitance (junction) evaluation scratch, in charge-index order. */
  private readonly chargeScratch = new Float64Array(CHARGE_BRANCHES.length);
  private readonly capacitanceScratch = new Float64Array(CHARGE_BRANCHES.length);

  constructor(
    readonly name: string,
    /** [drain, gate, source, bulk] */
    readonly nodes: number[],
    model: MOS6ModelParams,
    instance: Partial<MOS6InstanceParams> & { TEMP?: number; DTEMP?: number },
  ) {
    // Instance temperature overrides are not yet part of the validated MOS6 surface.
    for (const parameter of ['TEMP', 'DTEMP'] as const) {
      if (instance[parameter] !== undefined) {
        throw new UnsupportedTemperatureError(name, instance.TEMP ?? 27 + (instance.DTEMP ?? 0), parameter);
      }
    }
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
    const { W, L } = this.instance;
    this.effectiveLength = L - 2 * model.LD;
    if (!(this.effectiveLength > 0)) {
      throw new InvalidCircuitError(`${name}: MOSFET level 6 effective channel length is not positive`);
    }
    this.betaFactor = W / this.effectiveLength;
    this.oxideCap = model.oxideCapFactor * this.effectiveLength * W;
    this.overlapGS = model.CGSO * W;
    this.overlapGD = model.CGDO * W;
    this.overlapGB = model.CGBO * this.effectiveLength;
    this.applyTemperature();
    this.lastVon = this.temp.tVto * model.polarity;
    const { Cbs, Cbssw, Cbd, Cbdsw } = this.temp;
    this.storesCharge = [this.oxideCap, this.overlapGS, this.overlapGD, this.overlapGB, Cbs, Cbssw, Cbd, Cbdsw]
      .some(value => value !== 0);
  }

  setTemperature(value: number): void {
    if (value !== this.model.TNOM - CONSTCTOK && this.model.unsupportedTemperatureParameter !== undefined) {
      throw new UnsupportedTemperatureError(this.name, value, this.model.unsupportedTemperatureParameter);
    }
    this.temperature = value;
    this.applyTemperature();
  }

  getTemperature(): number {
    return this.temperature;
  }

  /** mos6temp.c instance loop. */
  private applyTemperature(): void {
    const model = this.model;
    const { AD, AS, PD, PS } = this.instance;
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
    const tKc = model.KC / ratio4;
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

    let drainVcrit: number;
    let sourceVcrit: number;
    if (tSatCurDens === 0 || AD === 0 || AS === 0) {
      drainVcrit = sourceVcrit = vt * Math.log(vt / (CONSTROOT2 * tSatCur));
    } else {
      drainVcrit = vt * Math.log(vt / (CONSTROOT2 * tSatCurDens * AD));
      sourceVcrit = vt * Math.log(vt / (CONSTROOT2 * tSatCurDens * AS));
    }

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
    const czbd = model.given.CBD ? tCbd : model.given.CJ ? tCj * AD : 0;
    const czbdsw = model.given.CJSW ? tCjsw * PD : 0;
    const czbs = model.given.CBS ? tCbs : model.given.CJ ? tCj * AS : 0;
    const czbssw = model.given.CJSW ? tCjsw * PS : 0;
    const drain = junction(czbd, czbdsw);
    const source = junction(czbs, czbssw);

    this.temp = {
      vt, tKc, tPhi, tVbi, tVto, tSatCur, tSatCurDens, tBulkPot, tDepCap,
      drainVcrit, sourceVcrit,
      Cbd: czbd, Cbdsw: czbdsw, Cbs: czbs, Cbssw: czbssw,
      f2d: drain.f2, f3d: drain.f3, f4d: drain.f4,
      f2s: source.f2, f3s: source.f3, f4s: source.f4,
    };
  }

  private get drainSatCur(): number {
    const { tSatCur, tSatCurDens } = this.temp;
    const { AD, AS } = this.instance;
    return tSatCurDens === 0 || AD === 0 || AS === 0 ? tSatCur : tSatCurDens * AD;
  }

  private get sourceSatCur(): number {
    const { tSatCur, tSatCurDens } = this.temp;
    const { AD, AS } = this.instance;
    return tSatCurDens === 0 || AD === 0 || AS === 0 ? tSatCur : tSatCurDens * AS;
  }

  /** mos6load.c n-th power law block, polarity domain. */
  evaluateChannel(vgs: number, vds: number, vbs: number): MOS6Channel {
    const model = this.model;
    const { tPhi, tVbi, tKc } = this.temp;
    const mode = vds >= 0 ? 1 : -1;
    const vbd = vbs - vds;
    const vbsvbd = mode === 1 ? vbs : vbd;
    let sarg1: number;
    if (vbsvbd <= 0) {
      sarg1 = Math.sqrt(tPhi - vbsvbd);
    } else {
      sarg1 = Math.sqrt(tPhi);
      sarg1 = Math.max(0, sarg1 - vbsvbd / (sarg1 + sarg1));
    }
    const vdshere = vds * mode;
    const von = tVbi * model.polarity + model.GAMMA * sarg1
      - model.GAMMA1 * vbsvbd - model.SIGMA * vdshere;
    const vgon = (mode === 1 ? vgs : vgs - vds) - von;
    if (vgon <= 0) {
      return { mode, cdrain: 0, gm: 0, gds: 0, gmbs: 0, von, vdsat: 0 };
    }
    let vonbm = 0;
    if (sarg1 > 0) {
      vonbm = vbsvbd <= 0
        ? model.GAMMA1 + model.GAMMA / (sarg1 + sarg1)
        : model.GAMMA1 + model.GAMMA / 2 / Math.sqrt(tPhi);
    }
    const logVgon = Math.log(vgon);
    const vdsat = model.KV * Math.exp(logVgon * model.NV);
    const idsat = tKc * this.betaFactor * Math.exp(logVgon * model.NC);
    const lambda = model.LAMBDA0 - model.LAMBDA1 * vbsvbd;
    let cdrain = idsat * (1 + lambda * vdshere);
    let gm = cdrain * model.NC / vgon;
    let gds = gm * model.SIGMA + idsat * lambda;
    let gmbs = gm * vonbm - idsat * model.LAMBDA1 * vdshere;
    if (vdsat > vdshere) {
      const vdst = vdshere / vdsat;
      const vdst2 = (2 - vdst) * vdst;
      const vdstg = -vdst * model.NV / vgon;
      const ivdst1 = cdrain * (2 - vdst - vdst);
      cdrain *= vdst2;
      gm = gm * vdst2 + ivdst1 * vdstg;
      gds = gds * vdst2 + ivdst1 * (1 / vdsat + vdstg * model.SIGMA);
      gmbs = gmbs * vdst2 + ivdst1 * vdstg * vonbm;
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
    // mos6load.c limits vgs (vgd in inverse mode) with DEVfetlim and vds with
    // DEVlimvds. spice-ts limits by scaling the whole Newton step, so each
    // limited voltage contributes its own scale. Neither limiter returns the
    // old value for a non-zero step, so the scale stays positive and Newton
    // cannot stall on an unchanged iterate.
    const gateScale = vdsOld >= 0
      ? stepScale(vgsOld, vgsNew, fetlim(vgsNew, vgsOld, von))
      : stepScale(vgdOld, vgdNew, fetlim(vgdNew, vgdOld, von));
    const drainScale = vdsOld >= 0
      ? stepScale(vdsOld, vdsNew, limvds(vdsNew, vdsOld))
      : stepScale(-vdsOld, -vdsNew, limvds(-vdsNew, -vdsOld));
    return Math.min(gateScale, drainScale);
  }

  stamp(ctx: StampContext): void {
    const model = this.model;
    const gmin = ctx.gmin ?? DEVICE_GMIN;
    const type = model.polarity;
    const m = this.instance.M;
    const { vt, sourceVcrit, drainVcrit } = this.temp;
    const [nD, nG, nS, nB] = this.nodes;
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const [vgs, vds, vbsRaw] = this.terminalVoltages(voltage);

    // mos6load.c junction limiting against the previous load.
    let vbs = vbsRaw;
    let vbd = vbs - vds;
    if (vds >= 0) {
      vbs = pnjlim(vbs, this.lastVbs, vt, sourceVcrit);
      vbd = vbs - vds;
    } else {
      vbd = pnjlim(vbd, this.lastVbd, vt, drainVcrit);
      vbs = vbd + vds;
    }
    this.lastVbs = vbs;
    this.lastVbd = vbd;

    const sourceSatCur = this.sourceSatCur;
    const drainSatCur = this.drainSatCur;
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

    const ceqbs = type * (cbs - gbs * vbs);
    const ceqbd = type * (cbd - gbd * vbd);
    const xnrm = mode >= 0 ? 1 : 0;
    const xrev = 1 - xnrm;
    const cdreq = mode >= 0
      ? type * (cdrain - gds * vds - gm * vgs - gmbs * vbs)
      : -type * (cdrain - gds * (-vds) - gm * (vgs - vds) - gmbs * vbd);

    const g = (row: number, col: number, value: number) => {
      if (row >= 0 && col >= 0) ctx.stampG(row, col, m * value);
    };
    const b = (row: number, value: number) => {
      if (row >= 0) ctx.stampB(row, m * value);
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
    const m = this.instance.M;
    const [nD, nG, nS, nB] = this.nodes;
    stampCapacitance(ctx, nG, nS, m * (2 * half[0] + this.overlapGS));
    stampCapacitance(ctx, nG, nD, m * (2 * half[1] + this.overlapGD));
    stampCapacitance(ctx, nG, nB, m * (2 * half[2] + this.overlapGB));

    const { Cbs, Cbssw, Cbd, Cbdsw } = this.temp;
    if (Cbs !== 0 || Cbssw !== 0 || Cbd !== 0 || Cbdsw !== 0) {
      const [, vds, vbs] = this.terminalVoltages(voltage);
      const vbd = vbs - vds;
      stampCapacitance(ctx, nB, nS, m * this.depletionCapacitance(vbs, Cbs, Cbssw, this.temp.f2s, this.temp.f3s));
      stampCapacitance(ctx, nB, nD, m * this.depletionCapacitance(vbd, Cbd, Cbdsw, this.temp.f2d, this.temp.f3d));
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
   * mos6load.c folds the bulk junction charge currents into the junction
   * currents the convergence test reads: cbd += cqbd, cd -= cqbd, gbd += geq
   * (and cbs, gbs for the source junction). `current` and `conductance` are
   * node-domain and include the M multiplier; the load is per instance.
   */
  private foldJunctionChargeCurrent(index: number, current: number, conductance: number): void {
    const load = this.lastLoad;
    const m = this.instance.M;
    const deviceCurrent = this.model.polarity * current / m;
    const deviceConductance = conductance / m;
    if (index === BULK_SOURCE) {
      load.cbs += deviceCurrent;
      load.gbs += deviceConductance;
    } else {
      load.cbd += deviceCurrent;
      load.cd -= deviceCurrent;
      load.gbd += deviceConductance;
    }
  }

  /**
   * ngspice-47 mos6conv.c: the drain current and the bulk junction currents
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

  /** ngspice MOS6trunc: CKTterr on the three Meyer gate charges. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx), TRUNCATED_CHARGES);
  }

  resetTransient(): void {
    this.charges.reset();
  }

  /**
   * Node-domain capacitances of every charge at the present solution, and the
   * exact bulk-junction charges (mos6load.c qbs/qbd, scaled by the polarity so
   * q and C refer to the node-domain branch voltage). The gate entries are the
   * full Meyer capacitance 2 * half + overlap; TransientChargeState averages
   * it with the accepted value, which yields mos6load.c's
   * capgs = half(n+1) + half(n) + overlap.
   */
  private evaluateCharges(ctx: StampContext, capacitances: Float64Array, junctionCharges: Float64Array): void {
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const half = halfScratch;
    this.meyerHalf(voltage, half);
    const m = this.instance.M;
    capacitances[GATE_SOURCE] = m * (2 * half[0] + this.overlapGS);
    capacitances[GATE_DRAIN] = m * (2 * half[1] + this.overlapGD);
    capacitances[GATE_BULK] = m * (2 * half[2] + this.overlapGB);
    const type = this.model.polarity;
    const [, vds, vbs] = this.terminalVoltages(voltage);
    const vbd = vbs - vds;
    const { Cbs, Cbssw, Cbd, Cbdsw, f2s, f3s, f4s, f2d, f3d, f4d } = this.temp;
    capacitances[BULK_SOURCE] = m * this.depletionCapacitance(vbs, Cbs, Cbssw, f2s, f3s);
    capacitances[BULK_DRAIN] = m * this.depletionCapacitance(vbd, Cbd, Cbdsw, f2d, f3d);
    junctionCharges[BULK_SOURCE] = type * m * this.depletionCharge(vbs, Cbs, Cbssw, f2s, f3s, f4s);
    junctionCharges[BULK_DRAIN] = type * m * this.depletionCharge(vbd, Cbd, Cbdsw, f2d, f3d, f4d);
  }

  /** mos6load.c bulk junction depletion charge (MOS6qbs / MOS6qbd). */
  private depletionCharge(
    voltage: number,
    bottom: number,
    sidewall: number,
    f2: number,
    f3: number,
    f4: number,
  ): number {
    if (bottom === 0 && sidewall === 0) return 0;
    const { tDepCap, tBulkPot } = this.temp;
    if (voltage < tDepCap) {
      const arg = 1 - voltage / tBulkPot;
      const sarg = Math.exp(-this.model.MJ * Math.log(arg));
      const sargsw = Math.exp(-this.model.MJSW * Math.log(arg));
      return tBulkPot * (bottom * (1 - arg * sarg) / (1 - this.model.MJ)
        + sidewall * (1 - arg * sargsw) / (1 - this.model.MJSW));
    }
    return f4 + voltage * (f2 + voltage * (f3 / 2));
  }

  /** mos6load.c bulk junction depletion capacitance. */
  private depletionCapacitance(
    voltage: number,
    bottom: number,
    sidewall: number,
    f2: number,
    f3: number,
  ): number {
    if (bottom === 0 && sidewall === 0) return 0;
    const { tDepCap, tBulkPot } = this.temp;
    if (voltage < tDepCap) {
      const arg = 1 - voltage / tBulkPot;
      const sarg = Math.exp(-this.model.MJ * Math.log(arg));
      const sargsw = Math.exp(-this.model.MJSW * Math.log(arg));
      return bottom * sarg + sidewall * sargsw;
    }
    return f2 + f3 * voltage;
  }
}

export function branchVoltage(ctx: StampContext, positive: number, negative: number): number {
  return (positive >= 0 ? ctx.getVoltage(positive) : 0)
    - (negative >= 0 ? ctx.getVoltage(negative) : 0);
}

/**
 * Stamp a two-terminal capacitance. Zero values are stamped too, so the
 * sparsity pattern captured on the first assembly already holds every
 * bias-dependent Meyer entry.
 */
export function stampCapacitance(ctx: StampContext, n1: number, n2: number, value: number): void {
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
