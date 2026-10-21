/**
 * BSIM3v3.3.0 model and size-dependent parameters, ported from ngspice-47
 * (src/spicelib/devices/bsim3): model-card names from b3.c, defaults from
 * b3set.c, card value transforms from b3mpar.c and the size-dependent
 * (binned, temperature-adjusted) parameters from b3temp.c. The BSIM3v32
 * revisions 3.2, 3.2.2, 3.2.3 and 3.2.4 (src/spicelib/devices/bsim3v32,
 * b3v32*.c) share these names, defaults and equations except for the
 * revision-dependent blocks marked with b3v32 citations here and in
 * bsim3v3-dc.ts, bsim3v3-charge.ts and bsim3v3.ts.
 *
 * b3v32temp.c size-record reuse (#700): for revisions 3.2 and 3.2.2 an
 * instance whose (L, W) matches a size record already built for its model
 * keeps `pParam` pointing at the most recently *allocated* record (the
 * `pParam = here->pParam` "bug-fix" is guarded by `BSIM3v32intVersion >
 * BSIM3v32V322`), so its instance copies vth0, vfb, vfbzb and u0temp come from
 * the last newly-seen geometry instead of its own. {@link computeBsim3Size}
 * takes that geometry as `copySource`; `BSIM3v3.linkBsim3v32SizeRecordReuse`
 * (bsim3v3.ts) reproduces ngspice's instance order to choose it.
 *
 * Model parameters are keyed by their ngspice card name in lower case. The
 * size-dependent parameters use the b3temp.c `pParam` field names so that
 * the DC evaluator reads like b3ld.c.
 */

import { UnsupportedModelParameterError } from '../errors.js';

/** b3temp.c / b3ld.c physical constants. */
export const EPSOX = 3.453133e-11;
export const EPSSI = 1.03594e-10;
export const CHARGE_Q = 1.60219e-19;
const KBOQ = 8.617087e-5;
const PI = 3.141592654;
export const MAX_EXP = 5.834617425e14;
export const MIN_EXP = 1.713908431e-15;
export const EXP_THRESHOLD = 34.0;
/** ngspice const.h CONSTCtoK and the 27 C nominal temperature (CKTnomTemp). */
const CTOK = 273.15;
export const NOMINAL_TEMPERATURE_K = 27 + CTOK;
/** ngspice const.h CONSTvt0 = CONSTboltz * (27 + CONSTCtoK) / CHARGE. */
export const CONST_VT0 = 1.38064852e-23 * NOMINAL_TEMPERATURE_K / 1.6021766208e-19;

/**
 * BSIM3 `VERSION=` prefixes spice-ts implements: ngspice's BSIM3v32 (3.2.x) device and its
 * default BSIM3 (3.3.0) device.
 */
export const SUPPORTED_BSIM3_VERSIONS: readonly string[] = ['3.2', '3.3'];

/**
 * BSIM3 model revisions: ngspice-47 bsim3v32def.h `BSIM3v32intVersion` values (3.2, 3.2.2,
 * 3.2.3, 3.2.4) of the bsim3v32 device, and 330 for the default bsim3 device (3.3.0).
 */
export const BSIM3_REVISION = { V32: 32, V322: 322, V323: 323, V324: 324, V330: 330 } as const;

/**
 * The BSIM3 revision a LEVEL=8/49 card's `VERSION=` string selects, or undefined when spice-ts
 * (like ngspice for 3.0/3.1 here) does not implement it. Mirrors ngspice-47 inpdomod.c: an absent
 * version or one containing `default` or starting with `3.3` selects the bsim3 device (3.3.0), one
 * starting with `3.2` the bsim3v32 device, and `3.0`/`3.1` BSIM3v0/v1, which spice-ts does not
 * implement; any other string is unavailable in ngspice too. b3v32set.c then maps the string to
 * its integer revision: exactly `3.2.4` or prefix `3.24` -> 3.2.4, likewise 3.2.3 and 3.2.2, and
 * any other `3.2` string -> 3.2. ngspice lower-cases the deck first, so matching ignores case.
 */
