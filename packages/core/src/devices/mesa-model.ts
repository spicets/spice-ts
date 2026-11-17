import type { ModelParams } from '../types.js';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../errors.js';

/**
 * ngspice MESA (Z-card, `NMF`) MESFET, LEVEL=2 (`mesa1()`) and LEVEL=3
 * (`mesa2()`, delta-doped channel).
 *
 * Mirrors ngspice-47 `mesasetup.c` defaults, `mesatemp.c` per-instance
 * temperature mapping (instance TS/TD) and `mesa1()`/`mesa2()`/`MESAload()`
 * in `mesaload.c`, plus the frequency-dispersive output conductance of
 * `MESAacLoad()` (DELFO/FLO/TF/LAMBDAHF). Circuit TEMP and TNOM feed the
 * preprocessing; TS/TD override circuit TEMP + DTEMP independently.
 *
 * Still rejected rather than ignored: LEVEL=4 (`mesa3()`), sidegating
 * (KS/VSG) and the instance multiplier M.
 */
export interface MESAInstanceParams {
  /** Original Celsius side overrides, retained for circuit temperature updates. */
  sourceTemperature?: number;
  drainTemperature?: number;
  deltaTemperature?: number;
  L: number;
  W: number;
  /** Source-side temperature in kelvin (ngspice MESAts). */
  TS: number;
  /** Drain-side temperature in kelvin (ngspice MESAtd). */
  TD: number;
}

export interface MESAModel {
  /** CKTnomTemp, in kelvin. MESA has no model-card TNOM parameter. */
  nominalTemperature?: number;
  defaultTF?: boolean;
  LEVEL: 2 | 3;
  VTO: number;
  LAMBDA: number;
  LAMBDAHF: number;
  BETA: number;
  VS: number;
  RD: number;
  RS: number;
  RG: number;
  RI: number;
  RF: number;
  RDI: number;
  RSI: number;
  /** Schottky barrier height in volts (ngspice stores PHIB * q). */
  PHIB: number;
  /** Barrier temperature coefficient in V/K (ngspice stores PHIB1 * q). */
  PHIB1: number;
  ASTAR: number;
  GGR: number;
  DEL: number;
  XCHI: number;
  N: number;
  ETA: number;
  M: number;
  MC: number;
  ALPHA: number;
  SIGMA0: number;
  VSIGMAT: number;
  VSIGMA: number;
  MU: number;
  THETA: number;
  MU1: number;
  MU2: number;
  D: number;
  ND: number;
  DU: number;
  NDU: number;
  TH: number;
  NDELTA: number;
  DELTA: number;
  TC: number;
  TVTO: number;
  TLAMBDA: number;
  TETA0: number;
  TETA1: number;
  TMU: number;
  XTM0: number;
  XTM1: number;
  XTM2: number;
  TF: number;
  FLO: number;
  DELFO: number;
  AG: number;
  TC1: number;
  TC2: number;
  ZETA: number;
}

export interface MESAEvaluation {
  /** Intrinsic channel current from drain' to source' (signed). */
  drainCurrent: number;
  /** Forward-orientation transconductance, as stored by ngspice. */
  gm: number;
  /** Forward-orientation output conductance, as stored by ngspice. */
  gds: number;
  gateSourceCurrent: number;
  gateSourceConductance: number;
  gateDrainCurrent: number;
  gateDrainConductance: number;
  capGS: number;
  capGD: number;
  /**
   * Terms `MESAacLoad` rebuilds gm/gds from (ngspice MESAdelidgch0 ...
   * MESAgds0); undefined when the channel is cut off and ngspice keeps the
   * previously stored terms.
   */
  small?: MESASmallSignalTerms;
}

/** Channel derivatives `mesa1()`/`mesa2()` store on the instance for MESAacLoad. */
export interface MESASmallSignalTerms {
  delidgch0: number;
  delidvds0: number;
  delidvds1: number;
  gm0: number;
  gm1: number;
  gm2: number;
  gds0: number;
}

