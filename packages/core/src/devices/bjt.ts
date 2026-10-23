import type {
  ChargeIntegration, ChargeTruncation, ConvergenceTolerances, DeviceModel, StampContext,
} from './device.js';
import { DEVICE_GMIN } from './device.js';
import {
  depletionCharge, stampChargeBranch, stampChargeCurrent, TransientChargeState,
} from './charge-state.js';
import {
  assertNoUnsupportedTemperatureParameters, CONSTCTOK, CONSTKOVERQ, NOMINAL_TEMPERATURE_C,
  temperatureJunction,
} from './junction-temperature.js';
import { pnjlim } from './devsup.js';
import { stampEpiRegion } from './bjt-quasisat.js';

// Share readers instead of allocating and naming closures in every Newton iterate.
function contextVoltage(ctx: StampContext, node: number): number {
  return node >= 0 ? ctx.getVoltage(node) : 0;
}

function solutionVoltage(solution: Float64Array, node: number): number {
  return node >= 0 ? solution[node] : 0;
}

export interface BJTParams {
  LEVEL: number;
  BF: number;
  BR: number;
  IS: number;
  NF: number;
  NR: number;
  VAF: number;
  IKF: number;
  ISE: number;
  NE: number;
  /** Reverse Early voltage and knee current (bjtload.c q1 and q2). */
  VAR: number;
  IKR: number;
  /** B-C leakage saturation current and emission coefficient (bjtload.c cbcn). */
  ISC: number;
  NC: number;
  /** High-current roll-off exponent (bjtload.c sqarg = arg^NKF). */
  NKF: number;
  RB: number;
  TRB1: number;
  TRB2: number;
  TRM1: number;
  TRM2: number;
  TRC1: number;
  TRC2: number;
  TRE1: number;
  TRE2: number;
  /**
   * Minimum base resistance and the base current where the resistance falls
   * half-way to it (bjtload.c gx). RBM defaults to RB (bjttemp.c).
   */
  RBM: number;
  IRB: number;
  RC: number;
  /** Kull epi-region parameters (ngspice-47 bjtload.c). */
  RCO: number;
  VO: number;
  GAMMA: number;
  QCO: number;
  RE: number;
  KF: number;
  AF: number;
  /** Charge storage (SPICE Gummel-Poon, ngspice bjtload.c semantics). */
  CJE: number;
  VJE: number;
  MJE: number;
  TF: number;
  XTF: number;
  VTF: number;
  ITF: number;
  CJC: number;
  VJC: number;
  MJC: number;
  XCJC: number;
  TR: number;
  CJS: number;
  VJS: number;
  MJS: number;
  FC: number;
  /** Substrate connection: 1 vertical (collector), -1 lateral (base). */
  SUBS: number;
  /** Substrate junction saturation current and emission coefficient. */
  ISS: number;
  NS: number;
  /** bjttemp.c temperature inputs: TNOM (C), EG (eV), XTI and the beta exponent XTB. */
  TNOM: number;
  EG: number;
  XTI: number;
  XTB: number;
  polarity: number; // 1 for NPN, -1 for PNP
}

/** ngspice model-card aliases resolved to their canonical parameter. */
const MODEL_PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  VA: 'VAF',
  IK: 'IKF',
  VB: 'VAR',
  C2: 'ISE',
  C4: 'ISC',
  NK: 'NKF',
  TREF: 'TNOM',
  PE: 'VJE',
  ME: 'MJE',
  PC: 'VJC',
  MC: 'MJC',
  CSUB: 'CJS',
  CCS: 'CJS',
  PS: 'VJS',
  MS: 'MJS',
};

const CHARGE_STORAGE_PARAMETERS = [
  'CJE', 'VJE', 'MJE', 'TF', 'XTF', 'VTF', 'ITF', 'PTF', 'CJC', 'VJC', 'MJC', 'XCJC',
  'TR', 'CJS', 'VJS', 'MJS', 'FC', 'SUBS',
] as const;

/**
 * bjttemp.c fields whose temperature laws are not implemented (TLEV/TLEVC != 0
 * and the per-parameter coefficients, with the TRB/TRC/TRE aliases). They only
 * act away from TNOM, where they are rejected rather than ignored (#374).
 */
const UNSUPPORTED_TEMPERATURE_PARAMETERS = [
  'TRB', 'TRC', 'TRE',
  'TLEV', 'TLEVC',
  'TBF1', 'TBF2', 'TBR1', 'TBR2', 'TIKF1', 'TIKF2', 'TIKR1', 'TIKR2', 'TIRB1', 'TIRB2',
  'TNC1', 'TNC2', 'TNE1', 'TNE2', 'TNF1', 'TNF2', 'TNR1', 'TNR2', 'TNS1', 'TNS2',
  'TVAF1', 'TVAF2', 'TVAR1', 'TVAR2', 'TITF1', 'TITF2', 'TTF1', 'TTF2', 'TTR1', 'TTR2',
  'TMJE1', 'TMJE2', 'TMJC1', 'TMJC2', 'TMJS1', 'TMJS2', 'TIS1', 'TIS2', 'TISE1', 'TISE2',
  'TISC1', 'TISC2', 'TISS1', 'TISS2', 'CTE', 'CTC', 'CTS', 'TVJE', 'TVJC', 'TVJS',
] as const;

/**
 * ngspice-47 bjtsoachk.c safe-operating-area limits only print warnings.
 */
const INERT_MODEL_PARAMETERS = [
  'VBE_MAX', 'VBC_MAX', 'VCE_MAX', 'PD_MAX', 'IC_MAX', 'IB_MAX', 'TE_MAX', 'RTH0',
] as const;

/**
 * Every Gummel-Poon model parameter spice-ts accepts. Anything else on the
 * card (the IBE/IBC split saturation currents, unknown
 * names) is rejected whatever else the card sets (#633).
 */
const SUPPORTED_MODEL_PARAMETERS = new Set<string>([
  'LEVEL', 'BF', 'BR', 'IS', 'NF', 'NR', 'VAF', 'IKF', 'ISE', 'NE', 'VAR', 'IKR', 'ISC', 'NC',
  'NKF', 'RB', 'RBM', 'IRB', 'RC', 'RE', 'KF', 'AF', 'ISS', 'NS', 'TNOM', 'EG', 'XTI', 'XTB',
  'RCO', 'VO', 'GAMMA', 'QCO', 'QUASIMOD', 'VG', 'CN', 'D',
  'TRE1', 'TRE2', 'TRC1', 'TRC2', 'TRB1', 'TRB2', 'TRM1', 'TRM2',
  ...CHARGE_STORAGE_PARAMETERS, ...Object.keys(MODEL_PARAMETER_ALIASES),
  ...UNSUPPORTED_TEMPERATURE_PARAMETERS, ...INERT_MODEL_PARAMETERS,
]);

// ngspice-47 bjttemp.c: vt = BJTtemp * CONSTKoverQ, with const.h CONSTboltz and
// CHARGE (#525; the old 0.02585 V offset Vbe by ~3e-4 V). The device keeps it
// per instance, at its temperature (#374).

/** ngspice-47 MAX_EXP_ARG: bjtload.c caps the substrate exponent with it. */
const MAX_EXP_ARG = 709;

/**
 * ngspice-47 bjtload.c junction law (polarity domain) for cbe, cbc and cben:
 * csat*(exp(v/vtn) - 1) at and above -3*vtn, and the reverse law
 * -csat*(1 + (3*vtn/(e*v))^3) below it (#551). Forward bias is never clamped:
 * ngspice limits a junction only relative to the previous Newton iterate
 * (DEVpnjlim), which {@link BJT.limitNewtonStep} does (#538). Writes into
 * `out` so the stamp hot path does not allocate.
 */
function junctionLaw(
  out: JunctionPoint, voltage: number, saturationCurrent: number, thermalVoltage: number,
): JunctionPoint {
  if (voltage >= -3 * thermalVoltage) {
    const exponential = Math.exp(voltage / thermalVoltage);
    out.current = saturationCurrent * (exponential - 1);
    out.conductance = saturationCurrent * exponential / thermalVoltage;
  } else {
    const ratio = 3 * thermalVoltage / (voltage * Math.E);
    const cube = ratio * ratio * ratio;
    out.current = -saturationCurrent * (1 + cube);
    out.conductance = saturationCurrent * 3 * cube / voltage;
  }
  return out;
}

interface JunctionPoint {
  current: number;
  conductance: number;
}

/**
 * ngspice-47 bjtload.c DC currents and their linearisation (polarity domain):
 * collector current cc and base current cb as functions of (vbe, vbc), with
 * dcc/dvbe = gmForward, dcc/dvbc = -gmReverse, dcb/dvbe = gpi, dcb/dvbc = gmu.
 */
interface BJTDCPoint {
  collectorCurrent: number;
  baseCurrent: number;
  gmForward: number;
  gmReverse: number;
  gpi: number;
  gmu: number;
  /** Normalised base charge (bjtload.c qb), for the base resistance gx. */
  qb: number;
}

interface BaseCharge {
  qb: number;
  dqbdve: number;
  dqbdvc: number;
}

/**
 * ngspice-47 bjtload.c normalised base charge and its derivatives (polarity
 * domain): q1 = 1/(1 - vbc/VAF - vbe/VAR), q2 = cbe/IKF + cbc/IKR and
 * qb = q1*(1 + (1 + 4*q2)^NKF)/2, with qb = q1 when both knee currents are
 * omitted (the Ebers-Moll transport model once VAF and VAR are too). An
 * omitted (infinite) VAF, VAR, IKF or IKR has a zero inverse, as in
 * bjttemp.c. Writes into `out` so the stamp hot path does not allocate.
 */