export function bsim3Revision(version: string | undefined): number | undefined {
  if (version === undefined) return BSIM3_REVISION.V330;
  const ver = version.toLowerCase();
  if (ver.includes('default') || ver.startsWith('3.3')) return BSIM3_REVISION.V330;
  if (!ver.startsWith('3.2')) return undefined;
  if (ver === '3.2.4' || ver.startsWith('3.24')) return BSIM3_REVISION.V324;
  if (ver === '3.2.3' || ver.startsWith('3.23')) return BSIM3_REVISION.V323;
  if (ver === '3.2.2' || ver.startsWith('3.22')) return BSIM3_REVISION.V322;
  return BSIM3_REVISION.V32;
}

/** Whether a LEVEL=8/49 card's `VERSION=` string selects a BSIM3 revision spice-ts implements. */
export function isSupportedBsim3Version(version: string | undefined): boolean {
  return bsim3Revision(version) !== undefined;
}

/**
 * Card names of the parameters b3temp.c bins with L/W/P (`l<name>`, `w<name>`,
 * `p<name>`), mapped to their b3temp.c pParam field name.
 */
const BINNED: ReadonlyArray<readonly [string, string]> = [
  ['cdsc', 'cdsc'], ['cdscb', 'cdscb'], ['cdscd', 'cdscd'], ['cit', 'cit'],
  ['nfactor', 'nfactor'], ['xj', 'xj'], ['vsat', 'vsat'], ['at', 'at'],
  ['a0', 'a0'], ['ags', 'ags'], ['a1', 'a1'], ['a2', 'a2'], ['keta', 'keta'],
  ['nsub', 'nsub'], ['nch', 'npeak'], ['ngate', 'ngate'], ['gamma1', 'gamma1'],
  ['gamma2', 'gamma2'], ['vbx', 'vbx'], ['vbm', 'vbm'], ['xt', 'xt'], ['vfb', 'vfb'],
  ['k1', 'k1'], ['kt1', 'kt1'], ['kt1l', 'kt1l'], ['k2', 'k2'], ['kt2', 'kt2'],
  ['k3', 'k3'], ['k3b', 'k3b'], ['w0', 'w0'], ['nlx', 'nlx'], ['dvt0', 'dvt0'],
  ['dvt1', 'dvt1'], ['dvt2', 'dvt2'], ['dvt0w', 'dvt0w'], ['dvt1w', 'dvt1w'],
  ['dvt2w', 'dvt2w'], ['drout', 'drout'], ['dsub', 'dsub'], ['vth0', 'vth0'],
  ['ua', 'ua'], ['ua1', 'ua1'], ['ub', 'ub'], ['ub1', 'ub1'], ['uc', 'uc'],
  ['uc1', 'uc1'], ['u0', 'u0'], ['ute', 'ute'], ['voff', 'voff'], ['delta', 'delta'],
  ['rdsw', 'rdsw'], ['prwg', 'prwg'], ['prwb', 'prwb'], ['prt', 'prt'],
  ['eta0', 'eta0'], ['etab', 'etab'], ['pclm', 'pclm'], ['pdiblc1', 'pdibl1'],
  ['pdiblc2', 'pdibl2'], ['pdiblcb', 'pdiblb'], ['pscbe1', 'pscbe1'],
  ['pscbe2', 'pscbe2'], ['pvag', 'pvag'], ['wr', 'wr'], ['dwg', 'dwg'],
  ['dwb', 'dwb'], ['b0', 'b0'], ['b1', 'b1'], ['alpha0', 'alpha0'],
  ['alpha1', 'alpha1'], ['beta0', 'beta0'], ['elm', 'elm'], ['cgsl', 'cgsl'],
  ['cgdl', 'cgdl'], ['ckappa', 'ckappa'], ['cf', 'cf'], ['clc', 'clc'],
  ['cle', 'cle'], ['vfbcv', 'vfbcv'], ['acde', 'acde'], ['moin', 'moin'],
  ['noff', 'noff'], ['voffcv', 'voffcv'],
];

/** b3.c card-name aliases. */
const ALIASES: Readonly<Record<string, string>> = {
  vtho: 'vth0', lvtho: 'lvth0', wvtho: 'wvth0', pvtho: 'pvth0',
};