/** Temperature-mapped instance constants (ngspice `MESAtemp`). */
export interface MESAInstanceState {
  model: MESAModel;
  instance: MESAInstanceParams;
  vts: number;
  vtd: number;
  vpo: number;
  vpou: number;
  vpod: number;
  deltaSqr: number;
  tMu: number;
  tVto: number;
  gchi0: number;
  beta: number;
  tEta: number;
  tLambda: number;
  tLambdahf: number;
  n0: number;
  nsb0: number;
  isatb0: number;
  cf: number;
  csatfs: number;
  csatfd: number;
  ggrwl: number;
  fl: number;
  delf: number;
  tRdi: number;
  tRsi: number;
}

// ngspice-47 accepts these on an NMF level 2/3 card. NMAX, GAMMA, EPSI, CAS and
// CBS only enter LEVEL=4 (mesa3), so they are inert here, as in ngspice.
const MODEL_PARAMETERS = new Set([
  'LEVEL', 'VTO', 'VT0', 'LAMBDA', 'LAMBDAHF', 'BETA', 'VS', 'RD', 'RS', 'RG',
  'RI', 'RF', 'RDI', 'RSI', 'PHIB', 'PHIB1', 'TPHIB', 'ASTAR', 'GGR', 'DEL',
  'XCHI', 'TGGR', 'N', 'ETA', 'M', 'MC', 'ALPHA', 'SIGMA0', 'VSIGMAT', 'VSIGMA',
  'MU', 'THETA', 'MU1', 'MU2', 'D', 'ND', 'DU', 'NDU', 'TH', 'NDELTA', 'DELTA',
  'TC', 'TVTO', 'ALPHAT', 'TLAMBDA', 'TETA0', 'TETA1', 'TMU', 'XTM0', 'XTM1',
  'XTM2', 'TF', 'FLO', 'DELFO', 'AG', 'RTC1', 'RTC2', 'ZETA', 'NMAX', 'GAMMA',
  'EPSI', 'CAS', 'CBS',
]);
/** ngspice IOPR aliases: the second name sets the same model field. */
const ALIASES: readonly (readonly [string, string])[] = [
  ['VTO', 'VT0'], ['PHIB1', 'TPHIB'], ['XCHI', 'TGGR'], ['TVTO', 'ALPHAT'],
];
const INSTANCE_PARAMETERS = new Set(['L', 'W', 'TS', 'TD', 'DTEMP']);

// ngspice-47 include/ngspice/const.h
const CHARGE = 1.6021766208e-19;
const BOLTZMANN = 1.38064852e-23;
const K_OVER_Q = BOLTZMANN / CHARGE;
const CELSIUS_TO_KELVIN = 273.15;
const EPSILON_GAAS = 12.244 * 8.85418e-12;
/** Default CKTtemp and CKTnomTemp in kelvin. */
export const MESA_NOMINAL_TEMPERATURE = 300.15;
/** ngspice CKTgmin default, added to both gate junctions by MESAload. */
export const MESA_JUNCTION_GMIN = 1e-12;

