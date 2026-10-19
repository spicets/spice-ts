import type { VBICParams } from './vbic.js';
import type { VBICTemperatureState } from './vbic-temperature.js';

/** Structural subset shared with the retained Dual evaluator's stamp API. */
export interface ScalarQuantity { value: number; derivative: Float64Array }

const FROM = [0, 2, 5, 3, 2, 1, 3, 2, 6, 2, 3, 2, 3, 3, 2, 6];
const TO = [1, 3, 0, 4, 4, 4, 1, 5, 5, 6, 4, 4, 1, 0, 5, 5];

/** One instance per live evaluation lifetime. No buffers escape into another evaluation. */
export class ScalarWorkspace {
  readonly slopes = new Float64Array(20);
  readonly values = new Float64Array(17);
  readonly partials = new Float64Array(17 * 9);
  readonly residual: ScalarQuantity[];
  readonly charge: ScalarQuantity[];
  readonly noise: Record<'irci' | 'irbi' | 'irbp' | 'itzf' | 'ibe' | 'ibep' | 'iccp', ScalarQuantity>;

  constructor() {
    const quantity = (): ScalarQuantity => ({ value: 0, derivative: new Float64Array(9) });
    this.residual = Array.from({ length: 7 }, quantity);
    this.charge = Array.from({ length: 7 }, quantity);
    this.noise = { irci: quantity(), irbi: quantity(), irbp: quantity(), itzf: quantity(), ibe: quantity(), ibep: quantity(), iccp: quantity() };
  }
}

function inverse(value: number): number { return value > 0 ? 1 / value : 0; }

function diode(v: number, current: number, ideality: number, vt: number, slopes: Float64Array, index: number): number {
  const inv = 1 / (ideality * vt);
  const argument = v * inv;
  const limited = Math.min(80, Math.max(-80, argument));
  const exponential = Math.exp(limited);
  slopes[index] = ((inv * (argument === limited ? exponential : 0)) - 0) * current;
  return (exponential - 1) * current;
}

function depletion(v: number, potential: number, grading: number, fc: number, slopes: Float64Array, index: number): number {
  const delta = v - potential * fc;
  if (delta > 0) {
    const pw = Math.pow(1 - fc, -1 - grading);
    const constant = potential * (1 - pw * (1 - fc) * (1 - fc)) / (1 - grading);
    const slope = 0.5 * grading / potential;
    const linear = (1 - fc) + delta * slope;
    slopes[index] = 0 + ((1 - 0) * linear + delta * (0 + (1 - 0) * slope)) * pw;
    return constant + (delta * linear) * pw;
  }
  const inv = 1 / potential;
  const base = Math.max(1 - v * inv, Number.EPSILON);
  const exponent = 1 - grading;
  const slope = exponent * Math.pow(base, exponent - 1);
  const factor = potential / exponent;
  slopes[index] = (0 - ((0 - 1 * inv) * slope)) * factor;
  return (1 - Math.pow(base, exponent)) * factor;
}

function noiseCopy(target: ScalarQuantity, index: number, w: ScalarWorkspace): void {
  target.value = w.values[index];
  for (let col = 0; col < 9; col++) target.derivative[col] = w.partials[index * 9 + col];
}

/**
 * Hand-written isothermal VBIC equations and analytic branch Jacobian. Values
 * are computed once; the column loop below evaluates explicit partials, not a
 * Dual expression tree. All arithmetic staging follows vbic.ts, including the
 * intentionally rounded VTF derivative and the sqrt/log/pow floor conventions.
 * Input voltages are polarity-normalized and temperature mapping is external.
 * TD > 0 and noise analysis stay on Dual at the call site. No circuit switches.
 */