function baseCharge(
  out: BaseCharge, params: BJTParams, vBE: number, vBC: number,
  cbe: number, gbe: number, cbc: number, gbc: number,
): BaseCharge {
  const inverseEarlyF = Number.isFinite(params.VAF) ? 1 / params.VAF : 0;
  const inverseEarlyR = Number.isFinite(params.VAR) ? 1 / params.VAR : 0;
  const inverseRollOffF = Number.isFinite(params.IKF) ? 1 / params.IKF : 0;
  const inverseRollOffR = Number.isFinite(params.IKR) ? 1 / params.IKR : 0;
  const q1 = 1 / (1 - inverseEarlyF * vBC - inverseEarlyR * vBE);
  if (inverseRollOffF === 0 && inverseRollOffR === 0) {
    out.qb = q1;
    out.dqbdve = q1 * q1 * inverseEarlyR;
    out.dqbdvc = q1 * q1 * inverseEarlyF;
    return out;
  }
  const arg = Math.max(0, 1 + 4 * (inverseRollOffF * cbe + inverseRollOffR * cbc));
  const { NKF } = params;
  // bjtsetup.c: NKF given as 0.5 is the same law as the default square root.
  const squareRoot = NKF === 0.5;
  const sqarg = arg === 0 ? 1 : squareRoot ? Math.sqrt(arg) : Math.pow(arg, NKF);
  const qb = q1 * (1 + sqarg) / 2;
  // slope = d(sqarg)/d(q2) / 2 = 2*NKF*sqarg/arg (1/sqarg for the square root).
  const slope = squareRoot ? 1 / sqarg : 2 * sqarg * NKF / arg;
  out.qb = qb;
  out.dqbdve = q1 * (qb * inverseEarlyR + inverseRollOffF * gbe * slope);
  out.dqbdvc = q1 * (qb * inverseEarlyF + inverseRollOffR * gbc * slope);
  return out;
}

/**
 * ngspice-47 bjtload.c base-resistance conductance gx from the base current cb
 * and qb: 1/(RBM + (RB - RBM)/qb), or with IRB the current-crowding law
 * 1/(RBM + 3*(RB - RBM)*(tan z - z)/(z*tan^2 z)). Like ngspice it is not
 * differentiated: the Newton iteration sees it as a linear conductance.
 */
function baseResistanceConductance(params: BJTParams, cb: number, qb: number): number {
  const { RB, RBM, IRB } = params;
  const rbpi = RB - RBM;
  let resistance = RBM + rbpi / qb;
  if (IRB !== 0) {
    const ratio = Math.max(cb / IRB, 1e-9);
    const z = (-1 + Math.sqrt(1 + 14.59025 * ratio)) / 2.4317 / Math.sqrt(ratio);
    const tangent = Math.tan(z);
    resistance = RBM + 3 * rbpi * (tangent - z) / z / tangent / tangent;
  }
  return resistance !== 0 ? 1 / resistance : 0;
}

/**
 * ngspice-47 bjtload.c substrate junction (polarity domain): the ISS diode,
 * with the reverse law below -3*NS*Vt, plus CKTgmin. A gmin current therefore
 * flows through the substrate terminal even when ISS = 0 (#539).
 */
function substrateJunction(vsub: number, saturationCurrent: number, thermalVoltage: number, gmin: number): {
  current: number;
  conductance: number;
} {
  if (vsub <= -3 * thermalVoltage) {
    const ratio = 3 * thermalVoltage / (vsub * Math.E);
    const cube = ratio * ratio * ratio;
    return {
      current: -saturationCurrent * (1 + cube) + gmin * vsub,
      conductance: saturationCurrent * 3 * cube / vsub + gmin,
    };
  }
  const exponential = Math.exp(Math.min(MAX_EXP_ARG, vsub / thermalVoltage));
  return {
    current: saturationCurrent * (exponential - 1) + gmin * vsub,
    conductance: saturationCurrent * exponential / thermalVoltage + gmin,
  };
}

function limitJunctionStep(
  proposedVoltage: number,
  previousVoltage: number,
  thermalVoltage: number,
  saturationCurrent: number,
): number {
  const criticalVoltage = thermalVoltage
    * Math.log(thermalVoltage / (Math.sqrt(2) * saturationCurrent));
  if (proposedVoltage > criticalVoltage
    && Math.abs(proposedVoltage - previousVoltage) > 2 * thermalVoltage) {
    if (previousVoltage > 0) {
      const argument = 1 + (proposedVoltage - previousVoltage) / thermalVoltage;
      return argument > 0
        ? previousVoltage + thermalVoltage * Math.log(argument)
        : criticalVoltage;
    }
    return thermalVoltage * Math.log(proposedVoltage / thermalVoltage);
  }
  if (proposedVoltage < 0) {
    const minimum = previousVoltage > 0
      ? -previousVoltage - 1
      : 2 * previousVoltage - 1;
    return Math.max(proposedVoltage, minimum);
  }
  return proposedVoltage;
}

function junctionStepScale(
  proposedVoltage: number,
  previousVoltage: number,
  thermalVoltage: number,
  saturationCurrent: number,
): number {
  const delta = proposedVoltage - previousVoltage;
  if (delta === 0) return 1;
  const limited = limitJunctionStep(
    proposedVoltage, previousVoltage, thermalVoltage, saturationCurrent,
  );
  return Math.min(1, Math.max(0, (limited - previousVoltage) / delta));
}

export function resolveBJTParams(
  supplied: Partial<BJTParams> & Record<string, number>,
): BJTParams {
  const params: Record<string, number> = {};
  for (const [name, value] of Object.entries(supplied)) {
    params[MODEL_PARAMETER_ALIASES[name] ?? name] = value;
  }
  for (const name of Object.keys(supplied)) {
    if (name !== 'polarity' && !SUPPORTED_MODEL_PARAMETERS.has(name)) {
      throw new Error(`Unsupported bounded BJT model parameter: '${name}'`);
    }
  }

  const polarity = params.polarity ?? 1;
  // ngspice-47 bjtsetup.c: BJTsatCur defaults to 1e-16 A (not the 1e-14 of the diode).
  const saturationCurrent = params.IS ?? 1e-16;
  // bjtsetup.c: an ISE or ISC above 1e-4 is read as a multiple of IS.
  const leakageCurrent = (value: number | undefined) =>
    value === undefined ? 0 : value > 1e-4 ? saturationCurrent * value : value;
  // bjttemp.c: an Early voltage or knee current of 0 (the bjtsetup.c default)
  // means infinite; the inverse is 1/param only when param != 0 (#844).
  const infiniteWhenZero = (value: number | undefined) =>
    value === undefined || value === 0 ? Infinity : value;
  const baseResistance = params.RB ?? 0;
  const resolved: BJTParams = {
    LEVEL: params.LEVEL ?? 1,
    BF: params.BF ?? 100,
    BR: params.BR ?? 1,
    IS: saturationCurrent,
    NF: params.NF ?? 1,
    NR: params.NR ?? 1,
    VAF: infiniteWhenZero(params.VAF),
    IKF: infiniteWhenZero(params.IKF),
    ISE: leakageCurrent(params.ISE),
    NE: params.NE ?? 1.5,
    VAR: infiniteWhenZero(params.VAR),
    IKR: infiniteWhenZero(params.IKR),
    ISC: leakageCurrent(params.ISC),
    NC: params.NC ?? 2,
    // bjtsetup.c: NKF defaults to 0.5 (the square root) and is capped at 1.
    NKF: Math.min(params.NKF ?? 0.5, 1),
    RB: baseResistance,
    TRB1: params.TRB1 ?? 0,
    TRB2: params.TRB2 ?? 0,
    TRM1: params.TRM1 ?? 0,
    TRM2: params.TRM2 ?? 0,
    TRC1: params.TRC1 ?? 0,
    TRC2: params.TRC2 ?? 0,
    TRE1: params.TRE1 ?? 0,
    TRE2: params.TRE2 ?? 0,
    RBM: params.RBM ?? baseResistance,
    IRB: params.IRB ?? 0,
    RC: params.RC ?? 0,
    RCO: params.RCO ?? 0,
    VO: params.VO ?? 10,
    GAMMA: params.GAMMA ?? 1e-11,
    QCO: params.QCO ?? 0,
    RE: params.RE ?? 0,
    KF: params.KF ?? 0,
    AF: params.AF ?? 1,
    CJE: params.CJE ?? 0,
    VJE: params.VJE ?? 0.75,
    MJE: params.MJE ?? 0.33,
    TF: params.TF ?? 0,
    XTF: params.XTF ?? 0,
    VTF: params.VTF ?? 0,
    ITF: params.ITF ?? 0,
    CJC: params.CJC ?? 0,
    VJC: params.VJC ?? 0.75,
    MJC: params.MJC ?? 0.33,
    XCJC: params.XCJC ?? 1,
    TR: params.TR ?? 0,
    CJS: params.CJS ?? 0,
    VJS: params.VJS ?? 0.75,
    MJS: params.MJS ?? 0,
    // ngspice bjttemp.c limits FC to 0.9999.
    FC: Math.min(params.FC ?? 0.5, 0.9999),
    SUBS: params.SUBS ?? (polarity < 0 ? -1 : 1),
    ISS: params.ISS ?? 0,
    NS: params.NS ?? 1,
    TNOM: params.TNOM ?? NOMINAL_TEMPERATURE_C,
    EG: params.EG ?? 1.11,
    XTI: params.XTI ?? 3,
    XTB: params.XTB ?? 0,
    polarity,
  };
  if (resolved.LEVEL !== 1) {
    throw new Error(`Unsupported bounded BJT model level: ${resolved.LEVEL}`);
  }
  if (resolved.BF <= 0 || resolved.BR <= 0 || resolved.IS <= 0
    || resolved.NF <= 0 || resolved.NR <= 0 || resolved.VAF <= 0
    || resolved.IKF <= 0 || resolved.ISE < 0 || resolved.NE <= 0
    || resolved.RB < 0 || !Number.isFinite(resolved.RB)
    || resolved.RC < 0 || !Number.isFinite(resolved.RC)
    || resolved.RE < 0 || !Number.isFinite(resolved.RE)) {
    throw new Error('Invalid bounded BJT model parameter value');
  }
  if (!(resolved.VAR > 0) || !(resolved.IKR > 0) || !(resolved.ISC >= 0)
    || !Number.isFinite(resolved.ISC) || !(resolved.NC > 0) || !Number.isFinite(resolved.NC)
    || !(resolved.NKF > 0)) {
    throw new Error('Invalid bounded BJT model parameter value: expected VAR, IKR, NC, NKF > 0 and ISC >= 0');
  }
  if (!(resolved.RBM >= 0) || !Number.isFinite(resolved.RBM)
    || !(resolved.IRB >= 0) || !Number.isFinite(resolved.IRB)) {
    throw new Error('Invalid bounded BJT base-resistance parameter: expected finite RBM >= 0 and IRB >= 0');
  }
  if (!(resolved.ISS >= 0) || !Number.isFinite(resolved.ISS)
    || !(resolved.NS > 0) || !Number.isFinite(resolved.NS)) {
    throw new Error('Invalid bounded BJT substrate parameter: expected finite ISS >= 0 and NS > 0');
  }
  if (resolved.KF < 0 || !Number.isFinite(resolved.KF)) {
    throw new Error('Invalid bounded BJT noise parameter: expected finite BJT KF >= 0');
  }
  if (resolved.AF <= 0 || !Number.isFinite(resolved.AF)) {
    throw new Error('Invalid bounded BJT noise parameter: expected finite BJT AF > 0');
  }
  validateChargeStorage(resolved, params.PTF ?? 0);
  if (!(resolved.RCO >= 0) || !Number.isFinite(resolved.RCO)
    || (resolved.RCO > 0 && (!(resolved.VO > 0) || !Number.isFinite(resolved.VO)
      || !(resolved.GAMMA >= 0) || !Number.isFinite(resolved.GAMMA)))) {
    throw new Error('Invalid bounded BJT quasi-saturation parameter: expected RCO, GAMMA >= 0 and VO > 0');
  }
  return resolved;
}

