import type { ModelParams } from '../types.js';

/**
 * ngspice-47 LTRA (lossy transmission line) model mathematics, ported from
 * src/spicelib/devices/ltra (ltraset.c, ltratemp.c, ltramisc.c). Only the
 * G=0 special cases are supported: LC and RLC in DC/AC/transient, and RC in
 * DC/AC only (its transient convolution kernel is not implemented).
 */

export type LtraSpecialCase = 'LC' | 'RLC' | 'RC';

export interface ResolvedLtraModel {
  resistancePerLength: number;
  inductancePerLength: number;
  capacitancePerLength: number;
  length: number;
  specialCase: LtraSpecialCase;
  /** Characteristic impedance sqrt(L/C) (ngspice LTRAimped). */
  impedance: number;
  /** 1 / impedance (ngspice LTRAadmit). */
  admittance: number;
  /** One-way propagation delay sqrt(LC) * LEN (ngspice LTRAtd). */
  delay: number;
  /** R / (2L) (ngspice LTRAalpha, equal to LTRAbeta for G=0). */
  alpha: number;
  beta: number;
  /** exp(-beta * td) (ngspice LTRAattenuation). */
  attenuation: number;
  /** Integrals of the impulse responses over [0, inf) (ngspice LTRAintH*). */
  intH1dash: number;
  intH2: number;
  intH3dash: number;
  /**
   * Largest timestep that keeps the piecewise-linear impulse-response
   * integration accurate (ngspice LTRAmaxSafeStep; RLC only, else Infinity).
   */
  maxSafeStep: number;
  /** REL: relative slope change of an outgoing wave that sets a breakpoint (ngspice LTRAreltol, default 1). */
  breakpointReltol: number;
  /** Absolute slope change for the same rule (ngspice LTRAabstol; ABS stays unsupported, so always 1). */
  breakpointAbstol: number;
  /** Circuit RELTOL and ABSTOL for the LTRAaccept steady-waveform check. */
  circuitReltol: number;
  circuitAbstol: number;
  /**
   * ngspice LTRAstepLimit: true (STEPLIMIT, the ltraset.c default) bounds
   * every step by the delay; false (NOSTEPLIMIT) only when the incoming wave
   * slope changes (ltratrun.c).
   */
  stepLimit: boolean;
  /** ngspice LTRAtruncDontCut (TRUNCDONTCUT): skip the RLC maxSafeStep bound. */
  truncDontCut: boolean;
  /** ngspice delayed-wave interpolation selector (default QUADINTERP). */
  interpolation: 'linear' | 'quadratic' | 'mixed';
  warnings: readonly string[];
}

export interface LtraTolerances {
  /** Circuit RELTOL, the default for `COMPACTREL`. */
  reltol: number;
  /** Circuit ABSTOL, the default for `COMPACTABS`. */
  abstol: number;
}

const DEFAULT_TOLERANCES: LtraTolerances = { reltol: 1e-3, abstol: 1e-12 };

function requireFinite(
  params: Record<string, number>,
  name: string,
  predicate: (value: number) => boolean,
): number {
  const value = params[name];
  if (value === undefined || !Number.isFinite(value) || !predicate(value)) {
    throw new Error(`Unsupported LTRA model: ${name} must be ${name === 'R' || name === 'L' ? 'non-negative and finite' : 'positive and finite'}`);
  }
  return value;
}

