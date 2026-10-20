/**
 * @license
 * Formula adaptation from ngspice-47. Copyright 2025 Vadim Kuznetsov.
 * BSD-3-Clause; full notice and disclaimer in cpline.LICENSE.
 */
import { InvalidCircuitError } from '../../errors.js';
import { real, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

export class UnsupportedCplineError extends InvalidCircuitError {
  readonly code = 'UNSUPPORTED_XSPICE_CPLINE';
}

/** ngspice-47 src/xspice/icm/tlines/cpline/cfunc.mod:68-76,84-164. */
export function cpline(params: ResolvedXspiceParams): CodeModelBehavior {
  const ze = real(params, 'ze'), zo = real(params, 'zo'), length = real(params, 'l');
  const ere = real(params, 'ere'), ero = real(params, 'ero');
  const ae = real(params, 'ae'), ao = real(params, 'ao');
  if (![ze, zo, length, ere, ero, ae, ao].every(Number.isFinite) || Math.min(ze, zo, length, ere, ero) <= 0 || Math.min(ae, ao) < 0) {
    throw new InvalidCircuitError('XSPICE cpline requires finite positive ze/zo/l/ere/ero and nonnegative ae/ao');
  }
  const z = Math.sqrt(ze * zo);
  return {
    stateful: false, ac: STATIC,
    // cfunc.mod:84-107: attenuation does not change the DC ideal shorts.
    load(call) {
      if (call.analysis === 'tran') throw new UnsupportedCplineError('XSPICE cpline transient analysis is not supported; supports OP and AC only');
      call.partials.fill(0);
      for (let port = 0; port < 4; port++) {
        const partner = port ^ 1;
        call.outputs[port] = call.inputs[4 + partner] + z * (call.inputs[port] + call.inputs[partner]);
        call.partials[port * 8 + port] = z;
        call.partials[port * 8 + partner] = z;
        call.partials[port * 8 + 4 + partner] = 1;
      }
    },
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