export function resolveMESAModel(model: ModelParams, temperature = 27, nominalTemperature = 27): MESAModel {
  if (model.type !== 'NMF') throw new Error(`Unsupported MESA model type: '${model.type}'`);
  const level = model.params.LEVEL ?? 2;
  if (level !== 2 && level !== 3) throw new Error(`Unsupported NMF model level: ${level}`);
  for (const name of Object.keys(model.params)) {
    if (!MODEL_PARAMETERS.has(name)) {
      throw new UnsupportedModelParameterError('', name,
        `Unsupported NMF level-${level} model parameter: '${name}'`, { model: 'MESA', modelName: model.name });
    }
  }
  for (const [name, alias] of ALIASES) {
    if (model.params[name] !== undefined && model.params[alias] !== undefined) {
      throw new Error(`NMF level-${level} model may specify only one of '${alias}' and '${name}'`);
    }
  }
  const p = model.params;
  const lambda = p.LAMBDA ?? 0.045;
  const resolved: MESAModel = {
    nominalTemperature: nominalTemperature + CELSIUS_TO_KELVIN,
    defaultTF: p.TF === undefined,
    LEVEL: level,
    VTO: p.VTO ?? p.VT0 ?? -1.26,
    LAMBDA: lambda,
    LAMBDAHF: p.LAMBDAHF ?? lambda,
    BETA: p.BETA ?? 0.0085,
    VS: p.VS ?? 1.5e5,
    RD: p.RD ?? 0,
    RS: p.RS ?? 0,
    RG: p.RG ?? 0,
    RI: p.RI ?? 0,
    RF: p.RF ?? 0,
    RDI: p.RDI ?? 0,
    RSI: p.RSI ?? 0,
    PHIB: p.PHIB ?? 0.5,
    PHIB1: p.PHIB1 ?? p.TPHIB ?? 0,
    ASTAR: p.ASTAR ?? 4e4,
    GGR: p.GGR ?? 40,
    DEL: p.DEL ?? 0.04,
    XCHI: p.XCHI ?? p.TGGR ?? 0.033,
    N: p.N ?? 1,
    ETA: p.ETA ?? 1.73,
    M: p.M ?? 2.5,
    MC: p.MC ?? 3,
    ALPHA: p.ALPHA ?? 0,
    SIGMA0: p.SIGMA0 ?? 0.081,
    VSIGMAT: p.VSIGMAT ?? 1.01,
    VSIGMA: p.VSIGMA ?? 0.1,
    MU: p.MU ?? 0.23,
    THETA: p.THETA ?? 0,
    MU1: p.MU1 ?? 0,
    MU2: p.MU2 ?? 0,
    D: p.D ?? 0.12e-6,
    ND: p.ND ?? 2e23,
    DU: p.DU ?? 0.035e-6,
    NDU: p.NDU ?? 1e22,
    TH: p.TH ?? 0.01e-6,
    NDELTA: p.NDELTA ?? 6e24,
    DELTA: p.DELTA ?? 5,
    TC: p.TC ?? 0,
    TVTO: p.TVTO ?? p.ALPHAT ?? 0,
    // mesamparam.c converts explicitly supplied characteristic temperatures,
    // including TETA1, from Celsius. mesasetup.c defaults are already kelvin.
    TLAMBDA: p.TLAMBDA === undefined ? Number.MAX_VALUE : p.TLAMBDA + CELSIUS_TO_KELVIN,
    TETA0: p.TETA0 === undefined ? Number.MAX_VALUE : p.TETA0 + CELSIUS_TO_KELVIN,
    TETA1: p.TETA1 === undefined ? 0 : p.TETA1 + CELSIUS_TO_KELVIN,
    TMU: p.TMU === undefined ? 300.15 : p.TMU + CELSIUS_TO_KELVIN,
    XTM0: p.XTM0 ?? 0,
    XTM1: p.XTM1 ?? 0,
    XTM2: p.XTM2 ?? 0,
    // ngspice mesasetup.c: TF defaults to CKTtemp.
    TF: (p.TF ?? temperature) + CELSIUS_TO_KELVIN,
    FLO: p.FLO ?? 0,
    DELFO: p.DELFO ?? 0,
    AG: p.AG ?? 0,
    TC1: p.RTC1 ?? 0,
    TC2: p.RTC2 ?? 0,
    ZETA: p.ZETA ?? 1,
  };
  const invalid = [
    resolved.RD, resolved.RS, resolved.RG, resolved.RI, resolved.RF, resolved.RDI, resolved.RSI,
    resolved.ASTAR, resolved.GGR,
  ].some(value => value < 0) || [
    resolved.VS, resolved.MU, resolved.ETA, resolved.N, resolved.M, resolved.MC, resolved.VSIGMA,
    resolved.D, resolved.ND, resolved.TF,
  ].some(value => !(value > 0)) || (level === 3 && [
    resolved.DU, resolved.NDU, resolved.TH, resolved.NDELTA, resolved.BETA,
  ].some(value => !(value > 0)));
  if (invalid) throw new Error(`Invalid NMF level-${level} model parameter value`);
  return resolved;
}