/**
 * ngspice-47 bjtload.c base resistance gx = 1/(RBM + (RB - RBM)/qb), or the
 * IRB law, between the base and base-prime nodes. It only differs from a
 * fixed RB when RB > 0 (with RB = 0 bjtsetup.c merges the two nodes) and
 * RBM != RB (rbpi = RB - RBM = 0 leaves gx = 1/RBM = 1/RB whatever IRB is).
 * Such a device stamps gx itself, on a fifth (external base) node.
 *
 * A device with RB > 0 also needs that external base node when XCJC < 1 and
 * CJC > 0: bjtload.c puts the B-C depletion fraction (1 - XCJC)*CJC (qbx,
 * capbx) between the external base and the collector-prime node, outside
 * RB (#861). It then stamps gx itself too (1/RB when RBM = RB). Accepts
 * resolved parameters or the raw model card (RBM defaulting to RB, XCJC to 1).
 */
export function hasBiasDependentBaseResistance(
  params: Partial<Pick<BJTParams, 'RB' | 'RBM' | 'XCJC' | 'CJC' | 'TRB1' | 'TRB2' | 'TRM1' | 'TRM2'>>,
): boolean {
  const baseResistance = params.RB ?? 0;
  if (!(baseResistance > 0)) return false;
  if ((params.RBM ?? baseResistance) !== baseResistance) return true;
  // Equal nominal RB/RBM can separate away from TNOM, including default RBM=RB.
  if ((params.TRB1 ?? 0) !== (params.TRM1 ?? 0)
    || (params.TRB2 ?? 0) !== (params.TRM2 ?? 0)) return true;
  return (params.XCJC ?? 1) < 1 && (params.CJC ?? 0) > 0;
}

/** Gummel-Poon instance geometry: ngspice-47 bjt.c `area`, `areab`, `areac` and `m`. */
export interface BJTInstanceScaling {
  AREA?: number;
  AREAB?: number;
  AREAC?: number;
  M?: number;
  ICVBE?: number;
  ICVCE?: number;
}

/**
 * ngspice-47 bjttemp.c area factor of the B-C junction (BCtSatCur, tBCcap):
 * AREAB for a vertical device (SUBS = 1), AREAC for a lateral one. bjtsetup.c
 * defaults both to AREA. tBCcap = CJC times this factor; BCtSatCur = tSatCur
 * times it, and tSatCur already includes AREA, so by default the B-C
 * saturation current is IS*AREA^2.
 */
export function bjtBaseCollectorArea(subs: number, instance: BJTInstanceScaling | undefined): number {
  const area = instance?.AREA ?? 1;
  return subs === 1 ? instance?.AREAB ?? area : instance?.AREAC ?? area;
}

/** ngspice-47 bjttemp.c area factor of the substrate capacitance (tSubcap): AREAC vertical, AREAB lateral. */
function bjtSubstrateArea(subs: number, instance: BJTInstanceScaling | undefined): number {
  const area = instance?.AREA ?? 1;
  return subs === 1 ? instance?.AREAC ?? area : instance?.AREAB ?? area;
}

/**
 * Apply ngspice-47 instance scaling to resolved Gummel-Poon parameters.
 *
 * bjttemp.c multiplies IS, ISE, ISS, IKF, ITF and CJE (and the RC/RE
 * conductances) by AREA and divides RB by it; CJC by the B-C area and CJS by
 * the substrate area (AREAB/AREAC by SUBS, both defaulting to AREA);
 * bjtload.c then multiplies every stamp by M. For the bounded parameter set
 * both are the same as a device with these parameters scaled by AREA*M. The
 * B-C saturation current (bjttemp.c BCtSatCur = tSatCur * AREAB or AREAC) is
 * applied by the device on top of the scaled IS, see
 * {@link bjtBaseCollectorArea}. Flicker noise is the exception:
 * bjtnoise.c uses M*KF*|Ib/M|^AF, so KF absorbs M^(1-AF). (ngspice also scales
 * its gmin by M; spice-ts keeps its fixed 1e-12 S gmin.)
 */
export function scaleBJTInstance(
  params: BJTParams,
  instance: BJTInstanceScaling | undefined,
): BJTParams {
  const area = instance?.AREA ?? 1;
  const multiplier = instance?.M ?? 1;
  const scale = area * multiplier;
  const collectorScale = bjtBaseCollectorArea(params.SUBS, instance) * multiplier;
  const substrateScale = bjtSubstrateArea(params.SUBS, instance) * multiplier;
  if (scale === 1 && collectorScale === 1 && substrateScale === 1) return params;
  return {
    ...params,
    IS: params.IS * scale,
    ISE: params.ISE * scale,
    ISS: params.ISS * scale,
    IKF: params.IKF * scale,
    IKR: params.IKR * scale,
    ISC: params.ISC * collectorScale,
    IRB: params.IRB * scale,
    ITF: params.ITF * scale,
    CJE: params.CJE * scale,
    CJC: params.CJC * collectorScale,
    CJS: params.CJS * substrateScale,
    RB: params.RB / scale,
    RBM: params.RBM / scale,
    RC: params.RC / scale,
    RE: params.RE / scale,
    KF: params.KF * Math.pow(multiplier, 1 - params.AF),
  };
}

function validateChargeStorage(params: BJTParams, excessPhase: number): void {
  const nonNegative = ['CJE', 'TF', 'XTF', 'ITF', 'CJC', 'TR', 'CJS', 'MJE', 'MJC', 'MJS', 'FC'] as const;
  for (const name of nonNegative) {
    if (!(params[name] >= 0) || !Number.isFinite(params[name])) {
      throw new Error(`Invalid BJT charge-storage parameter: expected finite BJT ${name} >= 0`);
    }
  }
  for (const name of ['VJE', 'VJC', 'VJS'] as const) {
    if (!(params[name] > 0) || !Number.isFinite(params[name])) {
      throw new Error(`Invalid BJT charge-storage parameter: expected finite BJT ${name} > 0`);
    }
  }
  if (!Number.isFinite(params.VTF)) {
    throw new Error('Invalid BJT charge-storage parameter: expected finite BJT VTF');
  }
  if (!(params.XCJC >= 0 && params.XCJC <= 1)) {
    throw new Error('Invalid BJT charge-storage parameter: expected BJT XCJC in [0, 1]');
  }
  if (params.SUBS !== 1 && params.SUBS !== -1) {
    throw new Error('Invalid BJT charge-storage parameter: expected BJT SUBS of 1 or -1');
  }
  if (!Number.isFinite(excessPhase)) {
    throw new Error('Invalid BJT charge-storage parameter: expected finite BJT PTF');
  }
}