/**
 * b3set.c defaults that do not depend on the device type, mobMod or other
 * card values. Binned l/w/p coefficients default to 0 and are not listed.
 */
const FIXED_DEFAULTS: Readonly<Record<string, number>> = {
  mobmod: 1, binunit: 1, capmod: 3, acm: 0, xpart: 0,
  tox: 150.0e-10,
  cdsc: 2.4e-4, cdscb: 0, cdscd: 0, cit: 0, nfactor: 1, xj: 0.15e-6,
  vsat: 8.0e4, at: 3.3e4, a0: 1.0, ags: 0, a1: 0, a2: 1.0, keta: -0.047,
  nsub: 6.0e16, nch: 1.7e17, ngate: 0, vbm: -3.0, xt: 1.55e-7,
  kt1: -0.11, kt1l: 0, kt2: 0.022, k3: 80.0, k3b: 0, w0: 2.5e-6, nlx: 1.74e-7,
  dvt0: 2.2, dvt1: 0.53, dvt2: -0.032, dvt0w: 0, dvt1w: 5.3e6, dvt2w: -0.032,
  drout: 0.56, ua: 2.25e-9, ua1: 4.31e-9, ub: 5.87e-19, ub1: -7.61e-18,
  ute: -1.5, voff: -0.08, delta: 0.01, rdsw: 0, prwg: 0, prwb: 0, prt: 0,
  eta0: 0.08, etab: -0.07, pclm: 1.3, pdiblc1: 0.39, pdiblc2: 0.0086,
  pdiblcb: 0, pscbe1: 4.24e8, pscbe2: 1.0e-5, pvag: 0, wr: 1.0, dwg: 0, dwb: 0,
  b0: 0, b1: 0, alpha0: 0, alpha1: 0, beta0: 30.0, ijth: 0.1, elm: 5.0,
  cgsl: 0, cgdl: 0, ckappa: 0.6, clc: 0.1e-6, cle: 0.6, vfbcv: -1.0, acde: 1.0,
  moin: 15.0, noff: 1.0, voffcv: 0,
  // b3set.c leaves these unset unless given; b3temp.c only reads them when given.
  gamma1: 0, gamma2: 0, vbx: 0, vfb: 0, k1: 0, k2: 0,
  tcj: 0, tpb: 0, tcjsw: 0, tpbsw: 0, tcjswg: 0, tpbswg: 0,
  lint: 0, ll: 0, lln: 1.0, lw: 0, lwn: 1.0, lwl: 0, lmin: 0, lmax: 1.0,
  wint: 0, wl: 0, wln: 1.0, ww: 0, wwn: 1.0, wwl: 0, wmin: 0, wmax: 1.0,
  xl: 0, xw: 0, rsh: 0,
  cj: 5.0e-4, cjsw: 5.0e-10, js: 1.0e-4, jsw: 0, pb: 1.0, pbsw: 1.0,
  mj: 0.5, mjsw: 0.33, nj: 1.0, xti: 3.0,
};

/** Resolved BSIM3 model card (b3set.c / b3mpar.c, model-level parts of b3temp.c). */
export interface BSIM3Model {
  /** +1 for NMOS, -1 for PMOS (ngspice BSIM3type). */
  readonly type: number;
  /** Card value by ngspice card name (lower case), defaults applied. */
  readonly values: Readonly<Record<string, number>>;
  /** Whether the card supplied the named parameter (ngspice `...Given`). */
  given(name: string): boolean;
  readonly mobMod: number;
  readonly binUnit: number;
  readonly tox: number;
  readonly toxm: number;
  readonly cox: number;
  /** TNOM in kelvin. */
  readonly tnom: number;
  /** Circuit temperature in kelvin. */
  readonly temp: number;
  /** BSIM3vtm = KboQ * T. */
  readonly vtm: number;
  /** BSIM3factor1 = sqrt(EPSSI / EPSOX * tox). */
  readonly factor1: number;
  /** BSIM3vcrit, the DEVpnjlim critical voltage. */
  readonly vcrit: number;
  readonly jctTempSatCurDensity: number;
  readonly jctSidewallTempSatCurDensity: number;
  readonly jctEmissionCoeff: number;
  readonly ijth: number;
  /** {@link BSIM3_REVISION} the card's VERSION= selects (330 for the default 3.3.0 device). */
  readonly revision: number;
}

