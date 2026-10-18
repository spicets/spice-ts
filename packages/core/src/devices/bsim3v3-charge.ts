import type { BSIM3Model, BSIM3Size } from './bsim3v3-params.js';
import { BSIM3_REVISION, EPSSI, EXP_THRESHOLD, MAX_EXP, MIN_EXP } from './bsim3v3-params.js';
import type { BSIM3v3ChargeInputs, BSIM3v3DCResult } from './bsim3v3-dc.js';
import { createChargeInputs, createDCResult, evaluateDC } from './bsim3v3-dc.js';

/** b3ld.c smoothing constants. */
const DELTA_1 = 0.02;
const DELTA_3 = 0.02;
const DELTA_4 = 0.02;

/**
 * Instance constants of the ngspice-47 b3ld.c charge model: the capMod and
 * XPART selectors, Cox * WeffCV * LeffCV, the overlap and the acmMod = 0
 * zero-bias junction capacitances with their b3temp.c temperature laws.
 */
export interface BSIM3ChargeParams {
  /** BSIM3_REVISION of the model card (3.2.x follow bsim3v32/b3v32ld.c). */
  readonly revision: number;
  readonly capMod: number;
  readonly xpart: number;
  readonly cox: number;
  readonly tox: number;
  readonly coxWL: number;
  /** here->BSIM3vfbzb (DELVTO applied). */
  readonly vfbzb: number;
  readonly cgdo: number; readonly cgso: number; readonly cgbo: number;
  /** WeffCV * CGDL and WeffCV * CGSL (bias-dependent overlap, capMod >= 1). */
  readonly cgdl: number; readonly cgsl: number; readonly ckappa: number;
  readonly czbd: number; readonly czbdsw: number; readonly czbdswg: number;
  readonly czbs: number; readonly czbssw: number; readonly czbsswg: number;
  readonly mj: number; readonly mjsw: number; readonly mjswg: number;
  readonly phiB: number; readonly phiBSW: number; readonly phiBSWG: number;
}

export function chargeParams(model: BSIM3Model, size: BSIM3Size): BSIM3ChargeParams {
  const m = model.values;
  // b3temp.c junction capacitance temperature dependence. b3v32temp.c (3.2,
  // 3.2.2) scales the card values in place instead of into the *TempJctCap
  // fields; for the one temperature update of a run the values are the same.
  const delTemp = model.temp - model.tnom;
  const tempCap = (unit: number, tc: number): number => {
    const t0 = tc * delTemp;
    return t0 >= -1.0 ? unit * (1.0 + t0) : 0.0;
  };
  const unitArea = tempCap(m.cj, m.tcj);
  const unitSidewall = tempCap(m.cjsw, m.tcjsw);
  const unitGateSidewall = tempCap(m.cjswg, m.tcjswg);
  const potential = (pb: number, tpb: number): number => Math.max(pb - tpb * delTemp, 0.01);

  // b3ld.c acmMod = 0 zero-bias junction capacitances.
  const weff = size.weff;
  const sidewall = (perimeter: number): [number, number] => (perimeter < weff
    ? [0.0, unitGateSidewall * perimeter]
    : [unitSidewall * (perimeter - weff), unitGateSidewall * weff]);
  const [czbdsw, czbdswg] = sidewall(size.drainPerimeter);
  const [czbssw, czbsswg] = sidewall(size.sourcePerimeter);
  return {
    revision: model.revision,
    capMod: m.capmod,
    xpart: m.xpart,
    cox: model.cox,
    tox: model.tox,
    coxWL: model.cox * size.weffCV * size.leffCV,
    vfbzb: size.instVfbzb,
    cgdo: size.cgdo, cgso: size.cgso, cgbo: size.cgbo,
    cgdl: size.weffCV * size.cgdl, cgsl: size.weffCV * size.cgsl, ckappa: size.ckappa,
    czbd: unitArea * size.drainArea, czbdsw, czbdswg,
    czbs: unitArea * size.sourceArea, czbssw, czbsswg,
    mj: m.mj, mjsw: m.mjsw, mjswg: m.mjswg,
    phiB: potential(m.pb, m.tpb), phiBSW: potential(m.pbsw, m.tpbsw), phiBSWG: potential(m.pbswg, m.tpbswg),
  };
}

/**
 * b3ld.c intrinsic charges (NMOS convention, effective orientation) and the
 * capacitances ngspice stores as here->BSIM3c**b: d(charge)/d(terminal) with
 * the bulk as reference.
 */
export interface BSIM3IntrinsicCharge {
  qgate: number; qbulk: number; qdrn: number;
  cggb: number; cgdb: number; cgsb: number;
  cdgb: number; cddb: number; cdsb: number;
  cbgb: number; cbdb: number; cbsb: number;
}

export function createIntrinsicCharge(): BSIM3IntrinsicCharge {
  return { qgate: 0, qbulk: 0, qdrn: 0, cggb: 0, cgdb: 0, cgsb: 0, cdgb: 0, cddb: 0, cdsb: 0, cbgb: 0, cbdb: 0, cbsb: 0 };
}

/**
 * Port of the ngspice-47 b3ld.c charge section ("if ((model->BSIM3xpart < 0)
 * || ..." through the end of the CTM), for one normal-mode evaluation: `cv`
 * holds the DC-section quantities of the same bias and Vds/Vbs are the
 * effective-orientation voltages evaluateDC was called with.
 */
