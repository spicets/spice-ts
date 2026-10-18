/**
 * @license
 * Formula adaptation from ngspice-47. Copyright 2025 Vadim Kuznetsov.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS”
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
import { InvalidCircuitError } from '../../errors.js';
import { real, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

const C0 = 299792458;
const ZVAC = 120 * Math.PI;

/** ngspice-47 src/xspice/tlines/msline_common.c:104-136,225-248. */
export function microstrip(w: number, h: number, t: number, er: number): { z0: number; epsilon: number } {
  const u = w / h;
  const tn = t / h;
  const du1 = tn === 0 ? 0 : tn / Math.PI * Math.log(1 + 4 * Math.E / tn * Math.tanh(Math.sqrt(6.517 * u)) ** 2);
  const ur = u + du1 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))) / 2;
  const impedance = (v: number): number => {
    const f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / v) ** .7528));
    return ZVAC / (2 * Math.PI) * Math.log(f / v + Math.sqrt(1 + (2 / v) ** 2));
  };
  const a = 1 + Math.log((ur ** 4 + (ur / 52) ** 2) / (ur ** 4 + .432)) / 49 + Math.log(1 + (ur / 18.1) ** 3) / 18.7;
  const b = .564 * ((er - .9) / (er + 3)) ** .053;
  const e = (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / ur) ** (-a * b);
  const zr = impedance(ur);
  return { z0: zr / Math.sqrt(e), epsilon: e * (impedance(u + du1) / zr) ** 2 };
}

export class UnsupportedMlinError extends InvalidCircuitError {
  readonly code = 'UNSUPPORTED_XSPICE_MLIN';
}

/** ngspice-47 msline_common.c:267-311. disp=0 is Kirschning-Jansen. */
export function dispersion(u: number, fn: number, er: number, z0: number, epsilon: number): { z0: number; epsilon: number } {
  const p1 = .27488 + (.6315 + .525 / (1 + .0157 * fn) ** 20) * u - .065683 * Math.exp(-8.7513 * u);
  const p2 = .33622 * (1 - Math.exp(-.03442 * er));
  const p3 = .0363 * Math.exp(-4.6 * u) * (1 - Math.exp(-((fn / 38.7) ** 4.97)));
  const p4 = 1 + 2.751 * (1 - Math.exp(-((er / 15.916) ** 8)));
  const e = er - (er - epsilon) / (1 + p1 * p2 * ((.1844 + p3 * p4) * fn) ** 1.5763);
  const r1 = .03891 * er ** 1.4, r2 = .267 * u ** 7, r3 = 4.766 * Math.exp(-3.228 * u ** .641);
  const r4 = .016 + (.0514 * er) ** 4.524, r5 = (fn / 28.843) ** 12, r6 = 22.20 * u ** 1.92;
  const r7 = 1.206 - .3144 * Math.exp(-r1) * (1 - Math.exp(-r2));
  const r8 = 1 + 1.275 * (1 - Math.exp(-.004625 * r3 * er ** 1.674 * (fn / 18.365) ** 2.745));
  const r9 = 5.086 * r4 * r5 / (.3838 + .386 * r4) * Math.exp(-r6) / (1 + 1.2992 * r5) * (er - 1) ** 6 / (1 + 10 * (er - 1) ** 6);
  const r10 = .00044 * er ** 2.136 + .0184;
  const r11 = (fn / 19.47) ** 6 / (1 + .0962 * (fn / 19.47) ** 6);
  const r12 = 1 / (1 + .00245 * u * u);
  const r13 = .9408 * e ** r8 - .9603, r14 = (.9408 - r9) * epsilon ** r8 - .9603;
  const r15 = .707 * r10 * (fn / 12.3) ** 1.097;
  const r16 = 1 + .0503 * er * er * r11 * (1 - Math.exp(-((u / 15) ** 6)));
  const r17 = r7 * (1 - 1.1241 * r12 / r16 * Math.exp(-.026 * fn ** 1.15656 - r15));
  return { z0: z0 * (r13 / r14) ** r17, epsilon: e };
}