/**
 * Build the BSIM3 model from a `.model` card. `card` keys may be in any case
 * (the parser upper-cases them); LEVEL is ignored here. `version` is the
 * card's VERSION= string, which selects the revision ({@link bsim3Revision});
 * the 3.2.x revisions are ngspice-47 bsim3v32 (b3v32set.c, b3v32temp.c,
 * b3v32ld.c), whose card names and defaults are those of the 3.3.0 device
 * plus LMLT.
 */
export function resolveBsim3Model(
  card: Readonly<Record<string, number>>,
  type: number,
  temperatureK: number = NOMINAL_TEMPERATURE_K,
  version?: string,
): BSIM3Model {
  const revision = bsim3Revision(version);
  if (revision === undefined) {
    throw new RangeError(`BSIM3: VERSION=${version} is not an implemented revision (${SUPPORTED_BSIM3_VERSIONS.join(', ')})`);
  }
  const supplied: Record<string, number> = {};
  for (const [key, value] of Object.entries(card)) {
    const lower = key.toLowerCase();
    const name = ALIASES[lower] ?? lower;
    supplied[name] = value;
  }
  // b3mpar.c unit conversions applied as each value is set.
  for (const prefix of ['', 'l', 'w', 'p']) {
    const nch = `${prefix}nch`;
    if (supplied[nch] !== undefined && supplied[nch] > 1.0e20) supplied[nch] *= 1.0e-6;
    const ngate = `${prefix}ngate`;
    const limit = prefix === '' ? 1.000001e24 : 1.0e23;
    if (supplied[ngate] !== undefined && supplied[ngate] > limit) supplied[ngate] *= 1.0e-6;
  }
  const given = (name: string): boolean => supplied[name] !== undefined;

  const values: Record<string, number> = { ...FIXED_DEFAULTS, ...supplied };
  const pick = (name: string, fallback: number): number => supplied[name] ?? fallback;

  const mobMod = values.mobmod;
  values.uc = pick('uc', mobMod === 3 ? -0.0465 : -0.0465e-9);
  values.uc1 = pick('uc1', mobMod === 3 ? -0.056 : -0.056e-9);
  values.u0 = pick('u0', type > 0 ? 0.067 : 0.025);
  values.vth0 = pick('vth0', type > 0 ? 0.7 : -0.7);
  values.dsub = pick('dsub', values.drout);
  values.toxm = pick('toxm', values.tox);
  values.llc = pick('llc', values.ll);
  values.lwc = pick('lwc', values.lw);
  values.lwlc = pick('lwlc', values.lwl);
  values.wlc = pick('wlc', values.wl);
  values.wwc = pick('wwc', values.ww);
  values.wwlc = pick('wwlc', values.wwl);
  values.dwc = pick('dwc', values.wint);
  values.dlc = pick('dlc', values.lint);
  values.cjswg = pick('cjswg', values.cjsw);
  values.pbswg = pick('pbswg', values.pbsw);
  values.mjswg = pick('mjswg', values.mjsw);

  const tox = values.tox;
  const cox = EPSOX / tox;
  values.cf = pick('cf', 2.0 * EPSOX / PI * Math.log(1.0 + 0.4e-6 / tox));
  const overlapDefault = (lateral: number) => (given('dlc') && values.dlc > 0
    ? values.dlc * cox - lateral
    : 0.6 * values.xj * cox);
  values.cgdo = pick('cgdo', overlapDefault(values.cgdl));
  values.cgso = pick('cgso', overlapDefault(values.cgsl));
  values.cgbo = pick('cgbo', 2.0 * values.dwc * cox);

  // b3temp.c model-level quantities.
  const tnom = given('tnom') ? values.tnom + CTOK : NOMINAL_TEMPERATURE_K;
  values.tnom = tnom;
  const temp = temperatureK;
  const vtm0 = KBOQ * tnom;
  const vtm = KBOQ * temp;
  const eg0 = 1.16 - 7.02e-4 * tnom * tnom / (tnom + 1108.0);
  const eg = 1.16 - 7.02e-4 * temp * temp / (temp + 1108.0);
  let jctTempSatCurDensity = values.js;
  let jctSidewallTempSatCurDensity = values.jsw;
  if (temp !== tnom) {
    const t0 = eg0 / vtm0 - eg / vtm + values.xti * Math.log(temp / tnom);
    const t1 = Math.exp(t0 / values.nj);
    jctTempSatCurDensity *= t1;
    jctSidewallTempSatCurDensity *= t1;
  }
  values.pb = Math.max(values.pb, 0.1);
  values.pbsw = Math.max(values.pbsw, 0.1);
  values.pbswg = Math.max(values.pbswg, 0.1);

  return {
    type,
    values,
    given,
    mobMod,
    binUnit: values.binunit,
    tox,
    toxm: values.toxm,
    cox,
    tnom,
    temp,
    vtm,
    factor1: Math.sqrt(EPSSI / EPSOX * tox),
    vcrit: CONST_VT0 * Math.log(CONST_VT0 / (Math.SQRT2 * 1.0e-14)),
    jctTempSatCurDensity: Math.max(jctTempSatCurDensity, 0),
    jctSidewallTempSatCurDensity: Math.max(jctSidewallTempSatCurDensity, 0),
    jctEmissionCoeff: values.nj,
    ijth: values.ijth,
    revision,
  };
}

