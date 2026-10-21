// BSIM4 b4ld.c:3339-3913 (generated intrinsic CTM), 4149-4177 (overlap).
// Upstream a80f6e3e95d51534905b1f23410a951802666656, ECL-2.0; see NOTICE-BSIM4.txt.
import { UnsupportedModelParameterError } from '../../errors.js';
import type { Bsim4Preprocessed } from './temp.js';
import type { Bsim4ModelParameter } from './params.js';
import type { Bsim4Bias } from './load.js';
import { applyLoad } from './load-kernel.js';
import type { Bsim4LoadInstance, Bsim4LoadSize } from './load-kernel.js';

/** Polarity-normalized physical D,G,S,B charges and row-major Jacobian. */
export function evaluateBsim4Charges(p: Bsim4Preprocessed, given: ReadonlySet<Bsim4ModelParameter>, bias: Bsim4Bias,
  junction?: { vbs: number; vbd: number; stamp: (other: number, charge: number, capacitance: number) => void },
  midgate?: { bias: Bsim4Bias; stamp: (other: number, charge: number, capacitance: number) => void },
): { q: number[]; jacobian: Float64Array } {
  if (p.model.capmod !== 2) throw new UnsupportedModelParameterError('', 'capmod', 'BSIM4 transient requires capMod=2');
  if (p.size.ckappas < 0.02 || p.size.ckappad < 0.02) {
    throw new UnsupportedModelParameterError('', 'ckappa', 'BSIM4 charge requires ckappas/ckappad >= 0.02');
  }
  const h = { ...p.instance } as Bsim4LoadInstance;
  applyLoad(p.model, given, h, p.size as Bsim4LoadSize, p.temperatureK, bias.vgs, bias.vds, bias.vbs, true);
  const q = [0, 0, 0, 0];
  const jacobian = new Float64Array(16);
  // Swap both rows and columns in reverse mode; bulk junctions/overlap stay physical.
  const map = h.mode > 0 ? [0, 1, 2, 3] : [2, 1, 0, 3];
  if (p.model.xpart >= 0) {
    const values = [h.qdrn, h.qgate, h.qsrc, h.qbulk];
    const rows = [
      [h.cddb, h.cdgb, h.cdsb, h.cdbb],
      [h.cgdb, h.cggb, h.cgsb, h.cgbb],
      [h.csdb, h.csgb, h.cssb, h.csbb],
      [h.cbdb, h.cbgb, h.cbsb, h.cbbb],
    ];
    for (let r = 0; r < 4; r++) {
      q[map[r]] = values[r];
      for (let c = 0; c < 4; c++) jacobian[4 * map[r] + map[c]] = rows[r][c];
    }
  }
  const pair = (other: number, charge: number, capacitance: number) => {
    if (midgate) { midgate.stamp(other, charge, capacitance); return; }
    q[1] += charge;
    q[other] -= charge;
    jacobian[5] += capacitance;
    jacobian[4 + other] -= capacitance;
    jacobian[4 * other + 1] -= capacitance;
    jacobian[5 * other] += capacitance;
  };
  const overlap = (other: number, voltage: number, cgo: number, cgl: number, kappa: number) => {
    const t0 = voltage + 0.02;
    const t1 = Math.sqrt(t0 * t0 + 0.08);
    const t2 = 0.5 * (t0 - t1);
    const t3 = p.size.weffCV * cgl;
    const t4 = Math.sqrt(1 - 4 * t2 / kappa);
    pair(other, h.nf * ((cgo + t3) * voltage - t3 * (t2 + 0.5 * kappa * (t4 - 1))),
      h.nf * (cgo + t3 - t3 * (1 - 1 / t4) * (0.5 - 0.5 * t0 / t1)));
  };
  // b4ld.c / b4acld.c: RGATEMOD=3 overlap uses GM bias and GM rows/columns,
  // independently of intrinsic GP charge and physical junction charge.
  const overlapBias = midgate?.bias ?? bias;
  overlap(0, overlapBias.vgs - overlapBias.vds, p.size.cgdo, p.size.cgdl, p.size.ckappad);
  overlap(2, overlapBias.vgs, p.size.cgso, p.size.cgsl, p.size.ckappas);
  pair(3, p.size.cgbo * (overlapBias.vgs - overlapBias.vbs), p.size.cgbo);
  // b4ld.c:3947-4128. Junction identities do not swap in reverse mode.
  const dt = p.temperatureK - p.model.tnom;
  for (const [other, v, area, perimeter, caps, phi, grading] of [
    [2, junction?.vbs ?? bias.vbs, h.Aseff, h.Pseff, [p.model.cjs, p.model.cjsws, p.model.cjswgs],
      [p.model.PhiBS, p.model.PhiBSWS, p.model.PhiBSWGS], [p.model.mjs, p.model.mjsws, p.model.mjswgs]],
    [0, junction?.vbd ?? (bias.vbs - bias.vds), h.Adeff, h.Pdeff, [p.model.cjd, p.model.cjswd, p.model.cjswgd],
      [p.model.PhiBD, p.model.PhiBSWD, p.model.PhiBSWGD], [p.model.mjd, p.model.mjswd, p.model.mjswgd]],
  ] as const) {
    const geometry = [area, perimeter, p.size.weffCJ * h.nf];
    const coeff = [p.model.tcj, p.model.tcjsw, p.model.tcjswg];
    for (let j = 0; j < 3; j++) {
      const c0 = Math.max(0, caps[j]) * Math.max(0, 1 + coeff[j] * dt) * geometry[j];
      const m = grading[j], arg = 1 - v / phi[j];
      const c = v < 0 ? c0 * Math.pow(arg, -m) : c0 * (1 + m * v / phi[j]);
      const charge = v < 0
        ? (m === 1 ? -phi[j] * c0 * Math.log(arg) : phi[j] * c0 * (1 - Math.pow(arg, 1 - m)) / (1 - m))
        : v * c0 * (1 + 0.5 * m * v / phi[j]);
      if (junction) { junction.stamp(other, charge, c); continue; }
      q[3] += charge;
      q[other] -= charge;
      jacobian[15] += c;
      jacobian[12 + other] -= c;
      jacobian[4 * other + 3] -= c;
      jacobian[5 * other] += c;
    }
  }
  return { q, jacobian };
}
