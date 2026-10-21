import type { BJTParams } from './bjt.js';
import { DEVICE_GMIN, type StampContext } from './device.js';

/** Static Kull epi-region current and analytic Jacobian (ngspice-47 bjtload.c).
 * Node 0 is the intrinsic collector, node 5 the collector-side epi terminal.
 * RCO is not AREA-scaled in ngspice; M multiplies the entire stamp.
 */
export function stampEpiRegion(
  ctx: StampContext, nodes: number[], params: BJTParams, vt: number, multiplier: number,
  smallSignal = false,
): void {
  const [ci, b, , , , cx] = nodes;
  const voltage = (node: number): number => node >= 0 ? ctx.getVoltage(node) : 0;
  const { polarity, RCO, VO, GAMMA } = params;
  const vbc = polarity * (voltage(b) - voltage(ci));
  const vbcx = polarity * (voltage(b) - voltage(cx));
  const vrci = polarity * (voltage(cx) - voltage(ci));
  const gmin = ctx.gmin ?? DEVICE_GMIN;
  let current = vrci / RCO + gmin * vrci;
  let gr = 1 / RCO + gmin;
  let gi = 0;
  let gx = 0;
  if (vrci > 0) {
    const ei = GAMMA * Math.exp(vbc / vt);
    const ex = GAMMA * Math.exp(vbcx / vt);
    const ki = Math.sqrt(1 + ei);
    const kx = Math.sqrt(1 + ex);
    const di = ei / (2 * vt * ki);
    const dx = ex / (2 * vt * kx);
    const correction = vt * (ki - kx - Math.log((1 + ki) / (1 + kx)));
    const ohmic = (vrci + correction) / RCO;
    const quotient = 1 + vrci / VO;
    current = ohmic / quotient + gmin * vrci;
    gr = 1 / (RCO * quotient) - ohmic / (VO * quotient * quotient) + gmin;
    gi = vt * di * ki / (1 + ki) / (RCO * quotient);
    if (smallSignal) {
      // bjtload.c stores this Irci_Vbci for bjtacld.c, including its
      // extra division by rKp1. It differs from the analytic DC Jacobian.
      // Preserve DC Newton's true derivative, but reproduce ngspice's AC matrix.
      const rKp1 = (1 + ki) / (1 + kx);
      gi = vt * (di - di / (1 + ki) / rKp1) / (RCO * quotient);
    }
    gx = -vt * dx * kx / (1 + kx) / (RCO * quotient);
  }
  const equivalent = polarity * multiplier * (current - gr * vrci - gi * vbc - gx * vbcx);
  for (const [row, sign] of [[cx, 1], [ci, -1]]) {
    if (row < 0) continue;
    for (const [col, derivative] of [[cx, gr - gx], [ci, -gr - gi], [b, gi + gx]]) {
      if (col >= 0) ctx.stampG(row, col, sign * multiplier * derivative);
    }
    ctx.stampB(row, -sign * equivalent);
  }
}