/** BSIM3 instance parameters (b3par.c), upper- or lower-case keys accepted. */
export interface BSIM3v3InstanceParams {
  W?: number; L?: number;
  AS?: number; AD?: number; PS?: number; PD?: number;
  DELVTO?: number; MULU0?: number; M?: number;
}

/**
 * b3temp.c size-dependent parameters (`pParam`) plus the instance-level
 * values b3temp.c derives from them. Field names follow b3temp.c.
 */
export interface BSIM3Size {
  readonly [field: string]: number;
}

/** Instance parameter lookup accepting the parser's upper-case keys. */
function instanceValue(inst: Readonly<Record<string, number | undefined>>, name: string): number | undefined {
  return inst[name] ?? inst[name.toLowerCase()];
}

/**
 * b3set.c / b3v32set.c instance channel length and width: L and W default to
 * 5 um, and the bsim3v32 device scales L by the lmlt model parameter.
 */
export function bsim3Geometry(
  model: BSIM3Model, inst: Readonly<Record<string, number | undefined>>,
): [length: number, width: number] {
  let L = instanceValue(inst, 'L') ?? 5.0e-6;
  // b3v32set.c: channel length scaling with the lmlt model parameter (bsim3v32 only).
  if (model.revision < BSIM3_REVISION.V330 && model.given('lmlt')) L *= model.values.lmlt;
  return [L, instanceValue(inst, 'W') ?? 5.0e-6];
}

/**
 * b3set.c instance defaults and b3temp.c size-dependent parameters for one
 * instance geometry. Throws when an effective dimension is not positive, as
 * b3temp.c does (E_BADPARM).
 */