export function resolveMESAInstance(params: Record<string, number> = {}, temperature = 27): MESAInstanceParams {
  for (const name of Object.keys(params)) {
    if (!INSTANCE_PARAMETERS.has(name)) {
      throw new InvalidCircuitError(`Unsupported NMF MESA instance parameter: '${name}'`);
    }
  }
  // ngspice mesaparam.c: TS/TD are given in Celsius; unset they are CKTtemp + DTEMP.
  const local = temperature + CELSIUS_TO_KELVIN + (params.DTEMP ?? 0);
  const instance = {
    ...(params.TS === undefined ? {} : { sourceTemperature: params.TS }),
    ...(params.TD === undefined ? {} : { drainTemperature: params.TD }),
    ...(params.DTEMP === undefined ? {} : { deltaTemperature: params.DTEMP }),
    L: params.L ?? 1e-6,
    W: params.W ?? 20e-6,
    TS: params.TS === undefined ? local : params.TS + CELSIUS_TO_KELVIN,
    TD: params.TD === undefined ? local : params.TD + CELSIUS_TO_KELVIN,
  };
  if (!(instance.L > 0) || !(instance.W > 0)) {
    throw new Error('NMF MESA instance L and W must be positive');
  }
  if (![instance.TS, instance.TD].every(value => Number.isFinite(value) && value > 0)) {
    throw new InvalidCircuitError('NMF MESA instance temperatures must be above 0 K and finite');
  }
  return instance;
}

/**
 * Series resistances at the instance temperatures (ngspice mesatemp.c tRd/tRs
 * at TD/TS, tRg/tRi at TS and tRf at TD, scaled by RTC1/RTC2 around TNOM).
 */
export function mesaSeriesResistances(model: MESAModel, instance: MESAInstanceParams) {
  const scale = (value: number, temperature: number): number => {
    if (value === 0) return 0;
    const dt = temperature - (model.nominalTemperature ?? MESA_NOMINAL_TEMPERATURE);
    return value * (1 + model.TC1 * dt + model.TC2 * dt * dt);
  };
  return {
    RD: scale(model.RD, instance.TD),
    RS: scale(model.RS, instance.TS),
    RG: scale(model.RG, instance.TS),
    RI: scale(model.RI, instance.TS),
    RF: scale(model.RF, instance.TD),
  };
}

/** ngspice `MESAtemp` for one instance. */
export function mesaInstanceState(model: MESAModel, instance: MESAInstanceParams): MESAInstanceState {
  const nominal = model.nominalTemperature ?? MESA_NOMINAL_TEMPERATURE;
  const { L, W, TS: ts, TD: td } = instance;
  let vpo: number;
  let vpou = 0;
  let vpod = 0;
  if (model.LEVEL === 2) {
    vpo = CHARGE * model.ND * model.D * model.D / 2 / EPSILON_GAAS;
  } else {
    vpou = CHARGE * model.NDU * model.DU * model.DU / 2 / EPSILON_GAAS;
    vpod = CHARGE * model.NDELTA * model.TH * (2 * model.DU + model.TH) / 2 / EPSILON_GAAS;
    vpo = vpou + vpod;
  }
  const vts = K_OVER_Q * ts;
  let tMu: number;
  if (model.MU1 === 0 && model.MU2 === 0) {
    tMu = model.MU * (ts / model.TMU) ** model.XTM0;
  } else {
    const muimp = model.MU * (ts / model.TMU) ** model.XTM0;
    const mupo = model.MU1 * (model.TMU / ts) ** model.XTM1 + model.MU2 * (model.TMU / ts) ** model.XTM2;
    tMu = 1 / (1 / muimp + 1 / mupo);
  }
  const phib = model.PHIB * CHARGE;
  const tPhib = phib - model.PHIB1 * CHARGE * (ts - nominal);
  const tEta = model.ETA * (1 + ts / model.TETA0) + model.TETA1 / ts;
  const depth = model.LEVEL === 3 ? model.DU : model.D;
  const n0 = EPSILON_GAAS * tEta * vts / CHARGE / depth;
  const fieldTemperature = Math.exp(ts / model.TF);
  return {
    model,
    instance,
    vts,
    vtd: K_OVER_Q * td,
    vpo,
    vpou,
    vpod,
    deltaSqr: model.DELTA * model.DELTA,
    tMu,
    tVto: model.VTO - model.TVTO * (ts - nominal),
    gchi0: model.LEVEL === 2 ? CHARGE * W / L : CHARGE * W / L * tMu,
    beta: 2 * EPSILON_GAAS * model.VS * model.ZETA * W / model.D,
    tEta,
    tLambda: model.LAMBDA * (1 - ts / model.TLAMBDA),
    tLambdahf: model.LAMBDAHF * (1 - ts / model.TLAMBDA),
    n0,
    nsb0: EPSILON_GAAS * tEta * vts / CHARGE / (model.DU + model.TH),
    isatb0: CHARGE * n0 * vts * W / L,
    cf: 0.5 * EPSILON_GAAS * W,
    csatfs: 0.5 * model.ASTAR * ts * ts * Math.exp(-tPhib / (BOLTZMANN * ts)) * L * W,
    csatfd: 0.5 * model.ASTAR * td * td * Math.exp(-tPhib / (BOLTZMANN * td)) * L * W,
    ggrwl: model.GGR * L * W * Math.exp(model.XCHI * (ts - nominal)),
    fl: model.FLO * fieldTemperature,
    delf: model.DELFO * fieldTemperature,
    tRdi: model.RDI === 0 ? 0 : model.RDI * (1 + model.TC1 * (td - nominal) + model.TC2 * (td - nominal) ** 2),
    tRsi: model.RSI === 0 ? 0 : model.RSI * (1 + model.TC1 * (ts - nominal) + model.TC2 * (ts - nominal) ** 2),
  };
}