export function evaluateIntrinsicCharge(
  cp: BSIM3ChargeParams,
  p: BSIM3Size,
  vtm: number,
  cv: BSIM3v3ChargeInputs,
  Vds: number,
  Vbs: number,
  out: BSIM3IntrinsicCharge,
): BSIM3IntrinsicCharge {
  let T0: number, T1: number, T2: number, T3: number, T4: number, T5: number, T6: number;
  let T7: number, T8: number, T9: number, T10: number, T11: number, T12: number;
  let tmp: number, tmp1: number;
  let qgate: number, qbulk: number, qdrn: number, qsrc: number;
  const { Phis, dPhis_dVb, sqrtPhis, dsqrtPhis_dVb, Vgs_eff, dVgs_eff_dVg, Abulk0, dAbulk0_dVb, dVth_dVd } = cv;
  let { Vbseff, dVbseff_dVb } = cv;
  const CoxWL = cp.coxWL;
  const xpart = cp.xpart;

  if (xpart < 0) {
    out.qgate = out.qdrn = out.qbulk = 0.0;
    out.cggb = out.cgsb = out.cgdb = 0.0;
    out.cdgb = out.cdsb = out.cddb = 0.0;
    out.cbgb = out.cbsb = out.cbdb = 0.0;
    return out;
  }

  if (cp.capMod === 0) {
    if (Vbseff < 0.0) {
      Vbseff = Vbs;
      dVbseff_dVb = 1.0;
    } else {
      Vbseff = p.phi - Phis;
      dVbseff_dVb = -dPhis_dVb;
    }

    const Vfb = p.vfbcv;
    const Vth = Vfb + p.phi + p.k1ox * sqrtPhis;
    const Vgst = Vgs_eff - Vth;
    const dVth_dVb = p.k1ox * dsqrtPhis_dVb;

    const Arg1 = Vgs_eff - Vbseff - Vfb;

    if (Arg1 <= 0.0) {
      qgate = CoxWL * Arg1;
      qbulk = -qgate;
      qdrn = 0.0;

      out.cggb = CoxWL * dVgs_eff_dVg;
      out.cgdb = 0.0;
      out.cgsb = CoxWL * (dVbseff_dVb - dVgs_eff_dVg);

      out.cdgb = 0.0;
      out.cddb = 0.0;
      out.cdsb = 0.0;

      out.cbgb = -CoxWL * dVgs_eff_dVg;
      out.cbdb = 0.0;
      out.cbsb = -out.cgsb;
    } else if (Vgst <= 0.0) {
      T1 = 0.5 * p.k1ox;
      T2 = Math.sqrt(T1 * T1 + Arg1);
      qgate = CoxWL * p.k1ox * (T2 - T1);
      qbulk = -qgate;
      qdrn = 0.0;

      T0 = CoxWL * T1 / T2;
      out.cggb = T0 * dVgs_eff_dVg;
      out.cgdb = 0.0;
      out.cgsb = T0 * (dVbseff_dVb - dVgs_eff_dVg);

      out.cdgb = 0.0;
      out.cddb = 0.0;
      out.cdsb = 0.0;

      out.cbgb = -out.cggb;
      out.cbdb = 0.0;
      out.cbsb = -out.cgsb;
    } else {
      const One_Third_CoxWL = CoxWL / 3.0;
      const Two_Third_CoxWL = 2.0 * One_Third_CoxWL;

      const AbulkCV = Abulk0 * p.abulkCVfactor;
      const dAbulkCV_dVb = p.abulkCVfactor * dAbulk0_dVb;
      const Vdsat = Vgst / AbulkCV;
      const dVdsat_dVg = dVgs_eff_dVg / AbulkCV;
      const dVdsat_dVb = -(Vdsat * dAbulkCV_dVb + dVth_dVb) / AbulkCV;

      if (xpart > 0.5) {
        // 0/100 charge partition model
        if (Vdsat <= Vds) {
          // saturation region
          T1 = Vdsat / 3.0;
          qgate = CoxWL * (Vgs_eff - Vfb - p.phi - T1);
          T2 = -Two_Third_CoxWL * Vgst;
          qbulk = -(qgate + T2);
          qdrn = 0.0;

          out.cggb = One_Third_CoxWL * (3.0 - dVdsat_dVg) * dVgs_eff_dVg;
          T2 = -One_Third_CoxWL * dVdsat_dVb;
          out.cgsb = -(out.cggb + T2);
          out.cgdb = 0.0;

          out.cdgb = 0.0;
          out.cddb = 0.0;
          out.cdsb = 0.0;

          out.cbgb = -(out.cggb - Two_Third_CoxWL * dVgs_eff_dVg);
          T3 = -(T2 + Two_Third_CoxWL * dVth_dVb);
          out.cbsb = -(out.cbgb + T3);
          out.cbdb = 0.0;
        } else {
          // linear region
          const Alphaz = Vgst / Vdsat;
          T1 = 2.0 * Vdsat - Vds;
          T2 = Vds / (3.0 * T1);
          T3 = T2 * Vds;
          T9 = 0.25 * CoxWL;
          T4 = T9 * Alphaz;
          T7 = 2.0 * Vds - T1 - 3.0 * T3;
          T8 = T3 - T1 - 2.0 * Vds;
          qgate = CoxWL * (Vgs_eff - Vfb - p.phi - 0.5 * (Vds - T3));
          T10 = T4 * T8;
          qdrn = T4 * T7;
          qbulk = -(qgate + qdrn + T10);

          T5 = T3 / T1;
          out.cggb = CoxWL * (1.0 - T5 * dVdsat_dVg) * dVgs_eff_dVg;
          T11 = -CoxWL * T5 * dVdsat_dVb;
          out.cgdb = CoxWL * (T2 - 0.5 + 0.5 * T5);
          out.cgsb = -(out.cggb + T11 + out.cgdb);
          T6 = 1.0 / Vdsat;
          const dAlphaz_dVg = T6 * (1.0 - Alphaz * dVdsat_dVg);
          const dAlphaz_dVb = -T6 * (dVth_dVb + Alphaz * dVdsat_dVb);
          T7 = T9 * T7;
          T8 = T9 * T8;
          T9 = 2.0 * T4 * (1.0 - 3.0 * T5);
          out.cdgb = (T7 * dAlphaz_dVg - T9 * dVdsat_dVg) * dVgs_eff_dVg;
          T12 = T7 * dAlphaz_dVb - T9 * dVdsat_dVb;
          out.cddb = T4 * (3.0 - 6.0 * T2 - 3.0 * T5);
          out.cdsb = -(out.cdgb + T12 + out.cddb);

          T9 = 2.0 * T4 * (1.0 + T5);
          T10 = (T8 * dAlphaz_dVg - T9 * dVdsat_dVg) * dVgs_eff_dVg;
          T11 = T8 * dAlphaz_dVb - T9 * dVdsat_dVb;
          T12 = T4 * (2.0 * T2 + T5 - 1.0);
          T0 = -(T10 + T11 + T12);

          out.cbgb = -(out.cggb + out.cdgb + T10);
          out.cbdb = -(out.cgdb + out.cddb + T12);
          out.cbsb = -(out.cgsb + out.cdsb + T0);
        }
      } else if (xpart < 0.5) {
        // 40/60 charge partition model
        if (Vds >= Vdsat) {
          // saturation region
          T1 = Vdsat / 3.0;
          qgate = CoxWL * (Vgs_eff - Vfb - p.phi - T1);
          T2 = -Two_Third_CoxWL * Vgst;
          qbulk = -(qgate + T2);
          qdrn = 0.4 * T2;

          out.cggb = One_Third_CoxWL * (3.0 - dVdsat_dVg) * dVgs_eff_dVg;
          T2 = -One_Third_CoxWL * dVdsat_dVb;
          out.cgsb = -(out.cggb + T2);
          out.cgdb = 0.0;

          T3 = 0.4 * Two_Third_CoxWL;
          out.cdgb = -T3 * dVgs_eff_dVg;
          out.cddb = 0.0;
          T4 = T3 * dVth_dVb;
          out.cdsb = -(T4 + out.cdgb);

          out.cbgb = -(out.cggb - Two_Third_CoxWL * dVgs_eff_dVg);
          T3 = -(T2 + Two_Third_CoxWL * dVth_dVb);
          out.cbsb = -(out.cbgb + T3);
          out.cbdb = 0.0;
        } else {
          // linear region
          const Alphaz = Vgst / Vdsat;
          T1 = 2.0 * Vdsat - Vds;
          T2 = Vds / (3.0 * T1);
          T3 = T2 * Vds;
          T9 = 0.25 * CoxWL;
          T4 = T9 * Alphaz;
          qgate = CoxWL * (Vgs_eff - Vfb - p.phi - 0.5 * (Vds - T3));

          T5 = T3 / T1;
          out.cggb = CoxWL * (1.0 - T5 * dVdsat_dVg) * dVgs_eff_dVg;
          tmp = -CoxWL * T5 * dVdsat_dVb;
          out.cgdb = CoxWL * (T2 - 0.5 + 0.5 * T5);
          out.cgsb = -(out.cggb + out.cgdb + tmp);

          T6 = 1.0 / Vdsat;
          const dAlphaz_dVg = T6 * (1.0 - Alphaz * dVdsat_dVg);
          const dAlphaz_dVb = -T6 * (dVth_dVb + Alphaz * dVdsat_dVb);

          T6 = 8.0 * Vdsat * Vdsat - 6.0 * Vdsat * Vds + 1.2 * Vds * Vds;
          T8 = T2 / T1;
          T7 = Vds - T1 - T8 * T6;
          qdrn = T4 * T7;
          T7 *= T9;
          tmp = T8 / T1;
          tmp1 = T4 * (2.0 - 4.0 * tmp * T6 + T8 * (16.0 * Vdsat - 6.0 * Vds));

          out.cdgb = (T7 * dAlphaz_dVg - tmp1 * dVdsat_dVg) * dVgs_eff_dVg;
          T10 = T7 * dAlphaz_dVb - tmp1 * dVdsat_dVb;
          out.cddb = T4 * (2.0 - (1.0 / (3.0 * T1 * T1) + 2.0 * tmp) * T6 + T8 * (6.0 * Vdsat - 2.4 * Vds));
          out.cdsb = -(out.cdgb + T10 + out.cddb);

          T7 = 2.0 * (T1 + T3);
          qbulk = -(qgate - T4 * T7);
          T7 *= T9;
          T0 = 4.0 * T4 * (1.0 - T5);
          T12 = (-T7 * dAlphaz_dVg - out.cdgb - T0 * dVdsat_dVg) * dVgs_eff_dVg;
          T11 = -T7 * dAlphaz_dVb - T10 - T0 * dVdsat_dVb;
          T10 = -4.0 * T4 * (T2 - 0.5 + 0.5 * T5) - out.cddb;
          tmp = -(T10 + T11 + T12);

          out.cbgb = -(out.cggb + out.cdgb + T12);
          out.cbdb = -(out.cgdb + out.cddb + T10);
          out.cbsb = -(out.cgsb + out.cdsb + tmp);
        }
      } else {
        // 50/50 partitioning
        if (Vds >= Vdsat) {
          // saturation region
          T1 = Vdsat / 3.0;
          qgate = CoxWL * (Vgs_eff - Vfb - p.phi - T1);
          T2 = -Two_Third_CoxWL * Vgst;
          qbulk = -(qgate + T2);
          qdrn = 0.5 * T2;

          out.cggb = One_Third_CoxWL * (3.0 - dVdsat_dVg) * dVgs_eff_dVg;
          T2 = -One_Third_CoxWL * dVdsat_dVb;
          out.cgsb = -(out.cggb + T2);
          out.cgdb = 0.0;

          out.cdgb = -One_Third_CoxWL * dVgs_eff_dVg;
          out.cddb = 0.0;
          T4 = One_Third_CoxWL * dVth_dVb;
          out.cdsb = -(T4 + out.cdgb);

          out.cbgb = -(out.cggb - Two_Third_CoxWL * dVgs_eff_dVg);
          T3 = -(T2 + Two_Third_CoxWL * dVth_dVb);
          out.cbsb = -(out.cbgb + T3);
          out.cbdb = 0.0;
        } else {
          // linear region
          const Alphaz = Vgst / Vdsat;
          T1 = 2.0 * Vdsat - Vds;
          T2 = Vds / (3.0 * T1);
          T3 = T2 * Vds;
          T9 = 0.25 * CoxWL;
          T4 = T9 * Alphaz;
          qgate = CoxWL * (Vgs_eff - Vfb - p.phi - 0.5 * (Vds - T3));

          T5 = T3 / T1;
          out.cggb = CoxWL * (1.0 - T5 * dVdsat_dVg) * dVgs_eff_dVg;
          tmp = -CoxWL * T5 * dVdsat_dVb;
          out.cgdb = CoxWL * (T2 - 0.5 + 0.5 * T5);
          out.cgsb = -(out.cggb + out.cgdb + tmp);

          T6 = 1.0 / Vdsat;
          const dAlphaz_dVg = T6 * (1.0 - Alphaz * dVdsat_dVg);
          const dAlphaz_dVb = -T6 * (dVth_dVb + Alphaz * dVdsat_dVb);

          T7 = T1 + T3;
          qdrn = -T4 * T7;
          qbulk = -(qgate + qdrn + qdrn);
          T7 *= T9;
          T0 = T4 * (2.0 * T5 - 2.0);

          out.cdgb = (T0 * dVdsat_dVg - T7 * dAlphaz_dVg) * dVgs_eff_dVg;
          T12 = T0 * dVdsat_dVb - T7 * dAlphaz_dVb;
          out.cddb = T4 * (1.0 - 2.0 * T2 - T5);
          out.cdsb = -(out.cdgb + T12 + out.cddb);

          out.cbgb = -(out.cggb + 2.0 * out.cdgb);
          out.cbdb = -(out.cgdb + 2.0 * out.cddb);
          out.cbsb = -(out.cgsb + 2.0 * out.cdsb);
        }
      }
    }
    out.qgate = qgate;
    out.qbulk = qbulk;
    out.qdrn = qdrn;
    return out;
  }

  // capMod 1, 2 and 3.
  let VbseffCV: number, dVbseffCV_dVb: number;
  if (Vbseff < 0.0) {
    VbseffCV = Vbseff;
    dVbseffCV_dVb = 1.0;
  } else {
    VbseffCV = p.phi - Phis;
    dVbseffCV_dVb = -dPhis_dVb;
  }

  // Separate VgsteffCV with noff and voffcv
  const noff = cv.n * p.noff;
  const dnoff_dVd = p.noff * cv.dn_dVd;
  const dnoff_dVb = p.noff * cv.dn_dVb;
  T0 = vtm * noff;
  const voffcv = p.voffcv;
  const VgstNVt = (cv.Vgst - voffcv) / T0;

  let Vgsteff: number, dVgsteff_dVg: number, dVgsteff_dVd: number, dVgsteff_dVb: number;
  if (VgstNVt > EXP_THRESHOLD) {
    Vgsteff = cv.Vgst - voffcv;
    dVgsteff_dVg = dVgs_eff_dVg;
    dVgsteff_dVd = -dVth_dVd;
    dVgsteff_dVb = -cv.dVth_dVb;
  } else if (VgstNVt < -EXP_THRESHOLD) {
    Vgsteff = T0 * Math.log(1.0 + MIN_EXP);
    dVgsteff_dVg = 0.0;
    dVgsteff_dVd = Vgsteff / noff;
    dVgsteff_dVb = dVgsteff_dVd * dnoff_dVb;
    dVgsteff_dVd *= dnoff_dVd;
  } else {
    const ExpVgst = Math.exp(VgstNVt);
    Vgsteff = T0 * Math.log(1.0 + ExpVgst);
    dVgsteff_dVg = ExpVgst / (1.0 + ExpVgst);
    dVgsteff_dVd = -dVgsteff_dVg * (dVth_dVd + (cv.Vgst - voffcv) / noff * dnoff_dVd) + Vgsteff / noff * dnoff_dVd;
    dVgsteff_dVb = -dVgsteff_dVg * (cv.dVth_dVb + (cv.Vgst - voffcv) / noff * dnoff_dVb) + Vgsteff / noff * dnoff_dVb;
    dVgsteff_dVg *= dVgs_eff_dVg;
  }

  let Cgg: number, Cgd: number, Cgb: number, Cbg: number, Cbd: number, Cbb: number;
  let Csg: number, Csd: number, Csb: number;
  let Cgg1: number, Cgd1: number, Cgb1: number, Cbg1: number, Cbd1: number, Cbb1: number;
  const dAbulkCV_dVb = p.abulkCVfactor * dAbulk0_dVb;
  const AbulkCV = Abulk0 * p.abulkCVfactor;

  if (cp.capMod === 1) {
    const Vfb = cp.vfbzb;
    const Arg1 = Vgs_eff - VbseffCV - Vfb - Vgsteff;

    if (Arg1 <= 0.0) {
      qgate = CoxWL * Arg1;
      Cgg = CoxWL * (dVgs_eff_dVg - dVgsteff_dVg);
      Cgd = -CoxWL * dVgsteff_dVd;
      Cgb = -CoxWL * (dVbseffCV_dVb + dVgsteff_dVb);
    } else {
      T0 = 0.5 * p.k1ox;
      T1 = Math.sqrt(T0 * T0 + Arg1);
      T2 = CoxWL * T0 / T1;

      qgate = CoxWL * p.k1ox * (T1 - T0);

      Cgg = T2 * (dVgs_eff_dVg - dVgsteff_dVg);
      Cgd = -T2 * dVgsteff_dVd;
      Cgb = -T2 * (dVbseffCV_dVb + dVgsteff_dVb);
    }
    qbulk = -qgate;
    Cbg = -Cgg;
    Cbd = -Cgd;
    Cbb = -Cgb;

    const One_Third_CoxWL = CoxWL / 3.0;
    const Two_Third_CoxWL = 2.0 * One_Third_CoxWL;
    const VdsatCV = Vgsteff / AbulkCV;
    if (VdsatCV < Vds) {
      const dVdsatCV_dVg = 1.0 / AbulkCV;
      const dVdsatCV_dVb = -VdsatCV * dAbulkCV_dVb / AbulkCV;
      T0 = Vgsteff - VdsatCV / 3.0;
      let dT0_dVg = 1.0 - dVdsatCV_dVg / 3.0;
      let dT0_dVb = -dVdsatCV_dVb / 3.0;
      qgate += CoxWL * T0;
      Cgg1 = CoxWL * dT0_dVg;
      Cgb1 = CoxWL * dT0_dVb + Cgg1 * dVgsteff_dVb;
      Cgd1 = Cgg1 * dVgsteff_dVd;
      Cgg1 *= dVgsteff_dVg;
      Cgg += Cgg1;
      Cgb += Cgb1;
      Cgd += Cgd1;

      T0 = VdsatCV - Vgsteff;
      dT0_dVg = dVdsatCV_dVg - 1.0;
      dT0_dVb = dVdsatCV_dVb;
      qbulk += One_Third_CoxWL * T0;
      Cbg1 = One_Third_CoxWL * dT0_dVg;
      Cbb1 = One_Third_CoxWL * dT0_dVb + Cbg1 * dVgsteff_dVb;
      Cbd1 = Cbg1 * dVgsteff_dVd;
      Cbg1 *= dVgsteff_dVg;
      Cbg += Cbg1;
      Cbb += Cbb1;
      Cbd += Cbd1;

      if (xpart > 0.5) T0 = -Two_Third_CoxWL;
      else if (xpart < 0.5) T0 = -0.4 * CoxWL;
      else T0 = -One_Third_CoxWL;

      qsrc = T0 * Vgsteff;
      Csg = T0 * dVgsteff_dVg;
      Csb = T0 * dVgsteff_dVb;
      Csd = T0 * dVgsteff_dVd;
      Cgb *= dVbseff_dVb;
      Cbb *= dVbseff_dVb;
      Csb *= dVbseff_dVb;
    } else {
      T0 = AbulkCV * Vds;
      T1 = 12.0 * (Vgsteff - 0.5 * T0 + 1.e-20);
      T2 = Vds / T1;
      T3 = T0 * T2;
      const dT3_dVg = -12.0 * T2 * T2 * AbulkCV;
      const dT3_dVd = 6.0 * T0 * (4.0 * Vgsteff - T0) / T1 / T1 - 0.5;
      const dT3_dVb = 12.0 * T2 * T2 * dAbulkCV_dVb * Vgsteff;

      qgate += CoxWL * (Vgsteff - 0.5 * Vds + T3);
      Cgg1 = CoxWL * (1.0 + dT3_dVg);
      Cgb1 = CoxWL * dT3_dVb + Cgg1 * dVgsteff_dVb;
      Cgd1 = CoxWL * dT3_dVd + Cgg1 * dVgsteff_dVd;
      Cgg1 *= dVgsteff_dVg;
      Cgg += Cgg1;
      Cgb += Cgb1;
      Cgd += Cgd1;

      qbulk += CoxWL * (1.0 - AbulkCV) * (0.5 * Vds - T3);
      Cbg1 = -CoxWL * ((1.0 - AbulkCV) * dT3_dVg);
      Cbb1 = -CoxWL * ((1.0 - AbulkCV) * dT3_dVb + (0.5 * Vds - T3) * dAbulkCV_dVb) + Cbg1 * dVgsteff_dVb;
      Cbd1 = -CoxWL * (1.0 - AbulkCV) * dT3_dVd + Cbg1 * dVgsteff_dVd;
      Cbg1 *= dVgsteff_dVg;
      Cbg += Cbg1;
      Cbb += Cbb1;
      Cbd += Cbd1;

      if (xpart > 0.5) {
        // 0/100 charge partition model
        T1 = T1 + T1;
        qsrc = -CoxWL * (0.5 * Vgsteff + 0.25 * T0 - T0 * T0 / T1);
        Csg = -CoxWL * (0.5 + 24.0 * T0 * Vds / T1 / T1 * AbulkCV);
        Csb = -CoxWL * (0.25 * Vds * dAbulkCV_dVb
          - 12.0 * T0 * Vds / T1 / T1 * (4.0 * Vgsteff - T0) * dAbulkCV_dVb) + Csg * dVgsteff_dVb;
        Csd = -CoxWL * (0.25 * AbulkCV - 12.0 * AbulkCV * T0 / T1 / T1 * (4.0 * Vgsteff - T0))
          + Csg * dVgsteff_dVd;
        Csg *= dVgsteff_dVg;
      } else if (xpart < 0.5) {
        // 40/60 charge partition model
        T1 = T1 / 12.0;
        T2 = 0.5 * CoxWL / (T1 * T1);
        T3 = Vgsteff * (2.0 * T0 * T0 / 3.0 + Vgsteff * (Vgsteff - 4.0 * T0 / 3.0)) - 2.0 * T0 * T0 * T0 / 15.0;
        qsrc = -T2 * T3;
        T4 = 4.0 / 3.0 * Vgsteff * (Vgsteff - T0) + 0.4 * T0 * T0;
        Csg = -2.0 * qsrc / T1 - T2 * (Vgsteff * (3.0 * Vgsteff - 8.0 * T0 / 3.0) + 2.0 * T0 * T0 / 3.0);
        Csb = (qsrc / T1 * Vds + T2 * T4 * Vds) * dAbulkCV_dVb + Csg * dVgsteff_dVb;
        Csd = (qsrc / T1 + T2 * T4) * AbulkCV + Csg * dVgsteff_dVd;
        Csg *= dVgsteff_dVg;
      } else {
        // 50/50 charge partition model
        qsrc = -0.5 * (qgate + qbulk);
        Csg = -0.5 * (Cgg1 + Cbg1);
        Csb = -0.5 * (Cgb1 + Cbb1);
        Csd = -0.5 * (Cgd1 + Cbd1);
      }
      Cgb *= dVbseff_dVb;
      Cbb *= dVbseff_dVb;
      Csb *= dVbseff_dVb;
    }
    qdrn = -(qgate + qbulk + qsrc);
  } else if (cp.capMod === 2) {
    const Vfb = cp.vfbzb;
    const V3 = Vfb - Vgs_eff + VbseffCV - DELTA_3;
    if (Vfb <= 0.0) {
      T0 = Math.sqrt(V3 * V3 - 4.0 * DELTA_3 * Vfb);
    } else {
      T0 = Math.sqrt(V3 * V3 + 4.0 * DELTA_3 * Vfb);
    }

    T1 = 0.5 * (1.0 + V3 / T0);
    const Vfbeff = Vfb - 0.5 * (V3 + T0);
    const dVfbeff_dVg = T1 * dVgs_eff_dVg;
    const dVfbeff_dVb = -T1 * dVbseffCV_dVb;
    const Qac0 = CoxWL * (Vfbeff - Vfb);
    const dQac0_dVg = CoxWL * dVfbeff_dVg;
    const dQac0_dVb = CoxWL * dVfbeff_dVb;

    T0 = 0.5 * p.k1ox;
    T3 = Vgs_eff - Vfbeff - VbseffCV - Vgsteff;
    if (p.k1ox === 0.0) {
      T1 = 0.0;
      T2 = 0.0;
    } else if (T3 < 0.0) {
      T1 = T0 + T3 / p.k1ox;
      T2 = CoxWL;
    } else {
      T1 = Math.sqrt(T0 * T0 + T3);
      T2 = CoxWL * T0 / T1;
    }

    const Qsub0 = CoxWL * p.k1ox * (T1 - T0);

    const dQsub0_dVg = T2 * (dVgs_eff_dVg - dVfbeff_dVg - dVgsteff_dVg);
    const dQsub0_dVd = -T2 * dVgsteff_dVd;
    const dQsub0_dVb = -T2 * (dVfbeff_dVb + dVbseffCV_dVb + dVgsteff_dVb);

    const VdsatCV = Vgsteff / AbulkCV;

    const V4 = VdsatCV - Vds - DELTA_4;
    T0 = Math.sqrt(V4 * V4 + 4.0 * DELTA_4 * VdsatCV);
    let VdseffCV = VdsatCV - 0.5 * (V4 + T0);
    T1 = 0.5 * (1.0 + V4 / T0);
    T2 = DELTA_4 / T0;
    T3 = (1.0 - T1 - T2) / AbulkCV;
    let dVdseffCV_dVg = T3;
    const dVdseffCV_dVd = T1;
    let dVdseffCV_dVb = -T3 * VdsatCV * dAbulkCV_dVb;
    // Added to eliminate non-zero VdseffCV at Vds=0.0 (b3v32ld.c: not in revision 3.2)
    if (Vds === 0.0 && cp.revision >= BSIM3_REVISION.V322) {
      VdseffCV = 0.0;
      dVdseffCV_dVg = 0.0;
      dVdseffCV_dVb = 0.0;
    }

    T0 = AbulkCV * VdseffCV;
    T1 = 12.0 * (Vgsteff - 0.5 * T0 + 1e-20);
    T2 = VdseffCV / T1;
    T3 = T0 * T2;

    T4 = (1.0 - 12.0 * T2 * T2 * AbulkCV);
    T5 = (6.0 * T0 * (4.0 * Vgsteff - T0) / (T1 * T1) - 0.5);
    T6 = 12.0 * T2 * T2 * Vgsteff;

    qgate = CoxWL * (Vgsteff - 0.5 * VdseffCV + T3);
    Cgg1 = CoxWL * (T4 + T5 * dVdseffCV_dVg);
    Cgd1 = CoxWL * T5 * dVdseffCV_dVd + Cgg1 * dVgsteff_dVd;
    Cgb1 = CoxWL * (T5 * dVdseffCV_dVb + T6 * dAbulkCV_dVb) + Cgg1 * dVgsteff_dVb;
    Cgg1 *= dVgsteff_dVg;

    T7 = 1.0 - AbulkCV;
    qbulk = CoxWL * T7 * (0.5 * VdseffCV - T3);
    T4 = -T7 * (T4 - 1.0);
    T5 = -T7 * T5;
    T6 = -(T7 * T6 + (0.5 * VdseffCV - T3));
    Cbg1 = CoxWL * (T4 + T5 * dVdseffCV_dVg);
    Cbd1 = CoxWL * T5 * dVdseffCV_dVd + Cbg1 * dVgsteff_dVd;
    Cbb1 = CoxWL * (T5 * dVdseffCV_dVb + T6 * dAbulkCV_dVb) + Cbg1 * dVgsteff_dVb;
    Cbg1 *= dVgsteff_dVg;

    if (xpart > 0.5) {
      // 0/100 charge partition model
      T1 = T1 + T1;
      qsrc = -CoxWL * (0.5 * Vgsteff + 0.25 * T0 - T0 * T0 / T1);
      T7 = (4.0 * Vgsteff - T0) / (T1 * T1);
      T4 = -(0.5 + 24.0 * T0 * T0 / (T1 * T1));
      T5 = -(0.25 * AbulkCV - 12.0 * AbulkCV * T0 * T7);
      T6 = -(0.25 * VdseffCV - 12.0 * T0 * VdseffCV * T7);
      Csg = CoxWL * (T4 + T5 * dVdseffCV_dVg);
      Csd = CoxWL * T5 * dVdseffCV_dVd + Csg * dVgsteff_dVd;
      Csb = CoxWL * (T5 * dVdseffCV_dVb + T6 * dAbulkCV_dVb) + Csg * dVgsteff_dVb;
      Csg *= dVgsteff_dVg;
    } else if (xpart < 0.5) {
      // 40/60 charge partition model
      T1 = T1 / 12.0;
      T2 = 0.5 * CoxWL / (T1 * T1);
      T3 = Vgsteff * (2.0 * T0 * T0 / 3.0 + Vgsteff * (Vgsteff - 4.0 * T0 / 3.0)) - 2.0 * T0 * T0 * T0 / 15.0;
      qsrc = -T2 * T3;
      T7 = 4.0 / 3.0 * Vgsteff * (Vgsteff - T0) + 0.4 * T0 * T0;
      T4 = -2.0 * qsrc / T1 - T2 * (Vgsteff * (3.0 * Vgsteff - 8.0 * T0 / 3.0) + 2.0 * T0 * T0 / 3.0);
      T5 = (qsrc / T1 + T2 * T7) * AbulkCV;
      T6 = (qsrc / T1 * VdseffCV + T2 * T7 * VdseffCV);
      Csg = (T4 + T5 * dVdseffCV_dVg);
      Csd = T5 * dVdseffCV_dVd + Csg * dVgsteff_dVd;
      Csb = (T5 * dVdseffCV_dVb + T6 * dAbulkCV_dVb) + Csg * dVgsteff_dVb;
      Csg *= dVgsteff_dVg;
    } else {
      // 50/50 charge partition model
      qsrc = -0.5 * (qgate + qbulk);
      Csg = -0.5 * (Cgg1 + Cbg1);
      Csb = -0.5 * (Cgb1 + Cbb1);
      Csd = -0.5 * (Cgd1 + Cbd1);
    }

    qgate += Qac0 + Qsub0;
    qbulk -= (Qac0 + Qsub0);
    qdrn = -(qgate + qbulk + qsrc);

    Cgg = dQac0_dVg + dQsub0_dVg + Cgg1;
    Cgd = dQsub0_dVd + Cgd1;
    Cgb = dQac0_dVb + dQsub0_dVb + Cgb1;

    Cbg = Cbg1 - dQac0_dVg - dQsub0_dVg;
    Cbd = Cbd1 - dQsub0_dVd;
    Cbb = Cbb1 - dQac0_dVb - dQsub0_dVb;

    Cgb *= dVbseff_dVb;
    Cbb *= dVbseff_dVb;
    Csb *= dVbseff_dVb;
  } else {
    // New Charge-Thickness capMod (CTM), capMod 3
    let V3 = cp.vfbzb - Vgs_eff + VbseffCV - DELTA_3;
    if (cp.vfbzb <= 0.0) {
      T0 = Math.sqrt(V3 * V3 - 4.0 * DELTA_3 * cp.vfbzb);
    } else {
      T0 = Math.sqrt(V3 * V3 + 4.0 * DELTA_3 * cp.vfbzb);
    }

    T1 = 0.5 * (1.0 + V3 / T0);
    const Vfbeff = cp.vfbzb - 0.5 * (V3 + T0);
    const dVfbeff_dVg = T1 * dVgs_eff_dVg;
    const dVfbeff_dVb = -T1 * dVbseffCV_dVb;

    const Cox = cp.cox;
    let Tox = 1.0e8 * cp.tox;
    T0 = (Vgs_eff - VbseffCV - cp.vfbzb) / Tox;
    let dT0_dVg = dVgs_eff_dVg / Tox;
    let dT0_dVb = -dVbseffCV_dVb / Tox;

    tmp = T0 * p.acde;
    let Tcen: number, dTcen_dVg: number, dTcen_dVb: number;
    if ((-EXP_THRESHOLD < tmp) && (tmp < EXP_THRESHOLD)) {
      Tcen = p.ldeb * Math.exp(tmp);
      dTcen_dVg = p.acde * Tcen;
      dTcen_dVb = dTcen_dVg * dT0_dVb;
      dTcen_dVg *= dT0_dVg;
    } else if (tmp <= -EXP_THRESHOLD) {
      Tcen = p.ldeb * MIN_EXP;
      dTcen_dVg = dTcen_dVb = 0.0;
    } else {
      Tcen = p.ldeb * MAX_EXP;
      dTcen_dVg = dTcen_dVb = 0.0;
    }

    const LINK = 1.0e-3 * cp.tox;
    V3 = p.ldeb - Tcen - LINK;
    const V4 = Math.sqrt(V3 * V3 + 4.0 * LINK * p.ldeb);
    Tcen = p.ldeb - 0.5 * (V3 + V4);
    T1 = 0.5 * (1.0 + V3 / V4);
    dTcen_dVg *= T1;
    dTcen_dVb *= T1;

    let Ccen = EPSSI / Tcen;
    T2 = Cox / (Cox + Ccen);
    let Coxeff = T2 * Ccen;
    T3 = -Ccen / Tcen;
    let dCoxeff_dVg = T2 * T2 * T3;
    let dCoxeff_dVb = dCoxeff_dVg * dTcen_dVb;
    dCoxeff_dVg *= dTcen_dVg;
    let CoxWLcen = CoxWL * Coxeff / Cox;

    const Qac0 = CoxWLcen * (Vfbeff - cp.vfbzb);
    let QovCox = Qac0 / Coxeff;
    const dQac0_dVg = CoxWLcen * dVfbeff_dVg + QovCox * dCoxeff_dVg;
    const dQac0_dVb = CoxWLcen * dVfbeff_dVb + QovCox * dCoxeff_dVb;

    T0 = 0.5 * p.k1ox;
    T3 = Vgs_eff - Vfbeff - VbseffCV - Vgsteff;
    if (p.k1ox === 0.0) {
      T1 = 0.0;
      T2 = 0.0;
    } else if (T3 < 0.0) {
      T1 = T0 + T3 / p.k1ox;
      T2 = CoxWLcen;
    } else {
      T1 = Math.sqrt(T0 * T0 + T3);
      T2 = CoxWLcen * T0 / T1;
    }

    const Qsub0 = CoxWLcen * p.k1ox * (T1 - T0);
    QovCox = Qsub0 / Coxeff;
    const dQsub0_dVg = T2 * (dVgs_eff_dVg - dVfbeff_dVg - dVgsteff_dVg) + QovCox * dCoxeff_dVg;
    const dQsub0_dVd = -T2 * dVgsteff_dVd;
    const dQsub0_dVb = -T2 * (dVfbeff_dVb + dVbseffCV_dVb + dVgsteff_dVb) + QovCox * dCoxeff_dVb;

    // Gate-bias dependent delta Phis begins
    let Denomi: number;
    if (p.k1ox <= 0.0) {
      Denomi = 0.25 * p.moin * vtm;
      T0 = 0.5 * p.sqrtPhi;
    } else {
      Denomi = p.moin * vtm * p.k1ox * p.k1ox;
      T0 = p.k1ox * p.sqrtPhi;
    }
    T1 = 2.0 * T0 + Vgsteff;

    const DeltaPhi = vtm * Math.log(1.0 + T1 * Vgsteff / Denomi);
    const dDeltaPhi_dVg = 2.0 * vtm * (T1 - T0) / (Denomi + T1 * Vgsteff);
    // End of delta Phis

    // VgDP = Vgsteff - DeltaPhi. b3v32ld.c (3.2.x) uses Vgsteff - DeltaPhi
    // unsmoothed, with derivative 1 - dDeltaPhi_dVg in every place below.
    const v32 = cp.revision < BSIM3_REVISION.V330;
    let VgDP: number, dVgDP_dVg: number;
    if (v32) {
      VgDP = Vgsteff - DeltaPhi;
      dVgDP_dVg = 1.0 - dDeltaPhi_dVg;
    } else {
      T0 = Vgsteff - DeltaPhi - 0.001;
      dT0_dVg = 1.0 - dDeltaPhi_dVg;
      T1 = Math.sqrt(T0 * T0 + Vgsteff * 0.004);
      VgDP = 0.5 * (T0 + T1);
      dVgDP_dVg = 0.5 * (dT0_dVg + (T0 * dT0_dVg + 0.002) / T1);
    }

    T3 = 4.0 * (cv.Vth - cp.vfbzb - p.phi);
    Tox += Tox;
    let dT0_dVd: number;
    if (T3 >= 0.0) {
      T0 = (Vgsteff + T3) / Tox;
      dT0_dVd = (dVgsteff_dVd + 4.0 * dVth_dVd) / Tox;
      dT0_dVb = (dVgsteff_dVb + 4.0 * cv.dVth_dVb) / Tox;
    } else {
      T0 = (Vgsteff + 1.0e-20) / Tox;
      dT0_dVd = dVgsteff_dVd / Tox;
      dT0_dVb = dVgsteff_dVb / Tox;
    }
    tmp = Math.exp(0.7 * Math.log(T0));
    T1 = 1.0 + tmp;
    T2 = 0.7 * tmp / (T0 * Tox);
    Tcen = 1.9e-9 / T1;
    dTcen_dVg = -1.9e-9 * T2 / T1 / T1;
    let dTcen_dVd: number;
    if (cp.revision === BSIM3_REVISION.V32) {
      // b3v32ld.c revision 3.2: the 4 * dVth terms also when T3 < 0.
      dTcen_dVd = dTcen_dVg * (4.0 * dVth_dVd + dVgsteff_dVd);
      dTcen_dVb = dTcen_dVg * (4.0 * cv.dVth_dVb + dVgsteff_dVb);
    } else {
      dTcen_dVd = Tox * dTcen_dVg;
      dTcen_dVb = dTcen_dVd * dT0_dVb;
      dTcen_dVd *= dT0_dVd;
    }
    dTcen_dVg *= dVgsteff_dVg;

    Ccen = EPSSI / Tcen;
    T0 = Cox / (Cox + Ccen);
    Coxeff = T0 * Ccen;
    T1 = -Ccen / Tcen;
    dCoxeff_dVg = T0 * T0 * T1;
    const dCoxeff_dVd = dCoxeff_dVg * dTcen_dVd;
    dCoxeff_dVb = dCoxeff_dVg * dTcen_dVb;
    dCoxeff_dVg *= dTcen_dVg;
    CoxWLcen = CoxWL * Coxeff / Cox;

    const VdsatCV = VgDP / AbulkCV;
    let VdseffCV: number, dVdseffCV_dVg: number, dVdseffCV_dVd: number, dVdseffCV_dVb: number;
    if (v32) {
      // b3v32ld.c: the capMod 2 VdseffCV smoothing of VdsatCV.
      const V4 = VdsatCV - Vds - DELTA_4;
      T0 = Math.sqrt(V4 * V4 + 4.0 * DELTA_4 * VdsatCV);
      VdseffCV = VdsatCV - 0.5 * (V4 + T0);
      T1 = 0.5 * (1.0 + V4 / T0);
      T2 = DELTA_4 / T0;
      T3 = (1.0 - T1 - T2) / AbulkCV;
      dVdseffCV_dVg = T3 * dVgDP_dVg;
      dVdseffCV_dVd = T1;
      dVdseffCV_dVb = -T3 * VdsatCV * dAbulkCV_dVb;
    } else {
      T0 = VdsatCV - Vds - DELTA_4;
      dT0_dVg = dVgDP_dVg / AbulkCV;
      dT0_dVb = -VdsatCV * dAbulkCV_dVb / AbulkCV;
      T1 = Math.sqrt(T0 * T0 + 4.0 * DELTA_4 * VdsatCV);
      let dT1_dVg = (T0 + DELTA_4 + DELTA_4) / T1;
      const dT1_dVd = -T0 / T1;
      const dT1_dVb = dT1_dVg * dT0_dVb;
      dT1_dVg *= dT0_dVg;
      if (T0 >= 0.0) {
        VdseffCV = VdsatCV - 0.5 * (T0 + T1);
        dVdseffCV_dVg = 0.5 * (dT0_dVg - dT1_dVg);
        dVdseffCV_dVd = 0.5 * (1.0 - dT1_dVd);
        dVdseffCV_dVb = 0.5 * (dT0_dVb - dT1_dVb);
      } else {
        T3 = (DELTA_4 + DELTA_4) / (T1 - T0);
        T4 = 1.0 - T3;
        T5 = VdsatCV * T3 / (T1 - T0);
        VdseffCV = VdsatCV * T4;
        dVdseffCV_dVg = dT0_dVg * T4 + T5 * (dT1_dVg - dT0_dVg);
        dVdseffCV_dVd = T5 * (dT1_dVd + 1.0);
        dVdseffCV_dVb = dT0_dVb * (1.0 - T5) + T5 * dT1_dVb;
      }
    }

    // Added to eliminate non-zero VdseffCV at Vds=0.0 (b3v32ld.c: not in revision 3.2)
    if (Vds === 0.0 && cp.revision >= BSIM3_REVISION.V322) {
      VdseffCV = 0.0;
      dVdseffCV_dVg = 0.0;
      dVdseffCV_dVb = 0.0;
    }

    T0 = AbulkCV * VdseffCV;
    T1 = VgDP;
    T2 = 12.0 * (T1 - 0.5 * T0 + 1.0e-20);
    T3 = T0 / T2;
    T4 = 1.0 - 12.0 * T3 * T3;
    T5 = AbulkCV * (6.0 * T0 * (4.0 * T1 - T0) / (T2 * T2) - 0.5);
    T6 = T5 * VdseffCV / AbulkCV;

    qgate = CoxWLcen * (T1 - T0 * (0.5 - T3));
    QovCox = qgate / Coxeff;
    Cgg1 = CoxWLcen * (T4 * dVgDP_dVg + T5 * dVdseffCV_dVg);
    Cgd1 = CoxWLcen * T5 * dVdseffCV_dVd + Cgg1 * dVgsteff_dVd + QovCox * dCoxeff_dVd;
    Cgb1 = CoxWLcen * (T5 * dVdseffCV_dVb + T6 * dAbulkCV_dVb) + Cgg1 * dVgsteff_dVb + QovCox * dCoxeff_dVb;
    Cgg1 = Cgg1 * dVgsteff_dVg + QovCox * dCoxeff_dVg;

    T7 = 1.0 - AbulkCV;
    T8 = T2 * T2;
    T9 = 12.0 * T7 * T0 * T0 / (T8 * AbulkCV);
    T10 = T9 * dVgDP_dVg;
    T11 = -T7 * T5 / AbulkCV;
    T12 = -(T9 * T1 / AbulkCV + VdseffCV * (0.5 - T0 / T2));

    qbulk = CoxWLcen * T7 * (0.5 * VdseffCV - T0 * VdseffCV / T2);
    QovCox = qbulk / Coxeff;
    Cbg1 = CoxWLcen * (T10 + T11 * dVdseffCV_dVg);
    Cbd1 = CoxWLcen * T11 * dVdseffCV_dVd + Cbg1 * dVgsteff_dVd + QovCox * dCoxeff_dVd;
    Cbb1 = CoxWLcen * (T11 * dVdseffCV_dVb + T12 * dAbulkCV_dVb) + Cbg1 * dVgsteff_dVb + QovCox * dCoxeff_dVb;
    Cbg1 = Cbg1 * dVgsteff_dVg + QovCox * dCoxeff_dVg;

    if (xpart > 0.5) {
      // 0/100 partition
      qsrc = -CoxWLcen * (T1 / 2.0 + T0 / 4.0 - 0.5 * T0 * T0 / T2);
      QovCox = qsrc / Coxeff;
      T2 += T2;
      T3 = T2 * T2;
      T7 = -(0.25 - 12.0 * T0 * (4.0 * T1 - T0) / T3);
      T4 = -(0.5 + 24.0 * T0 * T0 / T3) * dVgDP_dVg;
      T5 = T7 * AbulkCV;
      T6 = T7 * VdseffCV;

      Csg = CoxWLcen * (T4 + T5 * dVdseffCV_dVg);
      Csd = CoxWLcen * T5 * dVdseffCV_dVd + Csg * dVgsteff_dVd + QovCox * dCoxeff_dVd;
      Csb = CoxWLcen * (T5 * dVdseffCV_dVb + T6 * dAbulkCV_dVb) + Csg * dVgsteff_dVb + QovCox * dCoxeff_dVb;
      Csg = Csg * dVgsteff_dVg + QovCox * dCoxeff_dVg;
    } else if (xpart < 0.5) {
      // 40/60 partition
      T2 = T2 / 12.0;
      T3 = 0.5 * CoxWLcen / (T2 * T2);
      T4 = T1 * (2.0 * T0 * T0 / 3.0 + T1 * (T1 - 4.0 * T0 / 3.0)) - 2.0 * T0 * T0 * T0 / 15.0;
      qsrc = -T3 * T4;
      QovCox = qsrc / Coxeff;
      T8 = 4.0 / 3.0 * T1 * (T1 - T0) + 0.4 * T0 * T0;
      T5 = -2.0 * qsrc / T2 - T3 * (T1 * (3.0 * T1 - 8.0 * T0 / 3.0) + 2.0 * T0 * T0 / 3.0);
      T6 = AbulkCV * (qsrc / T2 + T3 * T8);
      T7 = T6 * VdseffCV / AbulkCV;

      Csg = T5 * dVgDP_dVg + T6 * dVdseffCV_dVg;
      Csd = Csg * dVgsteff_dVd + T6 * dVdseffCV_dVd + QovCox * dCoxeff_dVd;
      Csb = Csg * dVgsteff_dVb + T6 * dVdseffCV_dVb + T7 * dAbulkCV_dVb + QovCox * dCoxeff_dVb;
      Csg = Csg * dVgsteff_dVg + QovCox * dCoxeff_dVg;
    } else {
      // 50/50 partition
      qsrc = -0.5 * qgate;
      Csg = -0.5 * Cgg1;
      Csd = -0.5 * Cgd1;
      Csb = -0.5 * Cgb1;
    }

    qgate += Qac0 + Qsub0 - qbulk;
    qbulk -= (Qac0 + Qsub0);
    qdrn = -(qgate + qbulk + qsrc);

    Cbg = Cbg1 - dQac0_dVg - dQsub0_dVg;
    Cbd = Cbd1 - dQsub0_dVd;
    Cbb = Cbb1 - dQac0_dVb - dQsub0_dVb;

    Cgg = Cgg1 - Cbg;
    Cgd = Cgd1 - Cbd;
    Cgb = Cgb1 - Cbb;

    Cgb *= dVbseff_dVb;
    Cbb *= dVbseff_dVb;
    Csb *= dVbseff_dVb;
  }

  out.cggb = Cgg;
  out.cgsb = -(Cgg + Cgd + Cgb);
  out.cgdb = Cgd;
  out.cdgb = -(Cgg + Cbg + Csg);
  out.cdsb = (Cgg + Cgd + Cgb + Cbg + Cbd + Cbb + Csg + Csd + Csb);
  out.cddb = -(Cgd + Cbd + Csd);
  out.cbgb = Cbg;
  out.cbsb = -(Cbg + Cbd + Cbb);
  out.cbdb = Cbd;
  out.qgate = qgate;
  out.qbulk = qbulk;
  out.qdrn = qdrn;
  return out;
}