export function computeBsim3Size(
  model: BSIM3Model,
  inst: Readonly<Record<string, number | undefined>> & BSIM3v3InstanceParams,
  copySource?: Readonly<Record<string, number | undefined>>,
): BSIM3Size {
  const m = model.values;
  const p: Record<string, number> = {};
  const [L, W] = bsim3Geometry(model, inst);
  // b3v32temp.c pParam->Length / Width, the size-record match key.
  p.length = L;
  p.width = W;
  const tnom = model.tnom;
  const temp = model.temp;
  const tRatio = temp / tnom;
  const vtm0 = KBOQ * tnom;
  const eg0 = 1.16 - 7.02e-4 * tnom * tnom / (tnom + 1108.0);
  const ni = 1.45e10 * (tnom / 300.15) * Math.sqrt(tnom / 300.15)
    * Math.exp(21.5565981 - eg0 / (2.0 * vtm0));

  let t0 = Math.pow(L, m.lln);
  let t1 = Math.pow(W, m.lwn);
  p.dl = m.lint + m.ll / t0 + m.lw / t1 + m.lwl / (t0 * t1);
  p.dlc = m.dlc + m.llc / t0 + m.lwc / t1 + m.lwlc / (t0 * t1);
  const t2w = Math.pow(L, m.wln);
  const t3w = Math.pow(W, m.wwn);
  p.dw = m.wint + m.wl / t2w + m.ww / t3w + m.wwl / (t2w * t3w);
  p.dwc = m.dwc + m.wlc / t2w + m.wwc / t3w + m.wwlc / (t2w * t3w);

  p.leff = L + m.xl - 2.0 * p.dl;
  p.weff = W + m.xw - 2.0 * p.dw;
  p.leffCV = L + m.xl - 2.0 * p.dlc;
  p.weffCV = W + m.xw - 2.0 * p.dwc;
  for (const [label, value] of [
    ['Effective channel length', p.leff], ['Effective channel width', p.weff],
    ['Effective channel length for C-V', p.leffCV], ['Effective channel width for C-V', p.weffCV],
  ] as const) {
    if (!(value > 0)) throw new RangeError(`BSIM3: ${label} <= 0 (${value})`);
  }

  let invL: number; let invW: number; let invLW: number;
  if (model.binUnit === 1) {
    invL = 1.0e-6 / p.leff;
    invW = 1.0e-6 / p.weff;
    invLW = 1.0e-12 / (p.leff * p.weff);
  } else {
    invL = 1.0 / p.leff;
    invW = 1.0 / p.weff;
    invLW = 1.0 / (p.leff * p.weff);
  }
  for (const [card, field] of BINNED) {
    p[field] = m[card] + (m[`l${card}`] ?? 0) * invL + (m[`w${card}`] ?? 0) * invW
      + (m[`p${card}`] ?? 0) * invLW;
  }

  p.abulkCVfactor = 1.0 + Math.pow(p.clc / p.leffCV, p.cle);

  t0 = tRatio - 1.0;
  p.ua += p.ua1 * t0;
  p.ub += p.ub1 * t0;
  p.uc += p.uc1 * t0;
  if (p.u0 > 1.0) p.u0 /= 1.0e4;
  p.u0temp = p.u0 * Math.pow(tRatio, p.ute);
  p.vsattemp = p.vsat - p.at * t0;
  p.rds0 = (p.rdsw + p.prt * t0) / Math.pow(p.weff * 1e6, p.wr);

  p.cgdo = (m.cgdo + p.cf) * p.weffCV;
  p.cgso = (m.cgso + p.cf) * p.weffCV;
  p.cgbo = m.cgbo * p.leffCV;

  const cox = model.cox;
  if (!model.given('nch') && model.given('gamma1')) {
    t0 = p.gamma1 * cox;
    p.npeak = 3.021e22 * t0 * t0;
  }
  p.phi = 2.0 * vtm0 * Math.log(p.npeak / ni);
  p.sqrtPhi = Math.sqrt(p.phi);
  p.phis3 = p.sqrtPhi * p.phi;
  p.Xdep0 = Math.sqrt(2.0 * EPSSI / (CHARGE_Q * p.npeak * 1.0e6)) * p.sqrtPhi;
  p.sqrtXdep0 = Math.sqrt(p.Xdep0);
  p.litl = Math.sqrt(3.0 * p.xj * model.tox);
  p.vbi = vtm0 * Math.log(1.0e20 * p.npeak / (ni * ni));
  p.cdep0 = Math.sqrt(CHARGE_Q * EPSSI * p.npeak * 1.0e6 / 2.0 / p.phi);
  p.ldeb = Math.sqrt(EPSSI * vtm0 / (CHARGE_Q * p.npeak * 1.0e6)) / 3.0;
  p.acde *= Math.pow(p.npeak / 2.0e16, -0.25);

  if (model.given('k1') || model.given('k2')) {
    if (!model.given('k1')) p.k1 = 0.53;
    if (!model.given('k2')) p.k2 = -0.0186;
  } else {
    if (!model.given('vbx')) p.vbx = p.phi - 7.7348e-4 * p.npeak * p.xt * p.xt;
    if (p.vbx > 0.0) p.vbx = -p.vbx;
    if (p.vbm > 0.0) p.vbm = -p.vbm;
    if (!model.given('gamma1')) p.gamma1 = 5.753e-12 * Math.sqrt(p.npeak) / cox;
    if (!model.given('gamma2')) p.gamma2 = 5.753e-12 * Math.sqrt(p.nsub) / cox;
    t0 = p.gamma1 - p.gamma2;
    t1 = Math.sqrt(p.phi - p.vbx) - p.sqrtPhi;
    const t2 = Math.sqrt(p.phi * (p.phi - p.vbm)) - p.phi;
    p.k2 = t0 * t1 / (2.0 * t2 + p.vbm);
    p.k1 = p.gamma2 - 2.0 * p.k2 * Math.sqrt(p.phi - p.vbm);
  }

  if (p.k2 < 0.0) {
    t0 = 0.5 * p.k1 / p.k2;
    p.vbsc = 0.9 * (p.phi - t0 * t0);
    if (p.vbsc > -3.0) p.vbsc = -3.0;
    else if (p.vbsc < -30.0) p.vbsc = -30.0;
  } else {
    p.vbsc = -30.0;
  }
  if (p.vbsc > p.vbm) p.vbsc = p.vbm;

  const type = model.type;
  if (!model.given('vfb')) {
    p.vfb = model.given('vth0') ? type * p.vth0 - p.phi - p.k1 * p.sqrtPhi : -1.0;
  }
  if (!model.given('vth0')) p.vth0 = type * (p.vfb + p.phi + p.k1 * p.sqrtPhi);

  p.k1ox = p.k1 * model.tox / model.toxm;
  p.k2ox = p.k2 * model.tox / model.toxm;

  t1 = Math.sqrt(EPSSI / EPSOX * model.tox * p.Xdep0);
  t0 = Math.exp(-0.5 * p.dsub * p.leff / t1);
  p.theta0vb0 = t0 + 2.0 * t0 * t0;
  t0 = Math.exp(-0.5 * p.drout * p.leff / t1);
  p.thetaRout = p.pdibl1 * (t0 + 2.0 * t0 * t0) + p.pdibl2;

  // vfbzb (capMod 3 flat-band at zero bias).
  const tmp1 = p.vbi - p.phi;
  const tmp2 = model.factor1 * Math.sqrt(p.Xdep0);
  const shortChannelFactor = (exponent: number): number => {
    const e = exponent > -EXP_THRESHOLD ? Math.exp(exponent) : MIN_EXP;
    return e * (1.0 + 2.0 * e);
  };
  const narrowT2 = p.dvt0w * shortChannelFactor(-0.5 * p.dvt1w * p.weff * p.leff / tmp2) * tmp1;
  const shortT3 = p.dvt0 * shortChannelFactor(-0.5 * p.dvt1 * p.leff / tmp2) * tmp1;
  const t4 = model.tox * p.phi / (p.weff + p.w0);
  t0 = Math.sqrt(1.0 + p.nlx / p.leff);
  const t5 = p.k1ox * (t0 - 1.0) * p.sqrtPhi + (p.kt1 + p.kt1l / p.leff) * (tRatio - 1.0);
  const tmp3 = type * p.vth0 - narrowT2 - shortT3 + p.k3 * t4 + t5;
  p.vfbzb = tmp3 - p.phi - p.k1 * p.sqrtPhi;

  // Instance values (delvto, mulu0) and junction saturation currents.
  // b3v32temp.c (3.2, 3.2.2): these copies read `pParam`, which may be the
  // record of another geometry (copySource); see the file comment.
  const delvto = instanceValue(inst, 'DELVTO') ?? 0;
  const mulu0 = instanceValue(inst, 'MULU0') ?? 1;
  const record = copySource ? computeBsim3Size(model, copySource) : p;
  p.instVth0 = record.vth0 + delvto;
  p.instVfb = record.vfb + type * delvto;
  p.instVfbzb = record.vfbzb + type * delvto;
  p.instU0temp = record.u0temp * mulu0;

  p.drainArea = instanceValue(inst, 'AD') ?? 0;
  p.sourceArea = instanceValue(inst, 'AS') ?? 0;
  p.drainPerimeter = instanceValue(inst, 'PD') ?? 0;
  p.sourcePerimeter = instanceValue(inst, 'PS') ?? 0;
  p.m = instanceValue(inst, 'M') ?? 1;
  p.sourceSatCurrent = saturationCurrent(model, p.sourceArea, p.sourcePerimeter);
  p.drainSatCurrent = saturationCurrent(model, p.drainArea, p.drainPerimeter);
  const nvtm = model.vtm * model.jctEmissionCoeff;
  p.vjsm = 0; p.IsEvjsm = 0; p.vjdm = 0; p.IsEvjdm = 0;
  // b3v32temp.c: revision 3.2 leaves IsEvjsm/IsEvjdm unset; its b3v32ld.c
  // linearises the junction above vjsm/vjdm without them (see bsim3v3.ts).
  const isEvj = model.revision !== BSIM3_REVISION.V32;
  if (p.sourceSatCurrent > 0 && model.ijth > 0) {
    p.vjsm = nvtm * Math.log(model.ijth / p.sourceSatCurrent + 1.0);
    if (isEvj) p.IsEvjsm = p.sourceSatCurrent * Math.exp(p.vjsm / nvtm);
  }
  if (p.drainSatCurrent > 0 && model.ijth > 0) {
    p.vjdm = nvtm * Math.log(model.ijth / p.drainSatCurrent + 1.0);
    if (isEvj) p.IsEvjdm = p.drainSatCurrent * Math.exp(p.vjdm / nvtm);
  }
  // Incremental construction above puts this large record in V8 dictionary
  // mode. Copy once at setup so the hot DC/charge parameter reads can use
  // fast properties instead of a hash lookup for every access. Spreading
  // preserves every computed value and the record remains immutable.
  return Object.freeze({ ...p });
}