interface ChannelResult {
  drainCurrent: number;
  gm: number;
  gds: number;
  capGS: number;
  capGD: number;
  small?: MESASmallSignalTerms;
}

/**
 * ngspice returns from mesa1()/mesa2() before storing the small-signal terms
 * when the sheet charge underflows, so the instance keeps the terms of its
 * last conducting evaluation; `small` is then undefined.
 */
function cutoff(state: MESAInstanceState): ChannelResult {
  return { drainCurrent: 0, gm: 0, gds: 0, capGS: state.cf, capGD: state.cf };
}

/** ngspice `mesa1()` (LEVEL=2) for vds >= 0. */
function mesa1(vgs: number, vds: number, von: number, state: MESAInstanceState): ChannelResult {
  const model = state.model;
  const { L, W } = state.instance;
  const vt = state.vts;
  const etavth = state.tEta * vt;
  const RS = state.tRsi;
  const RD = state.tRdi;
  const lambda = state.tLambda;
  const vpo = state.vpo;

  const rt = RS + RD;
  const vgt0 = vgs - von;
  const s = Math.exp((vgt0 - model.VSIGMAT) / model.VSIGMA);
  const sigma = model.SIGMA0 / (1 + s);
  const vgt = vgt0 + sigma * vds;
  const mu = state.tMu + model.THETA * vgt;
  const vl = model.VS / mu * L;
  const beta = state.beta / (vpo + 3 * vl);
  const u = vgt / vt - 1;
  const t = Math.sqrt(state.deltaSqr + u * u);
  const vgte = 0.5 * vt * (2 + u + t);
  const a = 2 * beta * vgte;
  const b = Math.exp(-vgt / etavth);
  const sqrt1 = vgte > vpo ? 0 : Math.sqrt(1 - vgte / vpo);
  const ns = 1 / (1 / model.ND / model.D / (1 - sqrt1) + 1 / state.n0 * b);
  if (ns < 1e-38) return cutoff(state);
  const gchi = state.gchi0 * mu * ns;
  const gch = gchi / (1 + gchi * rt);
  const f = Math.sqrt(1 + 2 * a * RS);
  const d = 1 + a * RS + f;
  const e = 1 + model.TC * vgte;
  const isata = a * vgte / (d * e);
  const isatb = state.isatb0 * mu * Math.exp(vgt / etavth);
  const isat = isata * isatb / (isata + isatb);
  const vsate = isat / gch;
  const vdse = vds * (1 + (vds / vsate) ** model.MC) ** (-1 / model.MC);
  const m = model.M + model.ALPHA * vgte;
  let g = (vds / vsate) ** m;
  const h = (1 + g) ** (1 / m);
  const delidgch0 = vds / h;
  const delidgch = delidgch0 * (1 + lambda * vds);
  const cdrain = gch * delidgch;

  let temp = vgt > vpo ? 0 : Math.sqrt(1 - vgt / vpo);
  const cgc = W * L * EPSILON_GAAS / (temp + b) / model.D;
  let c = (vsate - vdse) / (2 * vsate - vdse);
  c *= c;
  const capGS = state.cf + 2 / 3 * cgc * (1 - c);
  c = vsate / (2 * vsate - vdse);
  c *= c;
  const capGD = state.cf + 2 / 3 * cgc * (1 - c);

  temp = 1 + gchi * rt;
  const delgchgchi = 1 / (temp * temp);
  const delgchins = state.gchi0 * mu;
  const delnsvgt = ns * ns / state.n0 / etavth * b;
  const q = 1 - sqrt1;
  const delnsvgte = sqrt1 === 0 ? 0 : 0.5 * ns * ns / (vpo * model.ND * model.D * sqrt1 * q * q);
  const delvgtevgt = 0.5 * (1 + u / t);
  const delidvds0 = gch / h;
  const delidvds1 = vds !== 0 ? cdrain * (vds / vsate) ** (m - 1) / (vsate * (1 + g)) : 0;
  const delidvds = delidvds0 * (1 + 2 * lambda * vds) - delidvds1;
  const delidvsate = cdrain * g / (vsate * (1 + g));
  const delvsateisat = 1 / gch;
  let r = isata + isatb;
  r *= r;
  const delisatisata = isatb * isatb / r;
  const v = 1 + 1 / f;
  const ddevgte = 2 * beta * RS * v * e + d * model.TC;
  temp = d * d * e * e;
  const delisatavgte = (2 * a * d * e - a * vgte * ddevgte) / temp;
  const delisatabeta = 2 * vgte * vgte * (d * e - a * e * RS * v) / temp;
  const delisatisatb = isata * isata / r;
  const delvsategch = -vsate / gch;
  const dvgtvgs = 1 - model.SIGMA0 * vds * s / model.VSIGMA / ((1 + s) * (1 + s));
  temp = state.gchi0 * ns * model.THETA;
  const dgchivgt = delgchins * (delnsvgte * delvgtevgt + delnsvgt) + temp;
  const dvgtevds = delvgtevgt * sigma;
  const dgchivds = delgchins * (delnsvgte * dvgtevds + delnsvgt * sigma) + temp * sigma;
  temp = delisatabeta * 3 * beta * vl * model.THETA / (mu * (vpo + 3 * vl));
  const disatavgt = delisatavgte * delvgtevgt + temp;
  const disatavds = delisatavgte * dvgtevds + temp * sigma;
  const disatbvgt = isatb / etavth + isatb / mu * model.THETA;
  const p = delgchgchi * dgchivgt;
  const w = delgchgchi * dgchivds;
  const dvsatevgt = delvsateisat * (delisatisata * disatavgt + delisatisatb * disatbvgt) + delvsategch * p;
  const dvsatevds = delvsateisat * (delisatisata * disatavds + delisatisatb * disatbvgt * sigma)
    + delvsategch * w;
  let gmmadd = 0;
  let gdsmadd = 0;
  if (model.ALPHA !== 0) {
    gmmadd = vds === 0
      ? 0
      : cdrain * (Math.log(1 + g) / (m * m) - g * Math.log(vds / vsate) / (m * (1 + g)))
        * model.ALPHA * delvgtevgt;
    gdsmadd = gmmadd * sigma;
  }
  const gm1 = delidvsate * dvsatevgt;
  g = delidgch * p + gm1;
  const gm = (g + gmmadd) * dvgtvgs;
  const gds0 = delidvsate * dvsatevds + delidgch * w + gdsmadd;
  const gds = delidvds + gds0;
  return {
    drainCurrent: cdrain,
    gm,
    gds,
    capGS,
    capGD,
    small: { delidgch0, delidvds0, delidvds1, gm0: p, gm1, gm2: dvgtvgs, gds0 },
  };
}