/**
 * b3ld.c bulk-junction depletion charge for one junction (acmMod = 0):
 * writes [charge, capacitance] for the junction voltage `v` (bulk positive).
 */
function junctionCharge(
  v: number, czb: number, czbsw: number, czbswg: number, cp: BSIM3ChargeParams,
  out: Float64Array, offset: number,
): void {
  const { mj, mjsw, mjswg } = cp;
  if (v === 0.0) {
    out[offset] = 0.0;
    out[offset + 1] = czb + czbsw + czbswg;
  } else if (v < 0.0) {
    let q = 0.0;
    let c = 0.0;
    if (czb > 0.0) {
      const arg = 1.0 - v / cp.phiB;
      const sarg = mj === 0.5 ? 1.0 / Math.sqrt(arg) : Math.exp(-mj * Math.log(arg));
      q = cp.phiB * czb * (1.0 - arg * sarg) / (1.0 - mj);
      c = czb * sarg;
    }
    if (czbsw > 0.0) {
      const arg = 1.0 - v / cp.phiBSW;
      const sarg = mjsw === 0.5 ? 1.0 / Math.sqrt(arg) : Math.exp(-mjsw * Math.log(arg));
      q += cp.phiBSW * czbsw * (1.0 - arg * sarg) / (1.0 - mjsw);
      c += czbsw * sarg;
    }
    if (czbswg > 0.0) {
      const arg = 1.0 - v / cp.phiBSWG;
      const sarg = mjswg === 0.5 ? 1.0 / Math.sqrt(arg) : Math.exp(-mjswg * Math.log(arg));
      q += cp.phiBSWG * czbswg * (1.0 - arg * sarg) / (1.0 - mjswg);
      c += czbswg * sarg;
    }
    out[offset] = q;
    out[offset + 1] = c;
  } else {
    const T0 = czb + czbsw + czbswg;
    const T1 = v * (czb * mj / cp.phiB + czbsw * mjsw / cp.phiBSW + czbswg * mjswg / cp.phiBSWG);
    out[offset] = v * (T0 + 0.5 * T1);
    out[offset + 1] = T0 + T1;
  }
}