export function mlin(params: ResolvedXspiceParams): CodeModelBehavior {
  if (real(params, 'model') !== 0 || real(params, 'disp') !== 0) {
    throw new UnsupportedMlinError('XSPICE mlin supports only model=0 and disp=0');
  }
  const w = real(params, 'w'), h = real(params, 'h'), t = real(params, 't'), er = real(params, 'er');
  const length = real(params, 'l'), rho = real(params, 'rho'), tand = real(params, 'tand'), d = real(params, 'd');
  if (![w, h, t, er, length, rho, tand, d].every(Number.isFinite) || w <= 0 || h <= 0 || er <= 1 || length <= 0 || Math.min(t, rho, tand, d) < 0) {
    throw new InvalidCircuitError('XSPICE mlin requires finite positive w/h/l, er>1 and nonnegative t/rho/tand/d');
  }
  const { z0, epsilon } = microstrip(w, h, t, er);
  const tranmodel = real(params, 'tranmodel');
  const delay = length * Math.sqrt(epsilon) / C0;
  // ngspice tline_common.c stores port voltage/current samples. Store their
  // travelling-wave sums instead; only accept() may advance this history.
  const history: { time: number; forward: number; reverse: number }[] = [];
  // ngspice appends on every load and get_state() returns the FIRST entry
  // at the ceiling time, i.e. the first Newton guess, not the final solution.
  // Stage that guess separately so a rejected trial cannot enter history.
  let trial: { time: number; forward: number; reverse: number } | undefined;
  return {
    stateful: true, ac: STATIC,
    // ngspice-47 tlines/mlin/cfunc.mod:116-128. DC is ideal, not rho*l/(w*t).
    load(call) {
      if (call.analysis === 'tran') {
        if (tranmodel === 1 && (!trial || trial.time !== call.time)) trial = {
          time: call.time, forward: call.inputs[2] + z0 * call.inputs[0], reverse: call.inputs[3] + z0 * call.inputs[1],
        };
        if (tranmodel !== 0 && tranmodel !== 1) {
          throw new UnsupportedMlinError('XSPICE mlin supports only tranmodel=0 or tranmodel=1');
        }
        if (tranmodel === 1 && call.time > delay) {
          // get_state() selects the first sample at or after TIME-delay.
          // If that is the current trial, use the instantaneous/DC equations
          // below, including their Jacobian. No trial is stored here.
          const point = history.find(point => point.time >= call.time - delay);
          if (point) {
            call.outputs[0] = point.reverse + z0 * call.inputs[0];
            call.outputs[1] = point.forward + z0 * call.inputs[1];
            call.partials.set([z0, 0, 0, 0, 0, z0, 0, 0]);
            return;
          }
        }
      }
      const sum = z0 * (call.inputs[0] + call.inputs[1]);
      call.outputs[0] = call.inputs[3] + sum;
      call.outputs[1] = call.inputs[2] + sum;
      call.partials.set([z0, z0, 0, 1, z0, z0, 1, 0]);
    },
    accept(call) {
      if (tranmodel !== 1) return;
      // Also support replacing an accepted timepoint on restart/rollback.
      while (history.length && history[history.length - 1].time >= call.time) history.pop();
      history.push(trial?.time === call.time ? trial : { time: call.time, forward: call.inputs[2] + z0 * call.inputs[0], reverse: call.inputs[3] + z0 * call.inputs[1] });
      trial = undefined;
      while (history.length > 1 && history[0].time < call.time - 1.2 * delay) history.shift();
    },
    reset() { history.length = 0; trial = undefined; },
    // msline_common.c:315-347 and tlines/mlin/cfunc.mod:130-151.
    acGains(omega) {
      const f = omega / (2 * Math.PI);
      const dispersed = dispersion(w / h, f * h / 1e6, er, z0, epsilon);
      const rs = Math.sqrt(Math.PI * f * (4 * Math.PI * 1e-7) * rho);
      const skin = rs === 0 ? Infinity : rho / rs;
      const conductor = t === 0 ? 0 : rs / (z0 * w) * Math.exp(-1.2 * (z0 / ZVAC) ** .7) * (1 + 2 / Math.PI * Math.atan(1.4 * (d / skin) ** 2));
      const dielectric = Math.PI * er / (er - 1) * (epsilon - 1) / Math.sqrt(epsilon) * tand * f / C0;
      const a = (conductor + dielectric) * length;
      const b = Math.sqrt(dispersed.epsilon) * omega / C0 * length;
      const sr = Math.sinh(a) * Math.cos(b), si = Math.cosh(a) * Math.sin(b);
      const cr = Math.cosh(a) * Math.cos(b), ci = Math.sinh(a) * Math.sin(b);
      const den = sr * sr + si * si;
      const self = { real: dispersed.z0 * (cr * sr + ci * si) / den, imaginary: dispersed.z0 * (ci * sr - cr * si) / den };
      const mutual = { real: dispersed.z0 * sr / den, imaginary: -dispersed.z0 * si / den };
      const zero = { real: 0, imaginary: 0 };
      return [self, mutual, zero, zero, mutual, self, zero, zero];
    },
  };
}