export function evaluateScalar(v: readonly number[], p: VBICParams, t: VBICTemperatureState, instanceScale: number, gmin: number, w: ScalarWorkspace): ScalarWorkspace {
  const a = w.slopes, values = w.values, jac = w.partials;
  const [be, bex, bc, bcx, bep, bcp, rci, rbi, rbp] = v;
  const { vt, PE, PC, PS } = t;
  const ifi = diode(be, t.IS, p.NF, vt, a, 0);
  const iri = diode(bc, t.IS, p.NR, vt, a, 1);
  const bei = diode(be, t.IBEI, p.NEI, vt, a, 2);
  const ben = diode(be, t.IBEN, p.NEN, vt, a, 3);
  const bexi = diode(bex, t.IBEI, p.NEI, vt, a, 4);
  const bexn = diode(bex, t.IBEN, p.NEN, vt, a, 5);
  const bci = diode(bc, t.IBCI, p.NCI, vt, a, 6);
  const bcn = diode(bc, t.IBCN, p.NCN, vt, a, 7);
  const bcpi = diode(bcp, t.IBCIP, p.NCIP, vt, a, 8);
  const bcpn = diode(bcp, t.IBCNP, p.NCNP, vt, a, 9);
  const bepi = diode(bep, t.IBEIP, p.NCI, vt, a, 10);
  const bepn = diode(bep, t.IBENP, p.NCN, vt, a, 11);
  const fp = diode(bep, t.ISP, p.NFP, vt, a, 12);
  const fpc = p.WSP === 1 ? 0 : diode(bc, t.ISP, p.NFP, vt, a, 13);
  const irp = diode(bcp, t.ISP, p.NFP, vt, a, 14);
  const qdbe = depletion(be, PE, p.ME, p.FC, a, 15);
  const qdbc = depletion(bc, PC, p.MC, p.FC, a, 16);
  const qdbex = depletion(bex, PE, p.ME, p.FC, a, 17);
  const qdbep = depletion(bep, PC, p.MC, p.FC, a, 18);
  const qdbcp = t.CJCP > 0 ? depletion(bcp, PS, p.MS, p.FC, a, 19) : 0;
  const ver = inverse(p.VER), vef = inverse(p.VEF), ikf = inverse(p.IKF), ikr = inverse(p.IKR);
  const q1z = (qdbe * ver + qdbc * vef) + 1;
  const q1Offset = q1z - 1e-4;
  const q1Root = Math.sqrt(Math.max(q1Offset * q1Offset + 1e-8, Number.EPSILON));
  const q1 = (q1Root + q1Offset) * 0.5 + 1e-4;
  const q2 = ifi * ikf + iri * ikr;
  const qbRoot = Math.sqrt(Math.max(q1 * q1 + q2 * 4, Number.EPSILON));
  const qb = (q1 + qbRoot) * 0.5;
  const itzf = ifi / qb, itzr = iri / qb;
  const transport = itzf - itzr;
  const ibe = (bei + ben) * p.WBE;
  const ibex = (bexi + bexn) * (1 - p.WBE);
  const ibcj = bci + bcn;
  const ibcp = bcpi + bcpn;
  const ibep = bepi + bepn;
  const avDelta = PC - bc;
  const avRoot = Math.sqrt(Math.max(avDelta * avDelta + 0.01, Number.EPSILON));
  const avVoltage = (avRoot + avDelta) * 0.5;
  const avBase = Math.max(avVoltage, Number.EPSILON);
  const avPower = Math.pow(avBase, p.MC - 1);
  const avPowerSlope = (p.MC - 1) * Math.pow(avBase, (p.MC - 1) - 1);
  const avArgument = avPower * -p.AVC2;
  const avLimited = Math.min(80, Math.max(-80, avArgument));
  const avExp = Math.exp(avLimited);
  const avalanche = (avVoltage * avExp) * p.AVC1;
  const ibc = ibcj - (transport - ibcj) * avalanche;
  const ifp = p.WSP === 1 ? fp : fp * p.WSP + fpc * (1 - p.WSP);
  const ikp4 = 4 * inverse(p.IKP);
  const qbpRoot = Math.sqrt(Math.max(ifp * ikp4 + 1, Number.EPSILON));
  const qbpValue = (qbpRoot + 1) * 0.5;
  const iccp = (ifp - irp) / qbpValue;
  const bcArg = bc * (1 / vt), bcxArg = bcx * (1 / vt);
  const bcLim = Math.min(80, Math.max(-80, bcArg)), bcxLim = Math.min(80, Math.max(-80, bcxArg));
  const bcExp = Math.exp(bcLim), bcxExp = Math.exp(bcxLim);
  const kbci = Math.sqrt(Math.max(bcExp * t.GAMM + 1, Number.EPSILON));
  const kbcx = Math.sqrt(Math.max(bcxExp * t.GAMM + 1, Number.EPSILON));
  const ratio = (kbci + 1) / (kbcx + 1);
  const logBase = Math.max(ratio, Number.EPSILON);
  const iohm = (rci + ((kbci - kbcx) - Math.log(logBase)) * vt) * (1 / t.RCI);
  const voFactor = t.RCI * inverse(p.VO);
  const rciRoot = Math.sqrt(Math.max(rci * rci + 0.01, Number.EPSILON));
  const limitFactor = 0.5 * inverse(p.VO) / p.HRCF;
  const limitDen = rciRoot * limitFactor + 1;
  const derf = (iohm * voFactor) / limitDen;
  const derfRoot = Math.sqrt(Math.max(derf * derf + 1, Number.EPSILON));
  const irci = iohm / derfRoot;
  const irbi = (rbi * qb) * (1 / t.RBI);
  const irbp = (rbp * qbpValue) * (1 / t.RBP);
  const forward = ifi > 0 ? 1 : 0;
  const itfFactor = forward * inverse(p.ITF);
  const relative = ifi * itfFactor;
  const high = relative / (relative + 1);
  const enhancement = (high * high + (p.ITF > 0 ? 0 : 1)) * (p.XTF * forward);
  const vtfExp = p.VTF > 0 ? Math.exp(bc * (1 / p.VTF) / 1.44) : 1;
  const biased = p.VTF > 0 ? vtfExp * enhancement : enhancement;
  const tff = (biased + 1) * p.TF;
  values[0] = irci; values[1] = irbi; values[2] = irbp;
  values[3] = ibe; values[4] = ibex; values[5] = transport;
  values[6] = ibc; values[7] = ibep; values[8] = ibcp; values[9] = iccp;
  values[10] = qdbe * (t.CJE * p.WBE) + (tff * ifi) / qb;
  values[11] = qdbex * (t.CJE * (1 - p.WBE));
  values[12] = (qdbc * t.CJC + iri * p.TR) + kbci * p.QCO;
  values[13] = kbcx * p.QCO;
  values[14] = qdbep * t.CJEP + ifp * p.TR;
  values[15] = t.CJCP > 0 ? qdbcp * t.CJCP : 0;
  values[16] = itzf;

  for (let col = 0; col < 9; col++) {
    const dbe = col === 0 ? 1 : 0, dbex = col === 1 ? 1 : 0;
    const dbc = col === 2 ? 1 : 0, dbcx = col === 3 ? 1 : 0;
    const dbep = col === 4 ? 1 : 0, dbcp = col === 5 ? 1 : 0;
    const drci = col === 6 ? 1 : 0, drbi = col === 7 ? 1 : 0, drbp = col === 8 ? 1 : 0;
    const difi = dbe * a[0], diri = dbc * a[1];
    const dqdbe = col === 0 ? a[15] : 0, dqdbc = col === 2 ? a[16] : 0;
    const dq1z = (dqdbe * ver + dqdbc * vef) + 0;
    const dq1Offset = dq1z - 0;
    const dq1Root = ((dq1Offset * q1Offset + q1Offset * dq1Offset) + 0) * (0.5 / q1Root);
    const dq1 = (dq1Root + dq1Offset) * 0.5 + 0;
    const dq2 = difi * ikf + diri * ikr;
    const dqbRoot = ((dq1 * q1 + q1 * dq1) + dq2 * 4) * (0.5 / qbRoot);
    const dqb = (dq1 + dqbRoot) * 0.5;
    const ditzf = (difi * qb - ifi * dqb) / (qb * qb);
    const ditzr = (diri * qb - iri * dqb) / (qb * qb);
    const dtransport = ditzf - ditzr;
    const dibe = (dbe * a[2] + dbe * a[3]) * p.WBE;
    const dibex = (dbex * a[4] + dbex * a[5]) * (1 - p.WBE);
    const dibcj = dbc * a[6] + dbc * a[7];
    const dibcp = dbcp * a[8] + dbcp * a[9];
    const dibep = dbep * a[10] + dbep * a[11];
    const davDelta = 0 - dbc;
    const davRoot = ((davDelta * avDelta + avDelta * davDelta) + 0) * (0.5 / avRoot);
    const davVoltage = (davRoot + davDelta) * 0.5;
    const davPower = davVoltage * avPowerSlope;
    const davExp = (davPower * -p.AVC2) * (avArgument === avLimited ? avExp : 0);
    const davalanche = (davVoltage * avExp + avVoltage * davExp) * p.AVC1;
    const dibc = dibcj - ((dtransport - dibcj) * avalanche + (transport - ibcj) * davalanche);
    const difp = p.WSP === 1 ? dbep * a[12] : (dbep * a[12]) * p.WSP + (dbc * a[13]) * (1 - p.WSP);
    const dirp = dbcp * a[14];
    const dqbp = (((difp * ikp4) + 0) * (0.5 / qbpRoot) + 0) * 0.5;
    const diccp = ((difp - dirp) * qbpValue - (ifp - irp) * dqbp) / (qbpValue * qbpValue);
    const dkbci = (((dbc * (1 / vt)) * (bcArg === bcLim ? bcExp : 0)) * t.GAMM + 0) * (0.5 / kbci);
    const dkbcx = (((dbcx * (1 / vt)) * (bcxArg === bcxLim ? bcxExp : 0)) * t.GAMM + 0) * (0.5 / kbcx);
    const dratio = ((dkbci + 0) * (kbcx + 1) - (kbci + 1) * (dkbcx + 0)) / ((kbcx + 1) * (kbcx + 1));
    const diohm = (drci + ((dkbci - dkbcx) - dratio * (1 / logBase)) * vt) * (1 / t.RCI);
    const dlimitDen = (((drci * rci + rci * drci) + 0) * (0.5 / rciRoot)) * limitFactor + 0;
    const dderf = ((diohm * voFactor) * limitDen - (iohm * voFactor) * dlimitDen) / (limitDen * limitDen);
    const dderfRoot = ((dderf * derf + derf * dderf) + 0) * (0.5 / derfRoot);
    const dirci = (diohm * derfRoot - iohm * dderfRoot) / (derfRoot * derfRoot);
    const dirbi = (drbi * qb + rbi * dqb) * (1 / t.RBI);
    const dirbp = (drbp * qbpValue + rbp * dqbp) * (1 / t.RBP);
    const drelative = difi * itfFactor;
    const dhigh = (drelative * (relative + 1) - relative * (drelative + 0)) / ((relative + 1) * (relative + 1));
    const denhancement = ((dhigh * high + high * dhigh) + 0) * (p.XTF * forward);
    const dbiased = p.VTF > 0 ? (dbc * (vtfExp * 0.6944444 / p.VTF)) * enhancement + vtfExp * denhancement : denhancement;
    const dtff = (dbiased + 0) * p.TF;
    jac[col] = dirci; jac[9 + col] = dirbi; jac[18 + col] = dirbp;
    jac[27 + col] = dibe; jac[36 + col] = dibex; jac[45 + col] = dtransport;
    jac[54 + col] = dibc; jac[63 + col] = dibep; jac[72 + col] = dibcp; jac[81 + col] = diccp;
    jac[90 + col] = dqdbe * (t.CJE * p.WBE) + ((dtff * ifi + tff * difi) * qb - (tff * ifi) * dqb) / (qb * qb);
    jac[99 + col] = (col === 1 ? a[17] : 0) * (t.CJE * (1 - p.WBE));
    jac[108 + col] = (dqdbc * t.CJC + diri * p.TR) + dkbci * p.QCO;
    jac[117 + col] = dkbcx * p.QCO;
    jac[126 + col] = (col === 4 ? a[18] : 0) * t.CJEP + difp * p.TR;
    jac[135 + col] = t.CJCP > 0 ? (col === 5 ? a[19] : 0) * t.CJCP : 0;
    jac[144 + col] = ditzf;
  }
  // Noise quantities precede scale/gmin, just as in the Dual evaluator.
  noiseCopy(w.noise.irci, 0, w); noiseCopy(w.noise.irbi, 1, w); noiseCopy(w.noise.irbp, 2, w);
  noiseCopy(w.noise.itzf, 16, w); noiseCopy(w.noise.ibe, 3, w); noiseCopy(w.noise.ibep, 7, w); noiseCopy(w.noise.iccp, 9, w);
  for (let row = 0; row < 7; row++) {
    w.residual[row].value = 0; w.charge[row].value = 0;
    w.residual[row].derivative.fill(0); w.charge[row].derivative.fill(0);
  }
  for (let index = 0; index < 16; index++) {
    if (index === 11 && p.WBE === 1) continue;
    const rows = index < 10 ? w.residual : w.charge;
    const from = rows[FROM[index]], to = rows[TO[index]];
    const peripheralZero = index === 7 && p.IBEIP === 0 && p.IBENP === 0;
    let value = peripheralZero ? 0 : instanceScale === 1 ? values[index] : values[index] * instanceScale;
    if (index === 0) value += ((rci + bc) + bcx) * gmin;
    if (index === 3) value += be * gmin;
    if (index === 4) value += bex * gmin;
    if (index === 6) value += bc * gmin;
    if (index === 7) value = peripheralZero ? bep * gmin : value + bep * gmin;
    if (index === 8) value += bcp * gmin;
    from.value += value; to.value -= value;
    for (let col = 0; col < 9; col++) {
      let partial = peripheralZero ? 0 : instanceScale === 1 ? jac[index * 9 + col] : jac[index * 9 + col] * instanceScale;
      if (index === 0) partial += (((col === 6 ? 1 : 0) + (col === 2 ? 1 : 0)) + (col === 3 ? 1 : 0)) * gmin;
      if (index === 3) partial += (col === 0 ? 1 : 0) * gmin;
      if (index === 4) partial += (col === 1 ? 1 : 0) * gmin;
      if (index === 6) partial += (col === 2 ? 1 : 0) * gmin;
      if (index === 7) partial = peripheralZero ? (col === 4 ? 1 : 0) * gmin : partial + (col === 4 ? 1 : 0) * gmin;
      if (index === 8) partial += (col === 5 ? 1 : 0) * gmin;
      from.derivative[col] += partial; to.derivative[col] -= partial;
    }
  }
  return w;
}