export class BJT implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (BJTtrunc: qbe, qbc, qsub; not qbx). */
  readonly truncationCoversCharges = true;
  readonly params: BJTParams;
  readonly suppliedParams: Readonly<Record<string, number>>;
  /** Instance-scaled parameters at TNOM; {@link params} holds them at the device temperature. */
  private readonly nominal: BJTParams;
  private temperature = NOMINAL_TEMPERATURE_C;
  /** B-C area factor: bjttemp.c BCtSatCur = tSatCur * {@link bjtBaseCollectorArea}. */
  private readonly baseCollectorArea: number;
  /** B-C saturation current at the device temperature (bjttemp.c BCtSatCur, times M). */
  private baseCollectorSatCur: number;
  /** Thermal voltage kT/q at the device temperature (bjttemp.c vt). */
  private vt = CONSTKOVERQ * (NOMINAL_TEMPERATURE_C + CONSTCTOK);
  /**
   * Present only when the model stores charge, so charge-free BJTs keep the
   * transient driver's static-current history path unchanged.
   */
  readonly stampDynamic?: (ctx: StampContext) => void;
  /**
   * Charge-storing BJTs integrate qbe (with its dQbe/dVbc cross term), qbc,
   * qsub and qbx themselves in transient analysis, as ngspice bjtload.c
   * NIintegrates them.
   */
  readonly integratesTransientCharge: boolean;
  private readonly charges = new TransientChargeState(4);
  private readonly chargePoint: BJTChargePoint = {
    nodeVBE: 0, nodeVBC: 0, vSub: 0, substrateNode: -1,
    qBE: 0, capBE: 0, crossCapacitance: 0, qBC: 0, capBC: 0, qSub: 0, capSub: 0,
    nodeVBX: 0, qBX: 0, capBX: 0,
  };
  private readonly junction: JunctionPoint = { current: 0, conductance: 0 };
  private readonly dcPoint: BJTDCPoint = {
    collectorCurrent: 0, baseCurrent: 0, gmForward: 0, gmReverse: 0, gpi: 0, gmu: 0, qb: 1,
  };
  private readonly charge: BaseCharge = { qb: 1, dqbdve: 0, dqbdvc: 0 };
  /** Linearisation point of the last stamp (ngspice CKTstate0 vbe/vbc/cc/cb/gm/go/gpi/gmu) for bjtconv.c. */
  private readonly lastLoad = {
    vBE: 0, vBC: 0, collectorCurrent: 0, baseCurrent: 0,
    gmForward: 0, gmReverse: 0, gpi: 0, gmu: 0,
  };
  /**
   * Bias-dependent base resistance (RBM != RB, see
   * {@link hasBiasDependentBaseResistance}): the device stamps gx itself
   * between the external base (5th node) and the base-prime node (2nd node).
   */
  private readonly stampsBaseResistance: boolean;
  /** Instance multiplier M: ngspice tSatCur, and so tVcrit, excludes it. */
  private readonly multiplier: number;
  /** ngspice-47 bjttemp.c BJTtVcrit and BJTtSubVcrit (50 V without ISS) at the device temperature. */
  private criticalVoltage = 0;
  private substrateCriticalVoltage = 50;
  /**
   * Transient Newton junction state (ngspice bjtload.c): `iterate` is
   * CKTstate0 (the limited junction voltages of the last load), `accepted`
   * CKTstate1 and `prior` CKTstate2, with `acceptedStep` CKTdeltaOld[1].
   * Indices are BASE_EMITTER, BASE_COLLECTOR and SUBSTRATE.
   */
  private readonly iterateJunctions = new Float64Array(3);
  /** Junction voltages the present transient load linearises at. */
  private readonly limitedJunctions = new Float64Array(3);
  private readonly acceptedJunctions = new Float64Array(3);
  private readonly priorJunctions = new Float64Array(3);
  private readonly newtonJunctions = new Float64Array(3);
  private hasAcceptedJunctions = false;
  private hasPriorJunctions = false;
  private acceptedStep: number | undefined;
  /** bjtload.c cexbc state0/1/2. Only accepted steps rotate the delay history. */
  private delayCurrent = 0;
  private acceptedDelayCurrent = 0;
  private priorDelayCurrent = 0;

  private get excessPhaseDelay(): number {
    return ((this.suppliedParams.PTF ?? 0) / (180 / Math.PI)) * this.params.TF;
  }
  /** Between beginTransientNewton and the next accepted point. */
  private inTransientNewton = false;
  /** The next load is the first iterate of a timepoint (MODEINITPRED). */
  private predictJunctions = false;
  /** {@link newtonJunctions} holds an unused undamped Newton solve. */
  private hasNewtonJunctions = false;
  /** Whether the last load limited a junction (ngspice icheck -> CKTnoncon). */
  private limited = false;
  /**
   * The transient charges of this iteration are evaluated at the limited
   * junction voltages the load linearised at (bjtload.c computes qbe, qbc
   * and qsub after DEVpnjlim), not at the node voltages.
   */
  private chargesAtLimitedJunctions = false;
  /**
   * Transient Newton leaves the BJT nodes undamped: like ngspice, the device
   * limits its own junctions against the previous iterate (DEVpnjlim).
   */
  readonly limitsOwnJunctions = true;

  constructor(
    readonly name: string,
    readonly nodes: number[],
    params: Partial<BJTParams> & Record<string, number>,
    private readonly instance?: BJTInstanceScaling,
    /** External C/B/E for BJTgetic; stamping nodes may be internal primes. */
    private readonly icTerminals?: readonly number[],
  ) {
    this.suppliedParams = { ...params };
    const resolved = resolveBJTParams(params);
    // tSatCur already carries AREA, so the default B-C current is IS*AREA^2 (*M).
    this.baseCollectorArea = bjtBaseCollectorArea(resolved.SUBS, instance);
    this.nominal = scaleBJTInstance(resolved, instance);
    this.multiplier = instance?.M ?? 1;
    this.params = { ...this.nominal };
    this.baseCollectorSatCur = this.nominal.IS * this.baseCollectorArea;
    this.applyTemperature();
    this.stampsBaseResistance = hasBiasDependentBaseResistance(this.nominal);
    if (this.stampsBaseResistance !== (nodes[4] !== undefined && nodes[4] !== nodes[1])) {
      throw new Error(
        `BJT '${name}' needs ${this.stampsBaseResistance ? 'an' : 'no'} external base node for its base resistance`,
      );
    }
    const { CJE, CJC, CJS, TF, TR } = this.params;
    this.integratesTransientCharge = CJE > 0 || CJC > 0 || CJS > 0 || TF > 0 || TR > 0;
    if (this.integratesTransientCharge || (this.params.RCO > 0 && this.params.QCO !== 0)) {
      this.stampDynamic = ctx => this.stampChargeStorage(ctx);
    }
  }

  setTemperature(value: number): void {
    this.temperature = value;
    this.applyTemperature();
  }

  getTemperature(): number {
    return this.temperature;
  }

  /** Unscaled model values for bounded DC sensitivity. */
  sensitivityModelParameters(): BJTParams {
    return resolveBJTParams(this.suppliedParams);
  }

  /** Rebuild cached thermal/geometry data without mutating the nominal device. */
  withSensitivityParameter(parameter: 'IS' | 'BF' | 'NF' | 'VAF' | 'BR' | 'NR' | 'M', value: number): BJT {
    const model = parameter === 'M' ? this.suppliedParams : { ...this.suppliedParams, [parameter]: value };
    const instance = parameter === 'M' ? { ...this.instance, M: value } : this.instance;
    const copy = new BJT(this.name, this.nodes, model, instance, this.icTerminals);
    copy.setTemperature(this.temperature);
    return copy;
  }

  get sensitivityMultiplier(): number {
    return this.multiplier;
  }

  /**
   * ngspice-47 bjttemp.c (TLEV = TLEVC = 0) at the device temperature:
   * IS and ISS scale by exp(factlog), factlog = (T/TNOM - 1)*EG/vt +
   * XTI*ln(T/TNOM); BF and BR by bfactor = (T/TNOM)^XTB; ISE by
   * exp(factlog/NE)/bfactor and ISC by exp(factlog/NC)/bfactor; the B-E, B-C
   * and substrate junction potentials and capacitances by the REFTEMP-mapped
   * band-gap law. VAF, VAR, IKF, IKR, IRB, the transit times and the
   * resistances have no law without their T* coefficients. RB/RBM/RC/RE use
   * 1 + T1*dT + T2*dT^2, independently for each resistance. At T = TNOM every
   * factor is exactly 1.
   */
  private applyTemperature(): void {
    assertNoUnsupportedTemperatureParameters(
      this.name, this.suppliedParams, UNSUPPORTED_TEMPERATURE_PARAMETERS,
      this.temperature, this.nominal.TNOM,
    );
    const nominal = this.nominal;
    const params = this.params;
    const kelvin = this.temperature + CONSTCTOK;
    const nominalKelvin = nominal.TNOM + CONSTCTOK;
    this.vt = CONSTKOVERQ * kelvin;
    if (kelvin === nominalKelvin) {
      Object.assign(params, nominal);
      this.baseCollectorSatCur = params.IS * this.baseCollectorArea;
      this.updateCriticalVoltages();
      return;
    }
    const ratlog = Math.log(kelvin / nominalKelvin);
    const dt = this.temperature - nominal.TNOM;
    params.RB = nominal.RB * (1 + nominal.TRB1 * dt + nominal.TRB2 * dt * dt);
    params.RBM = nominal.RBM * (1 + nominal.TRM1 * dt + nominal.TRM2 * dt * dt);
    params.RC = nominal.RC * (1 + nominal.TRC1 * dt + nominal.TRC2 * dt * dt);
    params.RE = nominal.RE * (1 + nominal.TRE1 * dt + nominal.TRE2 * dt * dt);
    const factlog = (kelvin / nominalKelvin - 1) * nominal.EG / this.vt + nominal.XTI * ratlog;
    const bfactor = Math.exp(ratlog * nominal.XTB);
    params.IS = nominal.IS * Math.exp(factlog);
    this.baseCollectorSatCur = params.IS * this.baseCollectorArea;
    params.ISS = nominal.ISS * Math.exp(factlog);
    params.ISE = nominal.ISE * Math.exp(factlog / nominal.NE) / bfactor;
    params.ISC = nominal.ISC * Math.exp(factlog / nominal.NC) / bfactor;
    params.BF = nominal.BF * bfactor;
    params.BR = nominal.BR * bfactor;
    // bjttemp.c: QUASIMOD=0 keeps the epi parameters temperature independent.
    const ratio = kelvin / nominalKelvin;
    const quasiTemperature = this.suppliedParams.QUASIMOD === 1;
    params.RCO = quasiTemperature
      ? nominal.RCO * Math.pow(ratio, this.suppliedParams.CN ?? (params.polarity > 0 ? 2.42 : 2.2))
      : nominal.RCO;
    params.VO = quasiTemperature
      ? nominal.VO * Math.pow(ratio, this.suppliedParams.D ?? (params.polarity > 0 ? 0.87 : 0.52))
      : nominal.VO;
    params.GAMMA = quasiTemperature
      ? nominal.GAMMA * Math.pow(ratio, nominal.XTI)
        * Math.exp(-(this.suppliedParams.VG ?? 1.206) * (1 - ratio) / this.vt)
      : nominal.GAMMA;
    const junction = (potential: number, capacitance: number, grading: number) =>
      temperatureJunction(potential, capacitance, grading, kelvin, nominalKelvin);
    const emitter = junction(nominal.VJE, nominal.CJE, nominal.MJE);
    const collector = junction(nominal.VJC, nominal.CJC, nominal.MJC);
    const substrate = junction(nominal.VJS, nominal.CJS, nominal.MJS);
    params.VJE = emitter.potential;
    params.CJE = emitter.capacitance;
    params.VJC = collector.potential;
    params.CJC = collector.capacitance;
    params.VJS = substrate.potential;
    params.CJS = substrate.capacitance;
    this.updateCriticalVoltages();
  }

  /** bjttemp.c: tVcrit = vt*ln(vt/(sqrt(2)*tSatCur)), tSatCur without M; likewise tSubVcrit. */
  private updateCriticalVoltages(): void {
    const { IS, ISS } = this.params;
    const vt = this.vt;
    this.criticalVoltage = vt * Math.log(vt / (Math.SQRT2 * IS / this.multiplier));
    this.substrateCriticalVoltage = ISS > 0
      ? vt * Math.log(vt / (Math.SQRT2 * ISS / this.multiplier))
      : 50;
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const point = this.evaluateCharges(ctx, this.chargesAtLimitedJunctions);
    const charges = this.charges;
    charges.begin(integration);
    const { polarity } = this.params;
    const [nC, nB, nE] = this.nodes;
    const factor = charges.factor;
    // Physical branch quantities are the polarity-domain ones times the sign.
    // The charges are functions of the node junction voltages, so a converged
    // point carries exactly the integrated current.
    const crossConductance = factor * point.crossCapacitance;
    const emitterChargeCurrent = charges.current(BASE_EMITTER, point.qBE);
    const collectorChargeCurrent = charges.current(BASE_COLLECTOR, point.qBC);
    const emitterChargeConductance = factor * point.capBE;
    const collectorChargeConductance = factor * point.capBC;
    // bjtload.c adds the integrated qbe/qbc currents and conductances to the
    // stored cc, cb, gpi and gmu that bjtconv.c tests: gpi += geq(qbe),
    // gmu += geq(qbc), cb += cqbe + cqbc, cc -= cqbc (polarity domain).
    const load = this.lastLoad;
    load.baseCurrent += emitterChargeCurrent + collectorChargeCurrent;
    load.collectorCurrent -= collectorChargeCurrent;
    load.gpi += emitterChargeConductance;
    load.gmu += collectorChargeConductance;
    load.gmReverse += collectorChargeConductance;
    stampChargeBranch(
      ctx, nB, nE,
      polarity * emitterChargeCurrent - crossConductance * polarity * point.nodeVBC,
      emitterChargeConductance, polarity * point.nodeVBE,
    );
    if (crossConductance !== 0) {
      // dQbe/dVbc: the B-E charge current is controlled by the B-C voltage.
      if (nB >= 0) {
        ctx.stampG(nB, nB, crossConductance);
        if (nC >= 0) ctx.stampG(nB, nC, -crossConductance);
      }
      if (nE >= 0) {
        if (nB >= 0) ctx.stampG(nE, nB, -crossConductance);
        if (nC >= 0) ctx.stampG(nE, nC, crossConductance);
      }
    }
    stampChargeBranch(
      ctx, nB, nC, polarity * collectorChargeCurrent,
      collectorChargeConductance, polarity * point.nodeVBC,
    );
    // Substrate charge between the substrate-connect node and the substrate
    // terminal: its voltage is -type*subs*vsub.
    const substrateSign = -polarity * this.params.SUBS;
    stampChargeBranch(
      ctx, point.substrateNode, this.substrateNode,
      substrateSign * charges.current(SUBSTRATE, point.qSub),
      factor * point.capSub, substrateSign * point.vSub,
    );
    // bjtload.c qbx (geqbx, ceqbx) from the external base to the collector
    // prime. Its current is not part of cb/cc, so bjtconv.c does not see it.
    stampChargeBranch(
      ctx, this.externalBaseNode, nC, polarity * charges.current(EXTERNAL_BASE_COLLECTOR, point.qBX),
      factor * point.capBX, polarity * point.nodeVBX,
    );
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    const { polarity, SUBS } = this.params;
    const [nC, nB, nE] = this.nodes;
    const charges = this.charges;
    stampChargeCurrent(ctx, nB, nE, polarity * charges.acceptedChargeCurrent(BASE_EMITTER));
    stampChargeCurrent(ctx, nB, nC, polarity * charges.acceptedChargeCurrent(BASE_COLLECTOR));
    stampChargeCurrent(
      ctx, SUBS === 1 ? nC : nB, this.substrateNode,
      -polarity * SUBS * charges.acceptedChargeCurrent(SUBSTRATE),
    );
    stampChargeCurrent(
      ctx, this.externalBaseNode, nC, polarity * charges.acceptedChargeCurrent(EXTERNAL_BASE_COLLECTOR),
    );
  }

  acceptTransientStep(ctx: StampContext): void {
    if (this.excessPhaseDelay !== 0) {
      if (this.inTransientNewton && this.hasAcceptedJunctions) {
        this.priorDelayCurrent = this.acceptedDelayCurrent;
        this.acceptedDelayCurrent = this.delayCurrent;
      } else {
        // MODEINITTRAN: both past cexbc states start at cbe/qb, also with UIC.
        this.acceptJunctions(ctx);
        const vbe = this.acceptedJunctions[BASE_EMITTER];
        const vbc = this.acceptedJunctions[BASE_COLLECTOR];
        const { qb } = this.evaluateDC(vbe, vbc, ctx.gmin ?? DEVICE_GMIN);
        const cbe = junctionLaw(this.junction, vbe, this.params.IS, this.params.NF * this.vt).current;
        this.delayCurrent = this.acceptedDelayCurrent = this.priorDelayCurrent = cbe / qb;
        this.acceptCharges(ctx);
        return;
      }
    }
    this.acceptJunctions(ctx);
    this.acceptCharges(ctx);
  }

  /**
   * Commit the accepted junction voltages (ngspice CKTstate1 after the state
   * rotation). The operating point restarts the history, so the first
   * transient step starts from it unextrapolated (MODEINITTRAN).
   */
  private acceptJunctions(ctx: StampContext): void {
    if (this.inTransientNewton && this.hasAcceptedJunctions) {
      this.priorJunctions.set(this.acceptedJunctions);
      this.hasPriorJunctions = true;
      this.acceptedStep = ctx.dt;
    } else {
      this.hasPriorJunctions = false;
      this.acceptedStep = undefined;
    }
    this.nodeJunctions(this.acceptedJunctions, ctx, contextVoltage);
    if (ctx.initialUIC) {
      // bjtgetic.c reads external terminal differences, not the prime
      // nodes used for junction stamping after series-resistance expansion.
      // The mapping is optional for directly constructed devices.
      const nC = this.icTerminals?.[0] ?? this.nodes[0];
      const nB = this.icTerminals?.[1] ?? this.externalBaseNode;
      const nE = this.icTerminals?.[2] ?? this.nodes[2];
      const voltage = (node: number): number => node >= 0 ? ctx.getVoltage(node) : 0;
      const vBE = this.instance?.ICVBE ?? (voltage(nB) - voltage(nE));
      const vCE = this.instance?.ICVCE ?? (voltage(nC) - voltage(nE));
      this.acceptedJunctions[BASE_EMITTER] = this.params.polarity * vBE;
      this.acceptedJunctions[BASE_COLLECTOR] = this.params.polarity * (vBE - vCE);
      this.acceptedJunctions[SUBSTRATE] = 0;
    }
    this.hasAcceptedJunctions = true;
    this.inTransientNewton = false;
    this.predictJunctions = false;
    this.hasNewtonJunctions = false;
    this.chargesAtLimitedJunctions = false;
    this.limited = false;
  }

  /** Polarity-domain vbe, vbc and vsub (bjtload.c) at the node voltages `voltage`. */
  private nodeJunctions<T>(out: Float64Array, source: T, voltage: (source: T, node: number) => number): void {
    const { polarity, SUBS } = this.params;
    const [nC, nB, nE] = this.nodes;
    const substrateConnect = SUBS === 1 ? nC : nB;
    out[BASE_EMITTER] = polarity * (voltage(source, nB) - voltage(source, nE));
    out[BASE_COLLECTOR] = polarity * (voltage(source, nB) - voltage(source, nC));
    out[SUBSTRATE] = polarity * SUBS * (voltage(source, this.substrateNode) - voltage(source, substrateConnect));
  }

  private acceptCharges(ctx: StampContext): void {
    if (!this.integratesTransientCharge) return;
    const point = this.evaluateCharges(ctx, false);
    const charges = this.charges;
    charges.accept(BASE_EMITTER, point.qBE);
    charges.accept(BASE_COLLECTOR, point.qBC);
    charges.accept(SUBSTRATE, point.qSub);
    charges.accept(EXTERNAL_BASE_COLLECTOR, point.qBX);
    charges.commit();
  }

  resetTransient(): void {
    this.charges.reset();
    this.delayCurrent = this.acceptedDelayCurrent = this.priorDelayCurrent = 0;
    this.hasAcceptedJunctions = false;
    this.hasPriorJunctions = false;
    this.acceptedStep = undefined;
    this.inTransientNewton = false;
    this.predictJunctions = false;
    this.hasNewtonJunctions = false;
    this.chargesAtLimitedJunctions = false;
    this.limited = false;
  }

  /**
   * ngspice MODEINITPRED copies CKTstate1 into CKTstate0, so a new or retried
   * timepoint limits its first iterate against the accepted junctions.
   */
  beginTransientNewton(): void {
    if (this.hasAcceptedJunctions) this.iterateJunctions.set(this.acceptedJunctions);
    this.inTransientNewton = this.hasAcceptedJunctions;
    this.predictJunctions = this.hasAcceptedJunctions;
    this.hasNewtonJunctions = false;
  }

  /**
   * Limit the next iterate from the undamped Newton solve: node damping of a
   * shared node may hold a terminal back, and limiting against that lagging
   * node would ratchet the junction away from the Newton step.
   */
  observeTransientNewton(solution: Float64Array): void {
    if (!this.inTransientNewton) return;
    this.nodeJunctions(this.newtonJunctions, solution, solutionVoltage);
    this.hasNewtonJunctions = true;
  }

  limitedLastStamp(): boolean {
    return this.limited;
  }

  /**
   * ngspice-47 bjtload.c transient junction voltages: the first iterate of a
   * timepoint extrapolates the two accepted points (MODEINITPRED, xfact =
   * CKTdelta/CKTdeltaOld[1]); every iterate is then limited against the
   * previous one (CKTstate0) with DEVpnjlim at vt and tVcrit (tSubVcrit, or
   * 50 V without ISS, for vsub), and the limited voltages become CKTstate0.
   * A limited iterate is not converged (icheck -> CKTnoncon). Writes the
   * polarity-domain vbe, vbc and vsub into `out`.
   */
  private transientJunctions(out: Float64Array, ctx: StampContext): void {
    if (this.predictJunctions) {
      // vbe and vbc are extrapolated; vsub is read from the last solution
      // (CKTrhsOld), here the accepted point, and only limited.
      this.nodeJunctions(out, ctx, contextVoltage);
      const accepted = this.acceptedJunctions;
      const step = this.acceptedStep;
      if (this.hasPriorJunctions && step !== undefined && step > 0 && ctx.dt > 0) {
        const ratio = ctx.dt / step;
        const prior = this.priorJunctions;
        out[BASE_EMITTER] = (1 + ratio) * accepted[BASE_EMITTER] - ratio * prior[BASE_EMITTER];
        out[BASE_COLLECTOR] = (1 + ratio) * accepted[BASE_COLLECTOR] - ratio * prior[BASE_COLLECTOR];
      } else {
        out[BASE_EMITTER] = accepted[BASE_EMITTER];
        out[BASE_COLLECTOR] = accepted[BASE_COLLECTOR];
      }
    } else if (this.hasNewtonJunctions) {
      out.set(this.newtonJunctions);
    } else {
      this.nodeJunctions(out, ctx, contextVoltage);
    }
    this.predictJunctions = false;
    this.hasNewtonJunctions = false;
    const iterate = this.iterateJunctions;
    const vt = this.vt;
    const vbe = pnjlim(out[BASE_EMITTER], iterate[BASE_EMITTER], vt, this.criticalVoltage);
    const vbc = pnjlim(out[BASE_COLLECTOR], iterate[BASE_COLLECTOR], vt, this.criticalVoltage);
    const vsub = pnjlim(out[SUBSTRATE], iterate[SUBSTRATE], vt, this.substrateCriticalVoltage);
    this.limited = vbe !== out[BASE_EMITTER] || vbc !== out[BASE_COLLECTOR] || vsub !== out[SUBSTRATE];
    out[BASE_EMITTER] = vbe;
    out[BASE_COLLECTOR] = vbc;
    out[SUBSTRATE] = vsub;
    iterate.set(out);
  }

  /** ngspice BJTtrunc: qbe, qbc and qsub; qbx is integrated but not truncated. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptCharges(ctx), TRUNCATED_CHARGES);
  }

  limitNewtonStep(previous: Float64Array, candidate: Float64Array): number {
    const { NF, NR, IS, ISS, NS, SUBS, polarity } = this.params;
    const [nC, nB, nE] = this.nodes;
    const voltage = (solution: Float64Array, node: number): number =>
      node >= 0 ? solution[node] : 0;
    const junction = (solution: Float64Array, positive: number, negative: number): number =>
      polarity * (voltage(solution, positive) - voltage(solution, negative));

    const scale = Math.min(
      junctionStepScale(
        junction(candidate, nB, nE), junction(previous, nB, nE), NF * this.vt, IS,
      ),
      junctionStepScale(
        junction(candidate, nB, nC), junction(previous, nB, nC), NR * this.vt, IS,
      ),
    );
    if (ISS === 0) return scale;
    // ngspice bjtload.c DEVpnjlim on vsub with tSubVcrit (from ISS and NS).
    const substrate = this.substrateNode;
    const substrateConnect = SUBS === 1 ? nC : nB;
    return Math.min(scale, junctionStepScale(
      SUBS * junction(candidate, substrate, substrateConnect),
      SUBS * junction(previous, substrate, substrateConnect),
      NS * this.vt, ISS,
    ));
  }

  /** Substrate terminal (the optional 4th node); omitted, it is ground as in ngspice. */
  private get substrateNode(): number {
    return this.nodes[3] ?? -1;
  }

  /**
   * ngspice BJTbaseNode: the external base (5th node) when the device stamps
   * its base resistance, otherwise the base node itself (RB expanded into a
   * resistor, or RB = 0 where bjtsetup.c merges base and base prime).
   */
  private get externalBaseNode(): number {
    return this.nodes[4] ?? this.nodes[1];
  }

  /**
   * ngspice-47 bjtload.c DC evaluation at the polarity-domain junction
   * voltages: cbe from tSatCur and cbc from BCtSatCur, the B-E leakage cben
   * from ISE/NE and the B-C leakage cbcn from ISC/NC, CKTgmin*vbe in cben and
   * CKTgmin*vbc in cbcn, so the gmin current flows at convergence as in
   * ngspice, not only in the Jacobian (#551), and the base charge qb of
   * {@link baseCharge}. Writes into a reused object.
   */
  private evaluateDC(vBE: number, vBC: number, gmin: number, dt = 0): BJTDCPoint {
    const { BF, BR, IS, NF, NR, ISE, NE, ISC, NC } = this.params;
    const { current: cbe, conductance: gbe } = junctionLaw(this.junction, vBE, IS, NF * this.vt);
    const { current: cbc, conductance: gbc } = junctionLaw(
      this.junction, vBC, this.baseCollectorSatCur, NR * this.vt,
    );
    let cben = gmin * vBE;
    let gben = gmin;
    if (ISE !== 0) {
      const leakage = junctionLaw(this.junction, vBE, ISE, NE * this.vt);
      cben += leakage.current;
      gben += leakage.conductance;
    }
    let cbcn = gmin * vBC;
    let gbcn = gmin;
    if (ISC !== 0) {
      const leakage = junctionLaw(this.junction, vBC, ISC, NC * this.vt);
      cbcn += leakage.current;
      gbcn += leakage.conductance;
    }

    const { qb, dqbdve, dqbdvc } = baseCharge(this.charge, this.params, vBE, vBC, cbe, gbe, cbc, gbc);
    const transport = cbe - cbc;
    const go = (gbc + transport * dqbdvc / qb) / qb;
    const gm = (gbe - transport * dqbdve / qb) / qb - go;
    const point = this.dcPoint;
    point.collectorCurrent = transport / qb - cbc / BR - cbcn;
    point.baseCurrent = cbe / BF + cben + cbc / BR + cbcn;
    point.gpi = gbe / BF + gben;
    point.gmu = gbc / BR + gbcn;
    point.gmForward = gm + go;
    point.gmReverse = point.gmu + go;
    point.qb = qb;
    const td = this.excessPhaseDelay;
    if (dt > 0 && td !== 0) {
      // ngspice-47 bjtload.c Weil approximation, always backward Euler,
      // independent of the charge integrator. Rejected/Newton trials never
      // mutate state1/2; the current state0 is overwritten on every load.
      const ratio = dt / td;
      const arg2 = 3 * ratio;
      const arg1 = arg2 * ratio;
      const denom = 1 + arg1 + arg2;
      const factor = arg1 / denom;
      const stepRatio = dt / (this.acceptedStep ?? dt);
      const history = (this.acceptedDelayCurrent * (1 + stepRatio + arg2)
        - this.priorDelayCurrent * stepRatio) / denom;
      const cex = cbe * factor;
      this.delayCurrent = history + cex / qb;
      point.collectorCurrent = history + (cex - cbc) / qb - cbc / BR - cbcn;
      const delayedGo = (gbc + (cex - cbc) * dqbdvc / qb) / qb;
      point.gmForward = (gbe * factor - (cex - cbc) * dqbdve / qb) / qb;
      point.gmReverse = point.gmu + delayedGo;
    }
    return point;
  }

  /**
   * ngspice-47 bjtconv.c: the collector and base currents predicted at the new
   * Newton solution from the last load's linearisation must match the loaded
   * currents within RELTOL*max + ABSTOL, in DC and transient alike. In
   * transient the stored currents and conductances include the integrated
   * qbe/qbc terms ({@link stampTransientCharge}), as bjtload.c stores them.
   */
  convergenceTest(solution: Float64Array, tolerances: ConvergenceTolerances): boolean {
    const load = this.lastLoad;
    const { polarity } = this.params;
    const [nC, nB, nE] = this.nodes;
    const deltaVBE = polarity * (solutionVoltage(solution, nB) - solutionVoltage(solution, nE)) - load.vBE;
    const deltaVBC = polarity * (solutionVoltage(solution, nB) - solutionVoltage(solution, nC)) - load.vBC;
    const cc = load.collectorCurrent;
    const cchat = cc + load.gmForward * deltaVBE - load.gmReverse * deltaVBC;
    if (Math.abs(cchat - cc) > tolerances.reltol * Math.max(Math.abs(cchat), Math.abs(cc)) + tolerances.abstol) {
      return false;
    }
    const cb = load.baseCurrent;
    const cbhat = cb + load.gpi * deltaVBE + load.gmu * deltaVBC;
    return Math.abs(cbhat - cb) <= tolerances.reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + tolerances.abstol;
  }

  noiseOperatingPoint(solution: Float64Array, gmin = DEVICE_GMIN): {
    collectorNode: number;
    baseNode: number;
    emitterNode: number;
    collectorCurrent: number;
    baseCurrent: number;
    baseConductance: number;
  } {
    const { polarity } = this.params;
    const [collectorNode, baseNode, emitterNode] = this.nodes;
    const voltage = (node: number): number => node >= 0 ? solution[node] : 0;
    const { collectorCurrent, baseCurrent, qb } = this.evaluateDC(
      polarity * (voltage(baseNode) - voltage(emitterNode)),
      polarity * (voltage(baseNode) - voltage(collectorNode)),
      gmin,
    );
    return {
      collectorNode,
      baseNode,
      emitterNode,
      collectorCurrent: Math.abs(collectorCurrent),
      baseCurrent: Math.abs(baseCurrent),
      baseConductance: this.params.RB > 0
        ? baseResistanceConductance(this.params, baseCurrent, qb) : 0,
    };
  }

  stamp(ctx: StampContext): void {
    this.stampLoad(ctx, true);
  }

  /**
   * AC, noise and pole-zero matrix (ngspice-47 bjtacld.c / bjtpzld.c): the
   * bjtload.c conductances without the substrate diode. Neither routine stamps
   * gdsub (not even its CKTgmin), so the substrate terminal only sees the
   * substrate capacitance there, even with a forward-biased ISS junction (#767).
   */
  stampSmallSignal(ctx: StampContext): void {
    this.stampLoad(ctx, false);
  }

  get frequencyDependent(): boolean {
    return this.excessPhaseDelay !== 0;
  }

  /** bjtacld.c rotates gm+go only; go and base currents remain undelayed. */
  stampFrequencyConductance(ctx: StampContext, omega: number): void {
    const [c, b, e] = this.nodes;
    const { polarity } = this.params;
    const voltage = (node: number): number => node >= 0 ? ctx.getVoltage(node) : 0;
    const dc = this.evaluateDC(
      polarity * (voltage(b) - voltage(e)),
      polarity * (voltage(b) - voltage(c)), ctx.gmin ?? DEVICE_GMIN,
    );
    const angle = omega * this.excessPhaseDelay;
    const real = dc.gmForward * (Math.cos(angle) - 1);
    const imaginary = omega === 0 ? -dc.gmForward * this.excessPhaseDelay
      : -dc.gmForward * Math.sin(angle) / omega;
    for (const [row, rowSign] of [[c, 1], [e, -1]]) {
      for (const [col, colSign] of [[b, 1], [e, -1]]) {
        if (row < 0 || col < 0) continue;
        ctx.stampG(row, col, rowSign * colSign * real);
        ctx.stampC(row, col, rowSign * colSign * imaginary);
      }
    }
  }

  private stampLoad(ctx: StampContext, substrateJunction: boolean): void {
    const { polarity } = this.params;
    const [nC, nB, nE] = this.nodes;

    // Get node voltages
    const vC = nC >= 0 ? ctx.getVoltage(nC) : 0;
    const vB = nB >= 0 ? ctx.getVoltage(nB) : 0;
    const vE = nE >= 0 ? ctx.getVoltage(nE) : 0;

    // Junction voltages (polarity flips for PNP). No clamp: DC Newton steps
    // are limited relative to the previous iterate in limitNewtonStep (#538);
    // transient Newton limits them here, as bjtload.c does (#818).
    let vBE = polarity * (vB - vE);
    let vBC = polarity * (vB - vC);
    this.limited = false;
    this.chargesAtLimitedJunctions = false;
    if (this.inTransientNewton && substrateJunction) {
      const junctions = this.limitedJunctions;
      this.transientJunctions(junctions, ctx);
      vBE = junctions[BASE_EMITTER];
      vBC = junctions[BASE_COLLECTOR];
      this.chargesAtLimitedJunctions = true;
    }

    const dc = this.evaluateDC(
      vBE, vBC, ctx.gmin ?? DEVICE_GMIN, this.inTransientNewton && substrateJunction ? ctx.dt : 0,
    );
    const IC = dc.collectorCurrent;
    const IB = dc.baseCurrent;
    const gm_f = dc.gmForward;
    const gm_r = dc.gmReverse;
    const go_be = dc.gpi;
    const go_bc = dc.gmu;
    const load = this.lastLoad;
    load.vBE = vBE;
    load.vBC = vBC;
    load.collectorCurrent = IC;
    load.baseCurrent = IB;
    load.gmForward = gm_f;
    load.gmReverse = gm_r;
    load.gpi = go_be;
    load.gmu = go_bc;

    // Equivalent currents for Newton-Raphson companion model
    // For IC: IC_eq = IC - gm_f * vBE + gm_r * vBC
    const IC_eq = IC - gm_f * vBE + gm_r * vBC;
    // For IB: IB_eq = IB - go_be * vBE - go_bc * vBC
    const IB_eq = IB - go_be * vBE - go_bc * vBC;

    // Now stamp. The actual node currents include polarity:
    // Physical IC_node = polarity * IC(vBE, vBC) flowing into collector
    // Physical IB_node = polarity * IB(vBE, vBC) flowing into base
    //
    // Since vBE = polarity*(vB - vE) and vBC = polarity*(vB - vC):
    // dvBE/dvB = polarity, dvBE/dvE = -polarity
    // dvBC/dvB = polarity, dvBC/dvC = -polarity
    //
    // For collector current (convention: current INTO node is positive in KCL → stamp negative):
    // IC_node = polarity * (gm_f * vBE - gm_r * vBC + IC_eq)
    //
    // dIC_node/dvB = polarity * (gm_f * polarity - gm_r * polarity) = (gm_f - gm_r)
    // dIC_node/dvE = polarity * (gm_f * (-polarity)) = -gm_f
    // dIC_node/dvC = polarity * (-gm_r * (-polarity)) = gm_r
    //
    // Similarly for IB_node = polarity * (go_be * vBE + go_bc * vBC + IB_eq)
    // dIB_node/dvB = polarity * (go_be * polarity + go_bc * polarity) = (go_be + go_bc)
    // dIB_node/dvE = polarity * (go_be * (-polarity)) = -go_be
    // dIB_node/dvC = polarity * (go_bc * (-polarity)) = -go_bc

    // IE_node = -(IC_node + IB_node) by KCL
    // dIE_node/dvB = -(gm_f - gm_r + go_be + go_bc)
    // dIE_node/dvE = -(-gm_f - go_be) = gm_f + go_be
    // dIE_node/dvC = -(gm_r - go_bc) = -gm_r + go_bc

    const IE_eq_internal = -(IC_eq + IB_eq);

    // Stamp conductance matrix G: G[row][col] += conductance
    // Convention: KCL at node i: sum of currents leaving = 0
    // G*V + B = 0, so we stamp positive conductance for current leaving
    // Current into collector = polarity * IC, so current leaving = -polarity * IC
    // We stamp: G[nC][...] -= dIC_node/dV..., B[nC] -= polarity*IC_eq (equiv current)

    // Collector row
    if (nC >= 0) {
      if (nC >= 0) ctx.stampG(nC, nC, gm_r);
      if (nB >= 0) ctx.stampG(nC, nB, gm_f - gm_r);
      if (nE >= 0) ctx.stampG(nC, nE, -gm_f);
      ctx.stampB(nC, -polarity * IC_eq);
    }

    // Base row
    if (nB >= 0) {
      if (nC >= 0) ctx.stampG(nB, nC, -go_bc);
      if (nB >= 0) ctx.stampG(nB, nB, go_be + go_bc);
      if (nE >= 0) ctx.stampG(nB, nE, -go_be);
      ctx.stampB(nB, -polarity * IB_eq);
    }

    // Emitter row
    if (nE >= 0) {
      if (nC >= 0) ctx.stampG(nE, nC, -gm_r + go_bc);
      if (nB >= 0) ctx.stampG(nE, nB, -(gm_f - gm_r + go_be + go_bc));
      if (nE >= 0) ctx.stampG(nE, nE, gm_f + go_be);
      ctx.stampB(nE, -polarity * IE_eq_internal);
    }

    if (this.stampsBaseResistance) {
      // bjtload.c gx between the external base and base prime (polarity-free).
      const gx = baseResistanceConductance(this.params, IB, dc.qb);
      stampConductance(ctx, this.nodes[4], nB, gx);
    }
    if (substrateJunction) this.stampSubstrateJunction(ctx);
    if (this.params.RCO > 0) {
      stampEpiRegion(ctx, this.nodes, this.params, this.vt, this.multiplier, !substrateJunction);
    }
  }

  /**
   * ngspice-47 bjtload.c substrate junction between the substrate terminal and
   * the substrate-connect node (collector for vertical, base for lateral):
   * vsub = type*subs*(V(s) - V(sc)), cdsub/gdsub from {@link substrateJunction}.
   */
  private stampSubstrateJunction(ctx: StampContext): void {
    const { ISS, NS, SUBS, polarity } = this.params;
    const substrate = this.substrateNode;
    const substrateConnect = SUBS === 1 ? this.nodes[0] : this.nodes[1];
    const sign = polarity * SUBS;
    const terminalVoltage = this.chargesAtLimitedJunctions
      ? sign * this.limitedJunctions[SUBSTRATE]
      : contextVoltage(ctx, substrate) - contextVoltage(ctx, substrateConnect);
    const { current, conductance } = substrateJunction(sign * terminalVoltage, ISS, NS * this.vt, ctx.gmin ?? DEVICE_GMIN);
    // Physical current from the substrate into the substrate-connect node.
    stampChargeBranch(ctx, substrate, substrateConnect, sign * current, conductance, terminalVoltage);
  }

  /**
   * Stamp the linearised charge storage of ngspice's BJT (bjtload.c /
   * bjtacld.c): B-E depletion plus TF diffusion (with XTF/VTF/ITF and base
   * charge), the XCJC fraction of the B-C depletion plus TR diffusion, the
   * dQbe/dVbc cross term, the substrate junction to the substrate terminal and
   * the remaining B-C depletion from the external base. Polarity cancels in
   * every capacitance.
   */
  private stampChargeStorage(ctx: StampContext): void {
    const [nC, nB, nE] = this.nodes;
    const { capBE, capBC, capSub, capBX, crossCapacitance, substrateNode } = this.evaluateCharges(ctx);
    stampCapacitance(ctx, nB, nE, capBE);
    stampCapacitance(ctx, nB, nC, capBC);
    stampCapacitance(ctx, substrateNode, this.substrateNode, capSub);
    // bjtacld.c xcbx between the external base and the collector prime.
    stampCapacitance(ctx, this.externalBaseNode, nC, capBX);
    if (this.params.RCO > 0 && this.params.QCO !== 0) {
      // bjtload.c adds Qbci_Vbci to capbc and saves Qbcx_Vbcx for
      // bjtacld.c. RCO/QCO are not AREA-scaled; M multiplies both branches.
      // Both epi charges vanish for vrci <= 0. Transient remains unsupported.
      const cx = this.nodes[5];
      const voltage = (node: number): number => node >= 0 ? ctx.getVoltage(node) : 0;
      const { polarity, GAMMA, QCO } = this.params;
      if (polarity * (voltage(cx) - voltage(nC)) > 0) {
        for (const collector of [nC, cx]) {
          const vbc = polarity * (voltage(nB) - voltage(collector));
          const exponential = GAMMA * Math.exp(vbc / this.vt);
          const capacitance = this.multiplier * QCO * exponential
            / (2 * this.vt * Math.sqrt(1 + exponential));
          stampCapacitance(ctx, nB, collector, capacitance);
        }
      }
    }
    if (crossCapacitance !== 0) {
      // dQbe/dVbc: charge between B and E controlled by the B-C voltage.
      if (nB >= 0) {
        ctx.stampC(nB, nB, crossCapacitance);
        if (nC >= 0) ctx.stampC(nB, nC, -crossCapacitance);
      }
      if (nE >= 0) {
        if (nB >= 0) ctx.stampC(nE, nB, -crossCapacitance);
        if (nC >= 0) ctx.stampC(nE, nC, crossCapacitance);
      }
    }
  }

  /**
   * ngspice bjtload.c charges qbe, qbc, qsub and qbx (polarity domain) with
   * their capacitances dQ/dV and the dQbe/dVbc cross capacitance, at the
   * present terminal voltages. Writes into a reused object.
   */
  private evaluateCharges(ctx: StampContext, atLimitedJunctions = false): BJTChargePoint {
    const {
      IS, NF, NR, polarity,
      CJE, VJE, MJE, TF, XTF, VTF, ITF, CJC, VJC, MJC, XCJC, TR, CJS, VJS, MJS, FC, SUBS,
    } = this.params;
    const [nC, nB, nE] = this.nodes;
    const voltage = (node: number): number => node >= 0 ? ctx.getVoltage(node) : 0;
    const vtF = NF * this.vt;
    const vtR = NR * this.vt;
    // ngspice evaluates the charges at the junction voltages it linearises at;
    // depletion charge needs the true reverse bias.
    const limited = this.limitedJunctions;
    const junctions = ctx.initialUIC ? this.acceptedJunctions : atLimitedJunctions ? limited : undefined;
    const vBE = junctions ? junctions[BASE_EMITTER] : polarity * (voltage(nB) - voltage(nE));
    const vBC = junctions ? junctions[BASE_COLLECTOR] : polarity * (voltage(nB) - voltage(nC));

    // ngspice bjtload.c builds the diffusion charges from cbe/gbe and cbc/gbc
    // (the junction law without gmin, reverse law included).
    const forward = junctionLaw(this.junction, vBE, IS, vtF);
    const forwardCurrent = forward.current;
    const forwardConductance = forward.conductance;
    const reverse = junctionLaw(this.junction, vBC, this.baseCollectorSatCur, vtR);
    const reverseCurrent = reverse.current;
    const reverseConductance = reverse.conductance;

    const point = this.chargePoint;
    const depletionBE = depletionCharge(vBE, CJE, VJE, MJE, FC);
    let qBE = depletionBE.charge;
    let capBE = depletionBE.capacitance;
    let crossCapacitance = 0;
    if (TF > 0) {
      let diffusionCurrent = forwardCurrent;
      let diffusionConductance = forwardConductance;
      if (vBE > 0) {
        // bjtload.c reuses the DC base charge qb and its derivatives.
        const {
          qb: qB, dqbdve: dqBdVBE, dqbdvc: dqBdVBC,
        } = baseCharge(
          this.charge, this.params, vBE, vBC,
          forwardCurrent, forwardConductance, reverseCurrent, reverseConductance,
        );
        const inverseVtf = VTF !== 0 ? 1 / (1.44 * VTF) : 0;
        let argtf = 0;
        let arg2 = 0;
        let arg3 = 0;
        if (XTF !== 0) {
          argtf = XTF * (inverseVtf !== 0 ? Math.exp(vBC * inverseVtf) : 1);
          arg2 = argtf;
          if (ITF !== 0) {
            const share = forwardCurrent / (forwardCurrent + ITF);
            argtf *= share * share;
            arg2 = argtf * (3 - share - share);
          }
          arg3 = forwardCurrent * argtf * inverseVtf;
        }
        const transportCurrent = forwardCurrent * (1 + argtf) / qB;
        diffusionCurrent = transportCurrent;
        diffusionConductance = (forwardConductance * (1 + arg2) - transportCurrent * dqBdVBE) / qB;
        crossCapacitance = TF * (arg3 - transportCurrent * dqBdVBC) / qB;
      }
      qBE += TF * diffusionCurrent;
      capBE += TF * diffusionConductance;
    }
    // bjtload.c: czbc = XCJC*ctot on the internal base (qbc), czbx = ctot -
    // czbc from the external base (qbx). vbx is the node voltage difference
    // (CKTrhsOld), never limited.
    const internalCJC = CJC * XCJC;
    const depletionBC = depletionCharge(vBC, internalCJC, VJC, MJC, FC);
    const qBC = TR * reverseCurrent + depletionBC.charge;
    const capBC = TR * reverseConductance + depletionBC.capacitance;
    const vBX = ctx.initialUIC ? vBC : polarity * (voltage(this.externalBaseNode) - voltage(nC));
    const depletionBX = depletionCharge(vBX, CJC - internalCJC, VJC, MJC, FC);

    const substrateNode = SUBS === 1 ? nC : nB;
    // ngspice bjtload.c vsub = type*subs*(V(substrate) - V(substrate-connect)).
    const vSub = junctions
      ? junctions[SUBSTRATE]
      : polarity * SUBS * (voltage(this.substrateNode) - voltage(substrateNode));
    let qSub = 0;
    let capSub = 0;
    if (CJS !== 0) {
      if (vSub < 0) {
        const depletion = depletionCharge(vSub, CJS, VJS, MJS, 1);
        qSub = depletion.charge;
        capSub = depletion.capacitance;
      } else {
        // ngspice: linear capacitance continuation from zero bias.
        qSub = vSub * CJS * (1 + MJS * vSub / (2 * VJS));
        capSub = CJS * (1 + MJS * vSub / VJS);
      }
    }

    point.nodeVBE = vBE;
    point.nodeVBC = vBC;
    point.vSub = vSub;
    point.substrateNode = substrateNode;
    point.qBE = qBE;
    point.capBE = capBE;
    point.crossCapacitance = crossCapacitance;
    point.qBC = qBC;
    point.capBC = capBC;
    point.qSub = qSub;
    point.capSub = capSub;
    point.nodeVBX = vBX;
    point.qBX = depletionBX.charge;
    point.capBX = depletionBX.capacitance;
    return point;
  }
}

