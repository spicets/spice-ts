/**
 * @license
 * Formula adaptation from ngspice-47. Copyright 2025 Vadim Kuznetsov.
 * BSD-3-Clause; full notice and disclaimer in cpline.LICENSE.
 */
import { InvalidCircuitError } from '../../errors.js';
import { real, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';
import { TlineHistory } from './tline-history.js';

/** ngspice-47 src/xspice/icm/tlines/cpline/cfunc.mod:68-76,84-231. */
export function cpline(params: ResolvedXspiceParams): CodeModelBehavior {
  const ze = real(params, 'ze'), zo = real(params, 'zo'), length = real(params, 'l');
  const ere = real(params, 'ere'), ero = real(params, 'ero');
  const ae = real(params, 'ae'), ao = real(params, 'ao');
  if (![ze, zo, length, ere, ero, ae, ao].every(Number.isFinite) || Math.min(ze, zo, length, ere, ero) <= 0 || Math.min(ae, ao) < 0) {
    throw new InvalidCircuitError('XSPICE cpline requires finite positive ze/zo/l/ere/ero and nonnegative ae/ao');
  }
  const z = Math.sqrt(ze * zo);
  // cfunc.mod:179,195-225: BOTH transient modes use l/C0. Upstream ignores
  // ere/ero and ae/ao here; they remain AC-only, not dielectric delay/loss.
  const delay = length / 299792458;
  const self = (ze + zo) / 2, mutual = (ze - zo) / 2;
  type WaveSample = { time: number; waves: Float64Array };
  const history = new TlineHistory<WaveSample>();
  const sample = (time: number, inputs: Float64Array): WaveSample => ({
    time,
    waves: Float64Array.from({ length: 4 }, (_, port) => inputs[4 + port] + self * inputs[port] + mutual * inputs[port ^ 3]),
  });
  return {
    stateful: true, ac: STATIC,
    // cfunc.mod:84-107: attenuation does not change the DC ideal shorts.
    load(call) {
      call.partials.fill(0);
      if (call.analysis === 'tran') {
        history.stage(sample(call.time, call.inputs));
        // cfunc.mod:190-229 leaves every output zero through the initial
        // flight time. This is not a DC short or a precharged ideal line.
        call.outputs.fill(0);
        if (call.time <= delay) return;
        const point = history.find(call.time - delay);
        for (let port = 0; port < 4; port++) {
          const partner = port ^ 1, coupled = port ^ 3;
          call.outputs[port] = self * call.inputs[port] + mutual * call.inputs[coupled];
          call.partials[port * 8 + port] = self;
          call.partials[port * 8 + coupled] = mutual;
          if (point) call.outputs[port] += point.waves[partner];
          else {
            // A step longer than TD selects the current trial in upstream's
            // ceiling lookup. Use instantaneous waves and their Jacobian.
            call.outputs[port] += call.inputs[4 + partner] + self * call.inputs[partner] + mutual * call.inputs[partner ^ 3];
            call.partials[port * 8 + 4 + partner] = 1;
            call.partials[port * 8 + partner] = self;
            call.partials[port * 8 + (partner ^ 3)] = mutual;
          }
        }
        return;
      }
      for (let port = 0; port < 4; port++) {
        const partner = port ^ 1;
        call.outputs[port] = call.inputs[4 + partner] + z * (call.inputs[port] + call.inputs[partner]);
        call.partials[port * 8 + port] = z;
        call.partials[port * 8 + partner] = z;
        call.partials[port * 8 + 4 + partner] = 1;
      }
    },
    accept(call) { history.accept(sample(call.time, call.inputs), delay); },
    reset() { history.reset(); },
    acGains(omega) {
      // cfunc.mod:75-76,140-146: log(10^(.05*a))*l/2, not a*l.
      const terms = [[ze, ere, ae], [zo, ero, ao]].map(([impedance, epsilon, attenuation]) => {
        const a = Math.log(10) * .05 * attenuation * length / 2;
        const b = omega * length / 299792458 * Math.sqrt(epsilon);
        const sr = Math.sinh(a) * Math.cos(b), si = Math.cosh(a) * Math.sin(b);
        const cr = Math.cosh(a) * Math.cos(b), ci = Math.sinh(a) * Math.sin(b);
        const den = 2 * (sr * sr + si * si);
        return [
          { real: impedance * (cr * sr + ci * si) / den, imaginary: impedance * (ci * sr - cr * si) / den },
          { real: impedance * sr / den, imaginary: -impedance * si / den },
        ];
      });
      // cfunc.mod:154-164: 4 outputs by 8 inputs; voltage senses have zero AC gain.
      return Array.from({ length: 32 }, (_, i) => {
        const row = Math.floor(i / 8), col = i % 8;
        if (col >= 4) return { real: 0, imaginary: 0 };
        const kind = (row ^ col) === 0 || (row ^ col) === 3 ? 0 : 1;
        const sign = (row ^ col) >= 2 ? -1 : 1;
        return { real: terms[0][kind].real + sign * terms[1][kind].real, imaginary: terms[0][kind].imaginary + sign * terms[1][kind].imaginary };
      });
    },
  };
}