/** b3ld.c gate overlap charge and capacitance at `v` (Vgd or Vgs); writes [q, c]. */
function overlapCharge(
  v: number, cgo: number, weffCgl: number, ckappa: number, capMod: number,
  out: Float64Array, offset: number,
): void {
  if (capMod === 0) {
    out[offset] = cgo * v;
    out[offset + 1] = cgo;
  } else if (capMod === 1) {
    if (v < 0.0) {
      const T1 = Math.sqrt(1.0 - 4.0 * v / ckappa);
      out[offset + 1] = cgo + weffCgl / T1;
      out[offset] = cgo * v - weffCgl * 0.5 * ckappa * (T1 - 1.0);
    } else {
      out[offset + 1] = cgo + weffCgl;
      out[offset] = (weffCgl + cgo) * v;
    }
  } else {
    const T0 = v + DELTA_1;
    const T1 = Math.sqrt(T0 * T0 + 4.0 * DELTA_1);
    const T2 = 0.5 * (T0 - T1);
    const T3 = weffCgl;
    const T4 = Math.sqrt(1.0 - 4.0 * T2 / ckappa);
    out[offset + 1] = cgo + T3 - T3 * (1.0 - 1.0 / T4) * (0.5 - 0.5 * T0 / T1);
    out[offset] = (cgo + T3) * v - T3 * (T2 + 0.5 * ckappa * (T4 - 1.0));
  }
}