interface BJTChargePoint {
  /** Polarity-domain junction voltages at the nodes. */
  nodeVBE: number;
  nodeVBC: number;
  vSub: number;
  /** Substrate-connect node: collector (vertical) or base (lateral). */
  substrateNode: number;
  qBE: number;
  capBE: number;
  crossCapacitance: number;
  qBC: number;
  capBC: number;
  qSub: number;
  capSub: number;
  /** Polarity-domain external base to collector-prime voltage (bjtload.c vbx). */
  nodeVBX: number;
  qBX: number;
  capBX: number;
}

const BASE_EMITTER = 0;
const BASE_COLLECTOR = 1;
const SUBSTRATE = 2;
/** bjtload.c qbx: the (1 - XCJC) B-C depletion charge outside RB. */
const EXTERNAL_BASE_COLLECTOR = 3;
/** BJTtrunc estimates the step from qbe, qbc and qsub only. */
const TRUNCATED_CHARGES = [BASE_EMITTER, BASE_COLLECTOR, SUBSTRATE] as const;

function stampConductance(ctx: StampContext, a: number, b: number, conductance: number): void {
  if (conductance === 0) return;
  if (a >= 0) ctx.stampG(a, a, conductance);
  if (b >= 0) ctx.stampG(b, b, conductance);
  if (a >= 0 && b >= 0) {
    ctx.stampG(a, b, -conductance);
    ctx.stampG(b, a, -conductance);
  }
}

function stampCapacitance(ctx: StampContext, a: number, b: number, capacitance: number): void {
  if (capacitance === 0) return;
  if (a >= 0) ctx.stampC(a, a, capacitance);
  if (b >= 0) ctx.stampC(b, b, capacitance);
  if (a >= 0 && b >= 0) {
    ctx.stampC(a, b, -capacitance);
    ctx.stampC(b, a, -capacitance);
  }
}