/** ngspice `mesa2()` (LEVEL=3, delta-doped channel) for vds >= 0. */
function mesa2(vgs: number, vds: number, von: number, state: MESAInstanceState): ChannelResult {
  const model = state.model;
  const { L, W } = state.instance;
  const vt = state.vts;
  const etavth = state.tEta * vt;
  const RS = state.tRsi;
  const RD = state.tRdi;
  const lambda = state.tLambda;
  const { vpo, vpou, vpod } = state;
  const { NDELTA, TH, NDU, DU } = model;

  const rt = RS + RD;
  const vgt0 = vgs - von;
  const s = Math.exp((vgt0 - model.VSIGMAT) / model.VSIGMA);
  const sigma = model.SIGMA0 / (1 + s);
  const vgt = vgt0 + sigma * vds;
  const t = vgt / vt - 1;
  const q = Math.sqrt(state.deltaSqr + t * t);
  const vgte = 0.5 * vt * (2 + t + q);
  const a = 2 * model.BETA * vgte;
  let nsa: number;
  let ca: number;
  let delnsavgte: number;
  let r: number;
  if (vgt > vpod) {
    if (vgte > vpo) {
      nsa = NDELTA * TH + NDU * DU;
      ca = EPSILON_GAAS / DU;
      delnsavgte = 0;
    } else {
      r = Math.sqrt((vpo - vgte) / vpou);
      nsa = NDELTA * TH + NDU * DU * (1 - r);
      ca = EPSILON_GAAS / DU / r;
      delnsavgte = NDU * DU / vpou / 2 / r;
    }
  } else if (vpod - vgte < 0) {
    nsa = NDELTA * TH * (1 - DU / TH);
    ca = EPSILON_GAAS / DU;
    delnsavgte = 0;
  } else {
    r = Math.sqrt(1 + NDU / NDELTA * (vpod - vgte) / vpou);
    nsa = NDELTA * TH * (1 - DU / TH * (r - 1));
    ca = EPSILON_GAAS / DU / r;
    delnsavgte = DU * NDU / 2 / vpou / r;
  }
  const b = Math.exp(vgt / etavth);
  const cb = EPSILON_GAAS / (DU + TH) * b;
  const nsb = state.nsb0 * b;
  const delnsbvgt = nsb / etavth;
  const ns = nsa * nsb / (nsa + nsb);
  if (ns < 1e-38) return cutoff(state);
  const gchi = state.gchi0 * ns;
  const gch = gchi / (1 + gchi * rt);
  const f = Math.sqrt(1 + 2 * a * RS);
  const d = 1 + a * RS + f;
  const e = 1 + model.TC * vgte;
  const isata = a * vgte / d / e;
  const isatb = state.isatb0 * b;
  const isat = isata * isatb / (isata + isatb);
  const vsate = isat / gch;
  const vdse = vds * (1 + (vds / vsate) ** model.MC) ** (-1 / model.MC);
  let g = (vds / vsate) ** model.M;
  const h = (1 + g) ** (1 / model.M);
  const delidgch0 = vds / h;
  const delidgch = delidgch0 * (1 + lambda * vds);
  const cdrain = gch * delidgch;
  const cgc = W * L * ca * cb / (ca + cb);
  let c = (vsate - vdse) / (2 * vsate - vdse);
  c *= c;
  const capGS = state.cf + 2 / 3 * cgc * (1 - c);
  c = vsate / (2 * vsate - vdse);
  c *= c;
  const capGD = state.cf + 2 / 3 * cgc * (1 - c);
  const delvgtevgt = 0.5 * (1 + t / q);
  const delidvds0 = gch / h;
  const delidvds1 = vds !== 0 ? cdrain * (vds / vsate) ** (model.M - 1) / vsate / (1 + g) : 0;
  const delidvds = delidvds0 * (1 + 2 * lambda * vds) - delidvds1;
  const delgchgchi = 1 / (1 + gchi * rt) / (1 + gchi * rt);
  const delgchins = state.gchi0;
  r = nsa + nsb;
  r *= r;
  const delnsvgt = (nsb * nsb * delvgtevgt * delnsavgte + nsa * nsa * delnsbvgt) / r;
  const delidvsate = cdrain * g / vsate / (1 + g);
  const delvsateisat = 1 / gch;
  r = isata + isatb;
  r *= r;
  const delisatisata = isatb * isatb / r;
  const ddevgte = 2 * model.BETA * RS * (1 + 1 / f) * e + d * model.TC;
  const delisatavgte = (2 * a * d * e - a * vgte * ddevgte) / d / d / e / e;
  const delisatisatb = isata * isata / r;
  const delisatbvgt = isatb / etavth;
  const delvsategch = -vsate / gch;
  const delvgtvgs = 1 - model.SIGMA0 * vds * s / model.VSIGMA / (1 + s) / (1 + s);
  const p = delgchgchi * delgchins * delnsvgt;
  const delvsatevgt = delvsateisat * (delisatisata * delisatavgte * delvgtevgt
    + delisatisatb * delisatbvgt) + delvsategch * p;
  const gm1 = delidvsate * delvsatevgt;
  g = delidgch * p + gm1;
  const gm = g * delvgtvgs;
  const gds0 = g * sigma;
  const gds = delidvds + gds0;
  return {
    drainCurrent: cdrain,
    gm,
    gds,
    capGS,
    capGD,
    small: { delidgch0, delidvds0, delidvds1, gm0: p, gm1, gm2: delvgtvgs, gds0 },
  };
}