function optionalNonNegative(params: Record<string, number>, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Unsupported LTRA model: ${name} must be non-negative and finite`);
  }
  return value;
}

export function resolveLtraModel(
  model: ModelParams,
  tolerances: LtraTolerances = DEFAULT_TOLERANCES,
): ResolvedLtraModel {
  if (model.type !== 'LTRA') {
    throw new Error(`Unsupported lossy transmission-line model type '${model.type}'`);
  }
  const conductance = model.params.G ?? 0;
  if (!Number.isFinite(conductance) || conductance !== 0) {
    throw new Error('Unsupported LTRA model: only G=0 is supported');
  }
  const resistancePerLength = requireFinite(model.params, 'R', value => value >= 0);
  const inductancePerLength = requireFinite(model.params, 'L', value => value >= 0);
  if (inductancePerLength === 0 && resistancePerLength === 0) {
    throw new Error('Unsupported LTRA model: R and L cannot both be zero');
  }
  const capacitancePerLength = requireFinite(model.params, 'C', value => value > 0);
  const length = requireFinite(model.params, 'LEN', value => value > 0);
  // ltraset.c: REL defaults to 1. It steers the LTRAaccept breakpoints.
  const breakpointReltol = optionalNonNegative(model.params, 'REL') ?? 1;
  // ltraset.c:75-77 keeps NOCONTROL unless FULLCONTROL/HALFCONTROL is given.
  // The LTRAlteCalculate truncation-error control and its TRUNCNR Newton
  // search (ltratrun.c:129-186) are not ported.
  for (const flag of ['FULLCONTROL', 'HALFCONTROL']) {
    if (model.params[flag]) throw new Error(`Unsupported LTRA model: ${flag} is not supported`);
  }
  // ltraset.c: a zero or omitted straight-line tolerance takes RELTOL/ABSTOL.
  const stLineReltol = optionalNonNegative(model.params, 'COMPACTREL') || tolerances.reltol;
  const stLineAbstol = optionalNonNegative(model.params, 'COMPACTABS') || tolerances.abstol;

  // ltratemp.c
  const specialCase: LtraSpecialCase = inductancePerLength === 0 ? 'RC' : resistancePerLength === 0 ? 'LC' : 'RLC';
  const impedance = Math.sqrt(inductancePerLength / capacitancePerLength);
  const delay = Math.sqrt(inductancePerLength * capacitancePerLength) * length;
  let alpha = 0;
  let attenuation = 1;
  let intH1dash = 0;
  let intH2 = 0;
  let intH3dash = 0;
  let maxSafeStep = Infinity;
  if (specialCase === 'RLC') {
    alpha = 0.5 * (resistancePerLength / inductancePerLength);
    attenuation = Math.exp(-alpha * delay);
    intH1dash = -1;
    intH2 = 1 - attenuation;
    intH3dash = -attenuation;
    maxSafeStep = rlcMaxSafeStep(delay, alpha, stLineReltol, stLineAbstol);
  }
  return {
    resistancePerLength,
    inductancePerLength,
    capacitancePerLength,
    length,
    specialCase,
    impedance,
    admittance: 1 / impedance,
    delay,
    alpha,
    beta: alpha,
    attenuation,
    intH1dash,
    intH2,
    intH3dash,
    maxSafeStep,
    breakpointReltol,
    breakpointAbstol: 1,
    circuitReltol: tolerances.reltol,
    circuitAbstol: tolerances.abstol,
    // ltraset.c:73-74: anything but NOSTEPLIMIT is STEPLIMIT.
    stepLimit: !model.params.NOSTEPLIMIT,
    truncDontCut: Boolean(model.params.TRUNCDONTCUT),
    interpolation: model.params.LININTERP ? 'linear' : model.params.MIXEDINTERP ? 'mixed' : 'quadratic',
    warnings: model.params.TRUNCNR
      ? [`${model.name}: TRUNCNR accepted but Newton LTE timestep search is not implemented; NOCONTROL is used (ngspice default).`]
      : [],
  };
}

/**
 * ltratemp.c: bisect for the largest step past the delay over which h2 stays
 * a straight line. ngspice checks the h2 samples twice (never h3dash); kept.
 */
function rlcMaxSafeStep(td: number, alpha: number, reltol: number, abstol: number): number {
  const beta = alpha;
  let xbig = td + 9 * td;
  const xsmall = td;
  let xmid = 0.5 * (xbig + xsmall);
  const y1small = rlcH2Func(xsmall, td, alpha, beta);
  const maxiter = 50;
  let iters = 0;
  for (;;) {
    iters++;
    const y1big = rlcH2Func(xbig, td, alpha, beta);
    const y1mid = rlcH2Func(xmid, td, alpha, beta);
    const done = straightLineCheck(xbig, y1big, xmid, y1mid, xsmall, y1small, reltol, abstol)
      + straightLineCheck(xbig, y1big, xmid, y1mid, xsmall, y1small, reltol, abstol);
    if (done === 2 || iters > maxiter) break;
    xbig = xmid;
    xmid = 0.5 * (xbig + xsmall);
  }
  return xbig - td;
}

// ltramisc.c numerics. The Numerical Recipes Bessel approximations are kept
// verbatim so the convolution matches ngspice to rounding.

function bessI0(x: number): number {
  const ax = Math.abs(x);
  if (ax < 3.75) {
    let y = x / 3.75;
    y *= y;
    return 1.0 + y * (3.5156229 + y * (3.0899424 + y * (1.2067492
      + y * (0.2659732 + y * (0.360768e-1 + y * 0.45813e-2)))));
  }
  const y = 3.75 / ax;
  return (Math.exp(ax) / Math.sqrt(ax)) * (0.39894228 + y * (0.1328592e-1
    + y * (0.225319e-2 + y * (-0.157565e-2 + y * (0.916281e-2
      + y * (-0.2057706e-1 + y * (0.2635537e-1 + y * (-0.1647633e-1
        + y * 0.392377e-2))))))));
}

function bessI1(x: number): number {
  const ax = Math.abs(x);
  let ans: number;
  if (ax < 3.75) {
    let y = x / 3.75;
    y *= y;
    ans = ax * (0.5 + y * (0.87890594 + y * (0.51498869 + y * (0.15084934
      + y * (0.2658733e-1 + y * (0.301532e-2 + y * 0.32411e-3))))));
  } else {
    const y = 3.75 / ax;
    ans = 0.2282967e-1 + y * (-0.2895312e-1 + y * (0.1787654e-1 - y * 0.420059e-2));
    ans = 0.39894228 + y * (-0.3988024e-1 + y * (-0.362018e-2
      + y * (0.163801e-2 + y * (-0.1031555e-1 + y * ans))));
    ans *= Math.exp(ax) / Math.sqrt(ax);
  }
  return x < 0 ? -ans : ans;
}

function bessI1xOverX(x: number): number {
  const ax = Math.abs(x);
  if (ax < 3.75) {
    let y = x / 3.75;
    y *= y;
    return 0.5 + y * (0.87890594 + y * (0.51498869 + y * (0.15084934
      + y * (0.2658733e-1 + y * (0.301532e-2 + y * 0.32411e-3)))));
  }
  const y = 3.75 / ax;
  let ans = 0.2282967e-1 + y * (-0.2895312e-1 + y * (0.1787654e-1 - y * 0.420059e-2));
  ans = 0.39894228 + y * (-0.3988024e-1 + y * (-0.362018e-2
    + y * (0.163801e-2 + y * (-0.1031555e-1 + y * ans))));
  return ans * (Math.exp(ax) / (ax * Math.sqrt(ax)));
}

/** ltramisc.c LTRArlcH2Func. */
export function rlcH2Func(time: number, T: number, alpha: number, beta: number): number {
  if (alpha === 0 || time < T) return 0;
  const besselarg = time !== T ? alpha * Math.sqrt(time * time - T * T) : 0;
  return alpha * alpha * T * Math.exp(-beta * time) * bessI1xOverX(besselarg);
}

/** ltramisc.c intlinfunc: integral of a linear segment. */
function intlinfunc(lolimit: number, hilimit: number, lovalue: number, hivalue: number, t1: number, t2: number): number {
  const width = t2 - t1;
  if (width === 0) return 0;
  const m = (hivalue - lovalue) / width;
  return (hilimit - lolimit) * lovalue
    + 0.5 * m * ((hilimit - t1) * (hilimit - t1) - (lolimit - t1) * (lolimit - t1));
}

/** ltramisc.c twiceintlinfunc: repeated integral of a linear segment. */
function twiceintlinfunc(
  lolimit: number, hilimit: number, otherlolimit: number,
  lovalue: number, hivalue: number, t1: number, t2: number,
): number {
  const width = t2 - t1;
  if (width === 0) return 0;
  const m = (hivalue - lovalue) / width;
  const temp1 = hilimit - t1;
  const temp2 = lolimit - t1;
  const temp3 = otherlolimit - t1;
  let dummy = lovalue * ((hilimit - otherlolimit) * (hilimit - otherlolimit)
    - (lolimit - otherlolimit) * (lolimit - otherlolimit));
  dummy += m * ((temp1 * temp1 * temp1 - temp2 * temp2 * temp2) / 3.0
    - temp3 * temp3 * (hilimit - lolimit));
  return dummy * 0.5;
}

/** ltramisc.c LTRAstraightLineCheck (area criterion): 1 when straight, else 0. */
export function straightLineCheck(
  x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
  reltol: number, abstol: number,
): number {
  const quadArea1 = (Math.abs(y2) + Math.abs(y1)) * 0.5 * Math.abs(x2 - x1);
  const quadArea2 = (Math.abs(y3) + Math.abs(y2)) * 0.5 * Math.abs(x3 - x2);
  const quadArea3 = (Math.abs(y3) + Math.abs(y1)) * 0.5 * Math.abs(x3 - x1);
  const triangleArea = Math.abs(quadArea3 - quadArea1 - quadArea2);
  const area = quadArea1 + quadArea2;
  return area * reltol + abstol > triangleArea ? 1 : 0;
}

/** ltramisc.c LTRAquadInterp; undefined on coincident abscissae. */
export function quadInterp(t: number, t1: number, t2: number, t3: number): [number, number, number] | undefined {
  if (t === t1) return [1, 0, 0];
  if (t === t2) return [0, 1, 0];
  if (t === t3) return [0, 0, 1];
  if (t2 - t1 === 0 || t3 - t2 === 0 || t1 - t3 === 0) return undefined;
  let f1 = (t - t2) * (t - t3);
  let f2 = (t - t1) * (t - t3);
  let f3 = (t - t1) * (t - t2);
  f1 /= t1 - t2;
  f2 /= t2 - t1;
  f2 /= t2 - t3;
  f3 /= t2 - t3;
  f1 /= t1 - t3;
  f3 /= t1 - t3;
  return [f1, f2, f3];
}

/** ltramisc.c LTRAlinInterp; undefined on coincident abscissae. */
export function linInterp(t: number, t1: number, t2: number): [number, number] | undefined {
  if (t1 === t2) return undefined;
  if (t === t1) return [1, 0];
  if (t === t2) return [0, 1];
  const temp = (t - t1) / (t2 - t1);
  return [1 - temp, temp];
}

/** Convolution coefficients of one RLC trial timepoint (LTRArlcCoeffsSetup). */
export interface RlcCoefficients {
  h1dashFirst: number;
  h2First: number;
  h3dashFirst: number;
  /** Indexed by accepted-timepoint index; entry 0 is unused. */
  h1dash: Float64Array;
  h2: Float64Array;
  h3dash: Float64Array;
  /** Last timepoint index whose h2/h3dash coefficients apply (LTRAauxIndex). */
  auxIndex: number;
}

function coefficientStorage(size: number, previous?: RlcCoefficients): RlcCoefficients {
  if (previous && previous.h1dash.length >= size) return previous;
  const capacity = Math.max(size, 2 * (previous?.h1dash.length ?? 0), 64);
  return {
    h1dashFirst: 0,
    h2First: 0,
    h3dashFirst: 0,
    h1dash: new Float64Array(capacity),
    h2: new Float64Array(capacity),
    h3dash: new Float64Array(capacity),
    auxIndex: 0,
  };
}

/**
 * ltramisc.c LTRArlcCoeffsSetup with LTRAchopReltol = 0 (the ngspice
 * default): piecewise-linear convolution coefficients of h1', h2 and h3' at
 * the trial time `curtime` against accepted timepoints `timelist[0..timeindex]`.
 * Pass the previous result as `storage` to reuse its arrays.
 */
export function rlcCoeffsSetup(
  T: number,
  alpha: number,
  beta: number,
  curtime: number,
  timelist: ArrayLike<number>,
  timeindex: number,
  reltol: number,
  storage?: RlcCoefficients,
): RlcCoefficients {
  const result = coefficientStorage(timeindex + 1, storage);
  const { h1dash: h1dashcoeffs, h2: h2coeffs, h3dash: h3dashcoeffs } = result;

  let auxindex: number;
  if (T === 0) {
    auxindex = timeindex;
  } else if (curtime - T <= 0) {
    auxindex = 0;
  } else {
    let exact = false;
    let i: number;
    for (i = timeindex; i >= 0; i--) {
      if (curtime - timelist[i] === T) {
        exact = true;
        break;
      }
      if (curtime - timelist[i] > T) break;
    }
    auxindex = exact ? i - 1 : i;
  }

  let lolimit1: number;
  let hilimit1: number;
  let lolimit2: number;
  let hilimit2: number;
  let delta1: number;
  let besselarg = 0;
  let expterm: number;
  let h2dummy1 = 0;
  let h2lovalue1 = 0;
  let h2hivalue1 = 0;
  let h3dummy1 = 0;
  let h3hivalue1 = 0;
  let expbetaTterm = 0;
  let alphasqTterm = 0;
  let h2relval = 0;
  let h3relval = 0;

  if (auxindex !== 0) {
    lolimit1 = T;
    hilimit1 = curtime - timelist[auxindex];
    delta1 = hilimit1 - lolimit1;
    h2lovalue1 = rlcH2Func(T, T, alpha, beta);
    besselarg = hilimit1 > T ? alpha * Math.sqrt(hilimit1 * hilimit1 - T * T) : 0;
    expterm = Math.exp(-beta * hilimit1);
    alphasqTterm = alpha * alpha * T;
    h2hivalue1 = alpha === 0 || hilimit1 < T ? 0 : alphasqTterm * expterm * bessI1xOverX(besselarg);
    h2dummy1 = twiceintlinfunc(lolimit1, hilimit1, lolimit1, h2lovalue1, h2hivalue1, lolimit1, hilimit1) / delta1;
    result.h2First = h2dummy1;
    h2relval = Math.abs(reltol * h2dummy1);
    expbetaTterm = Math.exp(-beta * T);
    h3hivalue1 = hilimit1 <= T || beta === 0 ? 0 : expterm * bessI0(besselarg) - expbetaTterm;
    h3dummy1 = intlinfunc(lolimit1, hilimit1, 0, h3hivalue1, lolimit1, hilimit1) / delta1;
    result.h3dashFirst = h3dummy1;
    h3relval = Math.abs(h3dummy1 * reltol);
  } else {
    result.h2First = 0;
    result.h3dashFirst = 0;
  }

  lolimit1 = 0;
  hilimit1 = curtime - timelist[timeindex];
  delta1 = hilimit1 - lolimit1;
  let exparg = -beta * hilimit1;
  expterm = Math.exp(exparg);
  let h1hivalue1 = beta === 0
    ? hilimit1
    : hilimit1 === 0 ? 0 : (bessI1(-exparg) + bessI0(-exparg)) * hilimit1 * expterm - hilimit1;
  let h1dummy1 = h1hivalue1 / delta1;
  result.h1dashFirst = h1dummy1;
  const h1relval = Math.abs(h1dummy1 * reltol);

  let doh1 = true;
  let doh2 = true;
  let doh3 = true;
  for (let i = timeindex; i > 0; i--) {
    if (!doh1 && !doh2 && !doh3) {
      // ngspice keeps looping only to write zeros.
      for (let j = i; j > 0; j--) {
        h1dashcoeffs[j] = 0;
        if (j <= auxindex) {
          h2coeffs[j] = 0;
          h3dashcoeffs[j] = 0;
        }
      }
      break;
    }
    lolimit2 = lolimit1;
    hilimit2 = hilimit1;
    lolimit1 = hilimit2;
    hilimit1 = curtime - timelist[i - 1];
    delta1 = timelist[i] - timelist[i - 1];
    exparg = -beta * hilimit1;
    expterm = Math.exp(exparg);

    if (doh1) {
      const h1lovalue1 = h1hivalue1;
      const h1dummy2 = h1dummy1;
      h1hivalue1 = beta === 0
        ? hilimit1
        : hilimit1 === 0 ? 0 : (bessI1(-exparg) + bessI0(-exparg)) * hilimit1 * expterm - hilimit1;
      h1dummy1 = (h1hivalue1 - h1lovalue1) / delta1;
      h1dashcoeffs[i] = h1dummy1 - h1dummy2;
      if (Math.abs(h1dashcoeffs[i]) <= h1relval) doh1 = false;
    } else {
      h1dashcoeffs[i] = 0;
    }

    if (i <= auxindex) {
      if (doh2 || doh3) {
        besselarg = hilimit1 > T ? alpha * Math.sqrt(hilimit1 * hilimit1 - T * T) : 0;
      }
      if (doh2) {
        const h2lovalue2 = h2lovalue1;
        const h2hivalue2 = h2hivalue1;
        const h2dummy2 = h2dummy1;
        h2lovalue1 = h2hivalue2;
        h2hivalue1 = alpha === 0 || hilimit1 < T ? 0 : alphasqTterm * expterm * bessI1xOverX(besselarg);
        h2dummy1 = twiceintlinfunc(lolimit1, hilimit1, lolimit1, h2lovalue1, h2hivalue1, lolimit1, hilimit1) / delta1;
        h2coeffs[i] = h2dummy1 - h2dummy2
          + intlinfunc(lolimit2, hilimit2, h2lovalue2, h2hivalue2, lolimit2, hilimit2);
        if (Math.abs(h2coeffs[i]) <= h2relval) doh2 = false;
      } else {
        h2coeffs[i] = 0;
      }
      if (doh3) {
        const h3lovalue1 = h3hivalue1;
        const h3dummy2 = h3dummy1;
        h3hivalue1 = hilimit1 <= T || beta === 0 ? 0 : expterm * bessI0(besselarg) - expbetaTterm;
        h3dummy1 = intlinfunc(lolimit1, hilimit1, h3lovalue1, h3hivalue1, lolimit1, hilimit1) / delta1;
        h3dashcoeffs[i] = h3dummy1 - h3dummy2;
        if (Math.abs(h3dashcoeffs[i]) <= h3relval) doh3 = false;
      } else {
        h3dashcoeffs[i] = 0;
      }
    }
  }
  result.auxIndex = auxindex;
  return result;
}
