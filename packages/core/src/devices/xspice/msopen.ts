/**
 * @license
 * Formula adaptation from ngspice-47. Copyright 2025 Vadim Kuznetsov.
 * BSD-3-Clause; full notice and disclaimer in msopen.LICENSE.
 */
import { InvalidCircuitError } from '../../errors.js';
import { dispersion, microstrip } from './mlin.js';
import { real, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

export class UnsupportedMsopenError extends InvalidCircuitError {
  readonly code = 'UNSUPPORTED_XSPICE_MSOPEN';
}

/** ngspice-47 tlines/msopen/cfunc.mod. No DC or transient capacitance is stamped. */
export function msopen(params: ResolvedXspiceParams): CodeModelBehavior {
  const model = real(params, 'msopen_model');
  if (real(params, 'model') !== 0 || real(params, 'disp') !== 0 || ![0, 1, 2].includes(model)) {
    throw new UnsupportedMsopenError('XSPICE msopen supports only model=0, disp=0 and msopen_model=0,1,2');
  }
  const w = real(params, 'w'), h = real(params, 'h'), t = real(params, 't'), er = real(params, 'er');
  if (![w, h, t, er].every(Number.isFinite) || w <= 0 || h <= 0 || er <= 1 || t < 0) {
    throw new InvalidCircuitError('XSPICE msopen requires finite positive w/h, er>1 and nonnegative t');
  }
  const { z0, epsilon } = microstrip(w, h, t, er);
  const u = w / h, tn = t / h;
  // mslineAnalyseDispersion receives WEff, not the physical width. Unlike
  // mlin, msopen includes the Hammerstad thickness correction in dispersion.
  const du1 = tn === 0 ? 0 : tn / Math.PI * Math.log(1 + 4 * Math.E / tn * Math.tanh(Math.sqrt(6.517 * u)) ** 2);
  const ur = u + du1 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))) / 2;
  return {
    stateful: false, ac: STATIC,
    load(call) {
      if (call.analysis === 'tran') throw new UnsupportedMsopenError('XSPICE msopen supports OP and AC only');
      call.outputs.fill(0);
      call.partials.fill(0);
    },
    acGains(omega) {
      const effective = dispersion(ur, omega / (2 * Math.PI) * h / 1e6, er, z0, epsilon);
      if (model === 2) {
        const scale = h / 2.54e-5 / 25;
        const c1 = (1.125 * Math.tanh(1.358 * u) - .315) * scale / effective.z0 * 1e-12;
        const c2 = (6.832 * Math.tanh(.0109 * u) + .919) * scale / effective.z0 * 1e-12;
        const l2 = (.008285 * Math.tanh(.5665 * u) + .0103) * scale * effective.z0 * 1e-9;
        const r2 = 1.024 * Math.tanh(2.025 * u) * effective.z0;
        const x = l2 * omega - 1 / c2 / omega;
        const denominator = r2 * r2 + x * x;
        return [{ real: r2 / denominator, imaginary: c1 * omega - x / denominator }];
      }
      let dl: number;
      if (model === 0) {
        const q6 = effective.epsilon ** .81, q7 = u ** .8544;
        const q1 = .434907 * (q6 + .26) / (q6 - .189) * (q7 + .236) / (q7 + .87);
        const q2 = u ** .371 / (2.358 * er + 1) + 1;
        const q3 = Math.atan(.084 * u ** (1.9413 / q2)) * .5274 / effective.epsilon ** .9236 + 1;
        const q4 = .0377 * (6 - 5 * Math.exp(.036 * (1 - er))) * Math.atan(.067 * u ** 1.456) + 1;
        const q5 = 1 - .218 * Math.exp(-7.5 * u);
        dl = q1 * q3 * q5 / q4;
      } else {
        dl = .102 * (u + .106) / (u + .264) * (1.166 + (er + 1) / er * (.9 + Math.log(u + 2.475)));
      }
      const capacitance = dl * h * Math.sqrt(effective.epsilon) / 299792458 / effective.z0;
      return [{ real: 0, imaginary: omega * capacitance }];
    },
  };
}