/**
 * Terminal charges of one BSIM3 instance (NMOS convention) as ngspice-47
 * stores them in CKTstate0 (qg, qd = qdrn - qbd, qb = qbulk + qbd + qbs),
 * plus their 4x4 Jacobian with respect to the D, G, S, B terminal voltages:
 * `jacobian[row * 4 + col]` = d(q of terminal row)/d(V of terminal col), rows
 * and columns in {@link TERMINAL} order. Row S is the negated sum of the
 * other rows (charge neutrality); every row sums to zero across columns.
 */
export interface BSIM3TerminalCharges {
  qg: number; qd: number; qb: number;
  capbd: number; capbs: number;
  readonly jacobian: Float64Array;
  readonly intrinsic: BSIM3IntrinsicCharge;
}

/** Terminal index into {@link BSIM3TerminalCharges.jacobian}. */
export const TERMINAL = { D: 0, G: 1, S: 2, B: 3 } as const;

export function createTerminalCharges(): BSIM3TerminalCharges {
  return { qg: 0, qd: 0, qb: 0, capbd: 0, capbs: 0, jacobian: new Float64Array(16), intrinsic: createIntrinsicCharge() };
}

const dcScratch: BSIM3v3DCResult = createDCResult();
const inputScratch: BSIM3v3ChargeInputs = createChargeInputs();
const pairScratch = new Float64Array(8);

