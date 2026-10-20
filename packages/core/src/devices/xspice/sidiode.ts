/**
 * ngspice-47 src/xspice/icm/xtradev/sidiode/cfunc.mod:127-239.
 * Adapted under BSD-3-Clause; see sidiode.LICENSE.
 */
import { real, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

export function sidiode(params: ResolvedXspiceParams): CodeModelBehavior {
  const forward = real(params, 'vfwd');
  const reverse = -real(params, 'vrev');
  const on = 1 / real(params, 'ron');
  const off = 1 / real(params, 'roff');
  const rrev = real(params, 'rrev');
  const rev = rrev === 0 ? on : 1 / rrev;
  const epsilon = real(params, 'epsilon');
  const revepsilon = real(params, 'revepsilon');
  const va = reverse - revepsilon;
  const vd = forward + epsilon;
  const a = revepsilon > 0 ? (off - rev) / revepsilon : 0;
  const b = epsilon > 0 ? (on - off) / epsilon : 0;
  const limit = real(params, 'ilimit');
  const revlimit = -real(params, 'revilimit');
  const ia = off * va + 0.5 * revepsilon * revepsilon * a;
  const id = off * vd + 0.5 * epsilon * epsilon * b;
  return {
    stateful: false, ac: STATIC,
    load(call) {
      const v = call.inputs[0];
      let current: number;
      let conductance: number;
      if (v < va) {
        if (revlimit > -1e29) {
          const t = Math.tanh(rev / revlimit * (v - va));
          current = (revlimit - ia) * t + ia;
          // Preserve ngspice's supplied partial, not the derivative of I(v).
          conductance = rev * (1 - t * t);
        } else {
          current = reverse * off + (v - reverse) * rev;
          conductance = rev;
        }
      } else if (revepsilon > 0 && v < reverse) {
        current = 0.5 * (v - reverse) ** 2 * a + v * off;
        conductance = (v - reverse) * a + off;
      } else if (v >= reverse && v < forward) {
        current = v * off;
        conductance = off;
      } else if (epsilon > 0 && v >= forward && v < vd) {
        current = 0.5 * (v - forward) ** 2 * b + v * off;
        conductance = (v - forward) * b + off;
      } else if (limit < 1e29) {
        const t = Math.tanh(on / limit * (v - vd));
        current = (limit - id) * t + id;
        conductance = on * (1 - t * t);
      } else {
        current = forward * off + (v - forward) * on;
        conductance = on;
      }
      call.outputs[0] = current;
      call.partials[0] = conductance;
    },
  };
}