/**
 * Evaluate the intrinsic MESA device at gate'-source' and gate'-drain'
 * voltages, exactly as ngspice MESAload does after voltage limiting.
 */
export function evaluateMESA(
  vgs: number,
  vgd: number,
  state: MESAInstanceState,
  gmin = MESA_JUNCTION_GMIN,
): MESAEvaluation {
  const model = state.model;
  const vts = state.vts;
  const vtd = state.vtd;
  const vtes = model.N * vts;
  const vted = model.N * vtd;

  let arg = -vgs * model.DEL / vts;
  let earg = Math.exp(arg);
  const evgs = Math.exp(vgs / vtes);
  const gateSourceConductance = state.csatfs * evgs / vtes + state.ggrwl * earg * (1 - arg) + gmin;
  const gateSourceCurrent = state.csatfs * (evgs - 1) + state.ggrwl * vgs * earg + gmin * vgs;

  arg = -vgd * model.DEL / vtd;
  earg = Math.exp(arg);
  const evgd = Math.exp(vgd / vted);
  const gateDrainConductance = state.csatfd * evgd / vted + state.ggrwl * earg * (1 - arg) + gmin;
  const gateDrainCurrent = state.csatfd * (evgd - 1) + state.ggrwl * vgd * earg + gmin * vgd;

  const vds = vgs - vgd;
  const inverse = vds < 0;
  const channelVgs = inverse ? vgd : vgs;
  const von = state.tVto;
  const channel = model.LEVEL === 2
    ? mesa1(channelVgs, Math.abs(vds), von, state)
    : mesa2(channelVgs, Math.abs(vds), von, state);
  return {
    drainCurrent: inverse ? -channel.drainCurrent : channel.drainCurrent,
    gm: channel.gm,
    gds: channel.gds,
    gateSourceCurrent,
    gateSourceConductance,
    gateDrainCurrent,
    gateDrainConductance,
    capGS: inverse ? channel.capGD : channel.capGS,
    capGD: inverse ? channel.capGS : channel.capGD,
    small: channel.small,
  };
}

/**
 * Small-signal channel conductances of ngspice `MESAacLoad` at frequency
 * `frequency` (Hz): LAMBDA moves towards LAMBDAHF around FL with width DELF.
 * `vds` is the signed operating-point drain-source voltage, as ngspice reads
 * it from CKTstate0. ngspice rebuilds gm without the ALPHA (`gmmadd`) term.
 */
export function mesaACConductance(
  state: MESAInstanceState,
  small: MESASmallSignalTerms,
  vds: number,
  frequency: number,
): { gm: number; gds: number } {
  const lambda = state.delf === 0
    ? state.tLambda
    : state.tLambda + 0.5 * (state.tLambdahf - state.tLambda) * (1 + Math.tanh((frequency - state.fl) / state.delf));
  const delidgch = small.delidgch0 * (1 + lambda * vds);
  const delidvds = small.delidvds0 * (1 + 2 * lambda * vds) - small.delidvds1;
  return {
    gm: (delidgch * small.gm0 + small.gm1) * small.gm2,
    gds: delidvds + small.gds0,
  };
}