/**
 * ngspice-47 b3ld.c charges at the polarity-domain physical terminal voltages
 * (vgs, vds, vbs, not interchanged): the intrinsic charge of the effective
 * orientation (BSIM3mode = -1 when vds < 0), the overlap and junction
 * charges, assembled and differentiated as b3ld.c does for nqsMod = 0.
 * `inputs`, when given, are the evaluateDC charge inputs already computed at
 * this bias in the effective orientation (b3ld.c evaluates both in one load).
 */
export function evaluateTerminalCharges(
  model: BSIM3Model,
  size: BSIM3Size,
  cp: BSIM3ChargeParams,
  vgs: number,
  vds: number,
  vbs: number,
  out: BSIM3TerminalCharges,
  inputs?: BSIM3v3ChargeInputs,
  nonQuasiStatic = false,
): BSIM3TerminalCharges {
  const vbd = vbs - vds;
  const vgd = vgs - vds;
  const vgb = vgs - vbs;
  const forward = vds >= 0;
  let cv = inputs;
  if (cv === undefined) {
    cv = inputScratch;
    if (forward) evaluateDC(model, size, vgs, vds, vbs, dcScratch, cv);
    else evaluateDC(model, size, vgd, -vds, vbd, dcScratch, cv);
  }
  const ic = evaluateIntrinsicCharge(
    cp, size, model.vtm, cv, forward ? vds : -vds, forward ? vbs : vbd, out.intrinsic,
  );

  // Bulk junctions (state qbs/qbd, capbs/capbd).
  const pair = pairScratch;
  junctionCharge(vbs, cp.czbs, cp.czbssw, cp.czbsswg, cp, pair, 0);
  junctionCharge(vbd, cp.czbd, cp.czbdsw, cp.czbdswg, cp, pair, 2);
  const qbs = pair[0];
  const capbs = pair[1];
  const qbd = pair[2];
  const capbd = pair[3];
  // Gate overlaps.
  overlapCharge(vgd, cp.cgdo, cp.cgdl, cp.ckappa, cp.capMod, pair, 4);
  overlapCharge(vgs, cp.cgso, cp.cgsl, cp.ckappa, cp.capMod, pair, 6);
  const qgdo = pair[4];
  const cgdo = pair[5];
  const qgso = pair[6];
  const cgso = pair[7];
  const cgbo = cp.cgbo;
  const qgb = cgbo * vgb;

  // b3ld.c:2613-2626,2668-2673: NQS integrates only overlap/junction
  // charges here. Keep the intrinsic result for the channel relaxation state.
  const { cggb, cgdb, cgsb, cdgb, cddb, cdsb, cbgb, cbdb, cbsb } = nonQuasiStatic ? ZERO_INTRINSIC : ic;
  const qgate = (nonQuasiStatic ? 0 : ic.qgate) + qgdo + qgso + qgb;
  const qbulk = (nonQuasiStatic ? 0 : ic.qbulk) - qgb;
  let qdrn: number;
  // Jacobian columns G, D, S (bulk reference) of the gate, drain and bulk
  // charges, as b3ld.c's gc**b terms without the CKTag[0] factor.
  let gg: number, gd: number, gs: number, dg: number, dd: number, ds: number;
  let bg: number, bd: number, bs: number;
  if (forward) {
    qdrn = (nonQuasiStatic ? 0 : ic.qdrn) - qgdo;
    gg = cggb + cgdo + cgso + cgbo; gd = cgdb - cgdo; gs = cgsb - cgso;
    dg = cdgb - cgdo; dd = cddb + capbd + cgdo; ds = cdsb;
    bg = cbgb - cgbo; bd = cbdb - capbd; bs = cbsb - capbs;
  } else {
    const qsrc = (nonQuasiStatic ? 0 : ic.qdrn) - qgso;
    qdrn = -(qgate + qbulk + qsrc);
    gg = cggb + cgdo + cgso + cgbo; gd = cgsb - cgdo; gs = cgdb - cgso;
    dg = -(cggb + cbgb + cdgb + cgdo); dd = capbd + cgdo - (cgsb + cbsb + cdsb); ds = -(cgdb + cbdb + cddb);
    bg = cbgb - cgbo; bd = cbsb - capbd; bs = cbdb - capbs;
  }
  out.qg = qgate;
  out.qd = qdrn - qbd;
  out.qb = qbulk + qbd + qbs;
  out.capbd = capbd;
  out.capbs = capbs;

  const j = out.jacobian;
  const setRow = (row: number, cg: number, cd: number, cs: number): void => {
    j[row * 4 + TERMINAL.D] = cd;
    j[row * 4 + TERMINAL.G] = cg;
    j[row * 4 + TERMINAL.S] = cs;
    j[row * 4 + TERMINAL.B] = -(cg + cd + cs);
  };
  setRow(TERMINAL.G, gg, gd, gs);
  setRow(TERMINAL.D, dg, dd, ds);
  setRow(TERMINAL.B, bg, bd, bs);
  setRow(TERMINAL.S, -(gg + dg + bg), -(gd + dd + bd), -(gs + ds + bs));
  return out;
}

const ZERO_INTRINSIC = { cggb: 0, cgdb: 0, cgsb: 0, cdgb: 0, cddb: 0, cdsb: 0, cbgb: 0, cbdb: 0, cbsb: 0 };