/** b3ld.c (acmMod = 0) junction saturation current from area and perimeter. */
function saturationCurrent(model: BSIM3Model, area: number, perimeter: number): number {
  if (area <= 0.0 && perimeter <= 0.0) return 1.0e-14;
  return area * model.jctTempSatCurDensity + perimeter * model.jctSidewallTempSatCurDensity;
}

/**
 * Drain/source series resistances of one BSIM3 instance (every revision),
 * from b3set.c / b3v32set.c and b3temp.c / b3v32temp.c with acmMod = 0:
 * NRD and NRS default to 1 square, the resistances are RSH * NRD and
 * RSH * NRS, and a prime node exists only when one is non-zero. b3ld.c stamps
 * `m * drainConductance`, so the parallel multiplier divides the resistance.
 * A non-positive product gives no conductance in b3temp.c and, here, no
 * resistor. Card ACM > 0 (ACM_SourceDrainResistances, with NRD = NRS = 0
 * defaults) is not implemented and is rejected instead of silently
 * simulating acmMod = 0.
 */
export function bsim3SeriesResistances(
  deviceName: string,
  card: Readonly<Record<string, number>>,
  inst: Readonly<Record<string, number | undefined>> | undefined,
): { drain: number; source: number } {
  const lookup = (record: Readonly<Record<string, number | undefined>>, key: string): number | undefined => {
    for (const [k, v] of Object.entries(record)) if (k.toLowerCase() === key) return v;
    return undefined;
  };
  const acmMod = lookup(card, 'acm') ?? 0;
  if (acmMod !== 0) {
    throw new UnsupportedModelParameterError(
      deviceName, 'ACM',
      'the BSIM3 ACM source/drain resistance and junction model (ACM > 0) is not implemented; '
        + 'spice-ts would simulate ACM=0 instead',
      { model: 'BSIM3' },
    );
  }
  const instance = inst ?? {};
  const sheetResistance = lookup(card, 'rsh') ?? 0;
  const m = lookup(instance, 'm') ?? 1;
  const resistance = (squares: number): number => {
    const value = sheetResistance * squares;
    return value > 0 ? value / m : 0;
  };
  return {
    drain: resistance(lookup(instance, 'nrd') ?? 1),
    source: resistance(lookup(instance, 'nrs') ?? 1),
  };
}
