/**
 * ngspice-47 xtradev/potentiometer/cfunc.mod (Public Domain).
 * Georgia Tech Research Corporation, Jeffrey P. Murray (1992),
 * modifications by Holger Vogt (2022, 2024).
 * https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/xtradev/potentiometer/cfunc.mod
 */
import { flag, real, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

export function potentiometer(params: ResolvedXspiceParams): CodeModelBehavior {
  // Preserve cfunc.mod's endpoint guards after MIF parameter-limit clamping.
  const requested = real(params, 'position');
  const position = requested <= 0 ? 1e-9 : requested >= 1 ? 0.999999999 : requested;
  const resistance = real(params, 'r');
  const lower = flag(params, 'log')
    ? resistance / 10 ** (position * real(params, 'log_multiplier'))
    : position * resistance;
  const gl = 1 / lower;
  const gu = 1 / (resistance - lower);
  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      // Port-table order is r0, wiper, r1. Currents flow into each port.
      outputs[0] = (inputs[0] - inputs[1]) * gl;
      outputs[2] = (inputs[2] - inputs[1]) * gu;
      outputs[1] = -outputs[0] - outputs[2];
      partials[0] = gl;
      partials[1] = -gl;
      partials[2] = 0;
      partials[3] = -gl;
      partials[4] = gl + gu;
      partials[5] = -gu;
      partials[6] = 0;
      partials[7] = -gu;
      partials[8] = gu;
    },
  };
}
