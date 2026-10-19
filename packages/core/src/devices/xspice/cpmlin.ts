/**
 * @license
 * Formula adaptation from ngspice-47. Copyright 2025 Vadim Kuznetsov.
 * BSD-3-Clause; full notice and disclaimer in cpmlin.LICENSE.
 */
import { InvalidCircuitError } from '../../errors.js';
import { dispersion, microstrip } from './mlin.js';
import { real, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

const C0 = 299792458;
const ZVAC = 120 * Math.PI;
// ngspice-47 tline_common.h:50 defines sqr(x) as (x*x), without
// parentheses around x. Thus sqr(er - 1) evaluates to er - er - 1.
// Preserve that upstream behaviour, not the intended mathematical square.
const LEGACY_ER_SQUARE = -1;
type Mode = { z0: number; epsilon: number };

export class UnsupportedCpmlinError extends InvalidCircuitError {
  readonly code = 'UNSUPPORTED_XSPICE_CPMLIN';
}

/** ngspice-47 msline_common.c:350-419 (Hammerstad, model=0).
 * Thickness is intentionally ignored by this quasi-static model, as upstream.
 */
function quasiStatic(u: number, g: number, er: number): [Mode, Mode] {
  const m = .2175 + (4.113 + (20.36 / g) ** 6) ** (-.251) + Math.log(g ** 10 / (1 + (g / 13.8) ** 10)) / 323;
  const alpha = .5 * Math.exp(-g);
  const psi = 1 + g / 1.45 + g ** 2.09 / 3.95;
  const pe = .8645 * u ** .172 / (psi * (alpha * u ** m + (1 - alpha) * u ** (-m)));
  const n = (1 / 17.7 + Math.exp(-6.424 - .76 * Math.log(g) - (g / .23) ** 5)) * Math.log((10 + 68.3 * g * g) / (1 + 32.5 * g ** 3.093));
  const beta = .2306 + Math.log(g ** 10 / (1 + (g / 3.73) ** 10)) / 301.8 + Math.log(1 + .646 * g ** 1.175) / 5.3;
  const theta = 1.729 + 1.175 * Math.log(1 + .627 / (g + .327 * g ** 2.17));
  const po = pe - theta / psi * Math.exp(beta * u ** (-n) * Math.log(u));
  const r = 1 + .15 * (1 - Math.exp(1 - LEGACY_ER_SQUARE / 8.2) / (1 + g ** (-6)));
  const fo1 = 1 - Math.exp(-.179 * g ** .15 - .328 * g ** r / Math.log(Math.E + (g / 7) ** 2.8));
  const q = Math.exp(-1.366 - g);
  const p = Math.exp(-.745 * g ** .295) / Math.cosh(g ** .68);
  const fo = fo1 * Math.exp(p * Math.log(u) + q * Math.sin(Math.PI * Math.log10(u)));
  const mu = g * Math.exp(-g) + u * (20 + g * g) / (10 + g * g);
  const single = microstrip(u, 1, 0, er);
  return [
    { z0: single.z0 / (1 - single.z0 * pe / ZVAC), epsilon: microstrip(mu, 1, 0, er).epsilon },
    { z0: single.z0 / (1 - single.z0 * po / ZVAC), epsilon: (er + 1) / 2 + fo * (single.epsilon - (er + 1) / 2) },
  ];
}

/** msline_common.c:485-627, disp=0 (Kirschning-Jansen). */
function coupledDispersion(u: number, g: number, tn: number, er: number, fn: number, even: Mode, odd: Mode): [Mode, Mode] {
  let ue = u, uo = u;
  if (tn > 0) {
    const b = u < .1592 ? 2 * Math.PI * u : 1;
    const dw = tn * (1 + Math.log(2 * b / tn)) / Math.PI;
    const dt = tn / (er * g);
    ue = u + dw * (1 - .5 * Math.exp(-.69 * dw / dt));
    uo = ue + dt;
  }
  const p1 = (v: number): number => .27488 * (.6315 + .525 / (1 + .0157 * fn) ** 20) * v - .065683 * Math.exp(-8.7513 * v);
  const p2 = .33622 * (1 - Math.exp(-.03442 * er));
  const p3 = (v: number): number => .0363 * Math.exp(-4.6 * v) * (1 - Math.exp(-((fn / 38.7) ** 4.97)));
  const p4 = 1 + 2.751 * (1 - Math.exp(-((er / 15.916) ** 8)));
  const p5 = .334 * Math.exp(-3.3 * (er / 15) ** 3) + .746;
  const p6 = p5 * Math.exp(-((fn / 18) ** .368));
  const p7 = 1 + 4.069 * p6 * g ** .479 * Math.exp(-1.347 * g ** .595 - .17 * g ** 2.5);
  const fe = p1(ue) * p2 * ((p3(ue) * p4 + .1844 * p7) * fn) ** 1.5763;
  const ee = er - (er - even.epsilon) / (1 + fe);
  const p8 = .7168 * (1 + 1.076 / (1 + .0576 * (er - 1)));
  const p9 = p8 - .7913 * (1 - Math.exp(-((fn / 20) ** 1.424))) * Math.atan(2.481 * (er / 8) ** .946);
  const p10 = .242 * (er - 1) ** .55;
  const p11 = .6366 * (Math.exp(-.3401 * fn) - 1) * Math.atan(1.263 * (uo / 3) ** 1.629);
  const p12 = p9 + (1 - p9) / (1 + 1.183 * uo ** 1.376);
  const p13 = 1.695 * p10 / (.414 + 1.605 * p10);
  const p14 = .8928 + .1072 * (1 - Math.exp(-.42 * (fn / 20) ** 3.215));
  const p15 = Math.abs(1 - .8928 * (1 + p11) * Math.exp(-p13 * g ** 1.092) * p12 / p14);
  const fo = p1(uo) * p2 * ((p3(uo) * p4 + .1844) * fn * p15) ** 1.5763;
  const eo = er - (er - odd.epsilon) / (1 + fo);
  const q11 = .893 * (1 - .3 / (1 + .7 * (er - 1)));
  const q12 = 2.121 * (fn / 20) ** 4.91 / (1 + q11 * (fn / 20) ** 4.91) * Math.exp(-2.87 * g) * g ** .902;
  const q13 = 1 + .038 * (er / 8) ** 5.1;
  const q14 = 1 + 1.203 * (er / 15) ** 4 / (1 + (er / 15) ** 4);
  const q15 = 1.887 * Math.exp(-1.5 * g ** .84) * g ** q14 / (1 + .41 * (fn / 15) ** 3 * u ** (2 / q13) / (.125 + u ** (1.626 / q13)));
  const q16 = q15 * (1 + 9 / (1 + .403 * LEGACY_ER_SQUARE));
  const q17 = .394 * (1 - Math.exp(-1.47 * (u / 7) ** .672)) * (1 - Math.exp(-4.25 * (fn / 20) ** 1.87));
  const q18 = .61 * (1 - Math.exp(-2.31 * (u / 8) ** 1.593)) / (1 + 6.544 * g ** 4.17);
  const q19 = .21 * g ** 4 / (1 + .18 * g ** 4.9) / (1 + .1 * u * u) / (1 + (fn / 24) ** 3);
  const q20 = q19 * (.09 + 1 / (1 + .1 * (er - 1) ** 2.7));
  const q21 = Math.abs(1 - 42.54 * g ** .133 * Math.exp(-.812 * g) * u ** 2.5 / (1 + .033 * u ** 2.5));
  // Kirschning_zl's exponent r17 does not depend on the mode permittivity.
  const r1 = .03891 * er ** 1.4, r2 = .267 * u ** 7;
  const r7 = 1.206 - .3144 * Math.exp(-r1) * (1 - Math.exp(-r2));
  const r10 = .00044 * er ** 2.136 + .0184;
  const r11 = (fn / 19.47) ** 6 / (1 + .0962 * (fn / 19.47) ** 6);
  const r12 = 1 / (1 + .00245 * u * u);
  const r15 = .707 * r10 * (fn / 12.3) ** 1.097;
  const r16 = 1 + .0503 * er * er * r11 * (1 - Math.exp(-((u / 15) ** 6)));
  const q0 = r7 * (1 - 1.1241 * r12 / r16 * Math.exp(-.026 * fn ** 1.15656 - r15));
  const singleEven = dispersion(u, fn, er, even.z0, even.epsilon);
  const re = (fn / 28.843) ** 12;
  const qe = .016 + (.0514 * er * q21) ** 4.524;
  const pe = 4.766 * Math.exp(-3.228 * u ** .641);
  const de = 5.086 * qe * re / (.3838 + .386 * qe) * Math.exp(-22.2 * u ** 1.92) / (1 + 1.2992 * re) * (er - 1) ** 6 / (1 + 10 * (er - 1) ** 6);
  const ce = 1 + 1.275 * (1 - Math.exp(-.004625 * pe * er ** 1.674 * (fn / 18.365) ** 2.745)) - q12 + q16 - q17 + q18 + q20;
  const ze = even.z0 * ((.9408 * singleEven.epsilon ** ce - .9603) / ((.9408 - de) * even.epsilon ** ce - .9603)) ** q0;
  const singleOdd = dispersion(u, fn, er, odd.z0, odd.epsilon);
  const q29 = 15.16 / (1 + .196 * LEGACY_ER_SQUARE);
  const q25 = .3 * fn * fn / (10 + fn * fn) * (1 + 2.333 * LEGACY_ER_SQUARE / (5 + LEGACY_ER_SQUARE));
  const q26 = 30 - 22.2 * ((er - 1) / 13) ** 12 / (1 + 3 * ((er - 1) / 13) ** 12) - q29;
  const q27 = .4 * g ** .84 * (1 + 2.5 * (er - 1) ** 1.5 / (5 + (er - 1) ** 1.5));
  const q28 = .149 * (er - 1) ** 3 / (94.5 + .038 * (er - 1) ** 3);
  const q22 = .925 * (fn / q26) ** 1.536 / (1 + .3 * (fn / 30) ** 1.536);
  const q23 = 1 + .005 * fn * q27 / (1 + .812 * (fn / 15) ** 1.9) / (1 + .025 * u * u);
  const q24 = 2.506 * q28 * u ** .894 / (3.575 + u ** .894) * ((1 + 1.3 * u) * fn / 99.25) ** 4.29;
  const zo = singleOdd.z0 + (odd.z0 * (eo / odd.epsilon) ** q22 - singleOdd.z0 * q23) / (1 + q24 + (.46 * g) ** 2.2 * q25);
  return [{ z0: ze, epsilon: ee }, { z0: zo, epsilon: eo }];
}

export function cpmlin(params: ResolvedXspiceParams): CodeModelBehavior {
  if (real(params, 'model') !== 0 || real(params, 'disp') !== 0) {
    throw new UnsupportedCpmlinError('XSPICE cpmlin supports only model=0 and disp=0');
  }
  const w = real(params, 'w'), h = real(params, 'h'), s = real(params, 's'), er = real(params, 'er');
  const t = real(params, 't'), length = real(params, 'l'), rho = real(params, 'rho'), tand = real(params, 'tand'), d = real(params, 'd');
  if (![w, h, s, er, t, length, rho, tand, d].every(Number.isFinite) || Math.min(w, h, s, length) <= 0 || er <= 1 || Math.min(t, rho, tand, d) < 0) {
    throw new InvalidCircuitError('XSPICE cpmlin requires finite positive w/h/s/l, er>1 and nonnegative t/rho/tand/d');
  }
  const [even, odd] = quasiStatic(w / h, s / h, er);
  const z = Math.sqrt(even.z0 * odd.z0);
  return {
    stateful: false, ac: STATIC,
    // cpmlin/cfunc.mod:125-149. DC pairs 1-2 and 3-4 are ideal shorts.
    load(call) {
      if (call.analysis === 'tran') throw new UnsupportedCpmlinError('XSPICE cpmlin supports OP and AC only');
      call.partials.fill(0);
      for (let port = 0; port < 4; port++) {
        const partner = port ^ 1;
        call.outputs[port] = call.inputs[4 + partner] + z * (call.inputs[port] + call.inputs[partner]);
        call.partials[port * 8 + port] = z;
        call.partials[port * 8 + partner] = z;
        call.partials[port * 8 + 4 + partner] = 1;
      }
    },
    // cpmlin/cfunc.mod:63-94,151-199. No tline_common.c transient history is
    // used: its append/find_cpline_state functions (:105-172) are out of scope.
    acGains(omega) {
      const f = omega / (2 * Math.PI);
      const modes = coupledDispersion(w / h, s / h, t / h, er, f * h * 1e-6, even, odd);
      const rs = Math.sqrt(Math.PI * f * (4 * Math.PI * 1e-7) * rho);
      const skin = rs === 0 ? Infinity : rho / rs;
      const ki = Math.exp(-1.2 * ((even.z0 + odd.z0) / 2 / ZVAC) ** .7);
      // msline_common.c:315-347: losses use quasi-static, not dispersed values.
      const terms = modes.map((mode, index) => {
        const quasi = index === 0 ? even : odd;
        const conductor = t === 0 ? 0 : rs / (quasi.z0 * w) * ki * (1 + 2 / Math.PI * Math.atan(1.4 * (d / skin) ** 2));
        const dielectric = Math.PI * er / (er - 1) * (quasi.epsilon - 1) / Math.sqrt(quasi.epsilon) * tand * f / C0;
        const a = (conductor + dielectric) * length;
        const b = Math.sqrt(mode.epsilon) * omega / C0 * length;
        const sr = Math.sinh(a) * Math.cos(b), si = Math.cosh(a) * Math.sin(b);
        const cr = Math.cosh(a) * Math.cos(b), ci = Math.sinh(a) * Math.sin(b);
        const den = 2 * (sr * sr + si * si);
        return [
          { real: mode.z0 * (cr * sr + ci * si) / den, imaginary: mode.z0 * (ci * sr - cr * si) / den },
          { real: mode.z0 * sr / den, imaginary: -mode.z0 * si / den },
        ];
      });
      const zero = { real: 0, imaginary: 0 };
      return Array.from({ length: 32 }, (_, i) => {
        const row = Math.floor(i / 8), col = i % 8;
        if (col >= 4) return zero;
        const kind = (row ^ col) === 0 || (row ^ col) === 3 ? 0 : 1;
        const sign = (row ^ col) >= 2 ? -1 : 1;
        return { real: terms[0][kind].real + sign * terms[1][kind].real, imaginary: terms[0][kind].imaginary + sign * terms[1][kind].imaginary };
      });
    },
  };
}
