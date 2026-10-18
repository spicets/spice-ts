import type {
  ChargeIntegration, ChargeTruncation, ConvergenceTolerances, DeviceModel, StampContext,
} from './device.js';
import { DEVICE_GMIN } from './device.js';
import { stampChargeCurrent, TransientChargeState } from './charge-state.js';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../errors.js';
import { fetlim, limvds, stepScale } from './devsup.js';

/**
 * Shared load of the classic Berkeley short-channel IGFET models BSIM1
 * (MOSFET LEVEL=4) and BSIM2 (LEVEL=5), ported from ngspice-47
 * src/spicelib/devices/bsim1/b1ld.c and bsim2/b2ld.c. The two load routines are
 * identical apart from the evaluator they call (B1evaluate / B2evaluate), so
 * this file holds the junctions, limiting, mode selection, the charge
 * (B1mosCap/B2mosCap) and AC (b1acld.c/b2acld.c) stamps, the convergence test
 * (b1cvtest.c) and the truncation charges (b1trunc.c); bsim1.ts and bsim2.ts
 * hold the model cards and evaluators.
 *
 * Neither model has a temperature law in ngspice-47: the junctions use
 * CONSTvt0 (27 C) and BSIM2's thermal voltage comes from the model card's
 * TEMP, so the circuit temperature is recorded and ignored, as in ngspice.
 */

// ngspice const.h / main.c: CONSTvt0 = CONSTboltz * REFTEMP / CHARGE.
const CHARGE = 1.6021766208e-19;
const CONSTBOLTZ = 1.38064852e-23;
const REFTEMP = 27 + 273.15;
export const CONSTVT0 = CONSTBOLTZ * REFTEMP / CHARGE;
const CONSTROOT2 = Math.SQRT2;

/** Outputs of B1evaluate / B2evaluate, in the evaluator's (drain = higher potential) frame. */
export interface ClassicBsimEvaluation {
  gm: number;
  gds: number;
  gmbs: number;
  qg: number;
  qb: number;
  qd: number;
  cggb: number;
  cgdb: number;
  cgsb: number;
  cbgb: number;
  cbdb: number;
  cbsb: number;
  cdgb: number;
  cddb: number;
  cdsb: number;
  cdrain: number;
  von: number;
  vdsat: number;
}

export function emptyEvaluation(): ClassicBsimEvaluation {
  return {
    gm: 0, gds: 0, gmbs: 0, qg: 0, qb: 0, qd: 0,
    cggb: 0, cgdb: 0, cgsb: 0, cbgb: 0, cbdb: 0, cbsb: 0, cdgb: 0, cddb: 0, cdsb: 0,
    cdrain: 0, von: 0, vdsat: 0,
  };
}

/** Instance parameters common to BSIM1 and BSIM2 (b1set.c / b2set.c defaults). */
export interface ClassicBsimInstance {
  L: number;
  W: number;
  M: number;
  AD: number;
  AS: number;
  PD: number;
  PS: number;
  NRD: number;
  NRS: number;
}

/** Model and per-instance quantities the shared load needs from bsim1.ts / bsim2.ts. */
export interface ClassicBsimSetup {
  kind: 'BSIM1' | 'BSIM2';
  polarity: number;
  /** Zero-bias threshold from the temp routine (B1vt0 / pParam->B2vt0). */
  vt0: number;
  /** DL in micrometres. */
  deltaL: number;
  jctSatCurDensity: number;
  unitAreaJctCap: number;
  unitLengthSidewallJctCap: number;
  bulkJctPotential: number;
  sidewallJctPotential: number;
  bulkJctBotGradingCoeff: number;
  bulkJctSideGradingCoeff: number;
  /** Model CGSO / CGDO / CGBO (per metre). */
  cgso: number;
  cgdo: number;
  cgbo: number;
  /** Overlap capacitances the AC load uses (temp routine: effective W, BSIM1 drawn L). */
  acOverlap: { gd: number; gs: number; gb: number };
  evaluate(vds: number, vbs: number, vgs: number, chargeNeeded: boolean, out: ClassicBsimEvaluation): void;
}

/** Instance parameters b1par.c / b2par.c accept on an M card. */
const INSTANCE_PARAMETERS = new Set(['L', 'W', 'M', 'AD', 'AS', 'PD', 'PS', 'NRD', 'NRS', 'OFF', 'VDS', 'VGS', 'VBS', 'IC']);

/** b1set.c / b2set.c instance defaulting (L and W default to 5 um, not .options DEFL/DEFW). */
export function resolveClassicBsimInstance(
  kind: string,
  deviceName: string,
  params: Readonly<Record<string, number | undefined>> | undefined,
): ClassicBsimInstance {
  const p = params ?? {};
  for (const key of Object.keys(p)) {
    if (!INSTANCE_PARAMETERS.has(key.toUpperCase())) {
      throw new UnsupportedModelParameterError(
        deviceName, key, `not a ${kind} instance parameter`, { model: kind },
      );
    }
  }
  return {
    L: p.L ?? 5e-6,
    W: p.W ?? 5e-6,
    M: p.M ?? 1,
    AD: p.AD ?? 0,
    AS: p.AS ?? 0,
    PD: p.PD ?? 0,
    PS: p.PS ?? 0,
    NRD: p.NRD ?? 1,
    NRS: p.NRS ?? 1,
  };
}

/**
 * Series drain/source resistances (b1temp.c): RSH * NRD and RSH * NRS, each
 * creating a prime node only when non-zero (b1set.c). The parallel multiplier
 * scales the conductance (b1ld.c `m * drainConductance`).
 */
export function classicBsimSeriesResistances(
  sheetResistance: number,
  instance: ClassicBsimInstance,
): { drain: number; source: number } {
  return {
    drain: sheetResistance * instance.NRD / instance.M,
    source: sheetResistance * instance.NRS / instance.M,
  };
}

/** devsup.c DEVpnjlim; returns the limited voltage and whether it limited. */
function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): [number, boolean] {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      const arg = (vnew - vold) / vt;
      return [arg > 0 ? vold + vt * (2 + Math.log(arg - 2)) : vold - vt * (2 + Math.log(2 - arg)), true];
    }
    return [vt * Math.log(vnew / vt), true];
  }
  if (vnew < 0) {
    const arg = vold > 0 ? -1 * vold - 1 : 2 * vold - 1;
    if (vnew < arg) return [arg, true];
  }
  return [vnew, false];
}

/** b1ld.c bulk junction depletion charge and capacitance. */
function junctionCharge(
  v: number, czb: number, czbsw: number, phiB: number, phiBSW: number, mj: number, mjsw: number,
): [number, number] {
  if (v < 0) {
    const arg = 1 - v / phiB;
    const argsw = 1 - v / phiBSW;
    const sarg = Math.exp(-mj * Math.log(arg));
    const sargsw = Math.exp(-mjsw * Math.log(argsw));
    return [
      phiB * czb * (1 - arg * sarg) / (1 - mj) + phiBSW * czbsw * (1 - argsw * sargsw) / (1 - mjsw),
      czb * sarg + czbsw * sargsw,
    ];
  }
  return [
    v * (czb + czbsw) + v * v * (czb * mj * 0.5 / phiB + czbsw * mjsw * 0.5 / phiBSW),
    czb + czbsw + v * (czb * mj / phiB + czbsw * mjsw / phiBSW),
  ];
}

/** Physical-frame charges and transcapacitances (d = physical drain prime, s = source prime). */
interface ChargeFrame {
  /** Terminal charges stored by b1ld.c: B1qg, B1qd = qdrn - qbd, B1qb = qbulk + qbd + qbs. */
  qg: number;
  qd: number;
  qb: number;
  gcggb: number; gcgdb: number; gcgsb: number;
  gcbgb: number; gcbdb: number; gcbsb: number;
  gcdgb: number; gcddb: number; gcdsb: number;
  gcsgb: number; gcsdb: number; gcssb: number;
}

/** Terminal-charge indices (ngspice B1qg, B1qb, B1qd). */
const QG = 0;
const QB = 1;
const QD = 2;

// Shared helpers avoid allocating/naming closures on every Newton load.
function solutionVoltage(solution: Float64Array, node: number): number {
  return node >= 0 ? solution[node] : 0;
}

function contextVoltage(ctx: StampContext, node: number): number {
  return node >= 0 ? ctx.getVoltage(node) : 0;
}

function stampConductance(ctx: StampContext, m: number, row: number, col: number, value: number): void {
  if (row >= 0 && col >= 0) ctx.stampG(row, col, m * value);
}

function stampRhs(ctx: StampContext, m: number, row: number, value: number): void {
  if (row >= 0) ctx.stampB(row, m * value);
}

/** The limited polarity-domain voltages and DC results of the last load. */
interface LoadState {
  vgs: number;
  vds: number;
  vbs: number;
  vbd: number;
  mode: number;
  cd: number;
  cbs: number;
  cbd: number;
  gm: number;
  gds: number;
  gmbs: number;
  gbd: number;
  gbs: number;
}

export class ClassicBsimMosfet implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (B1trunc/B2trunc: qb, qg, qd). */
  readonly truncationCoversCharges = true;
  readonly integratesTransientCharge = true;
  readonly storesCharge = true;
  private temperature = 27;
  private readonly sourceSatCurrent: number;
  private readonly drainSatCurrent: number;
  private readonly sourceVcrit: number;
  private readonly drainVcrit: number;
  private readonly effectiveLength: number;
  private readonly charges = new TransientChargeState(3);
  private readonly evaluation = emptyEvaluation();
  private readonly frameScratch: ChargeFrame = {
    qg: 0, qd: 0, qb: 0,
    gcggb: 0, gcgdb: 0, gcgsb: 0, gcbgb: 0, gcbdb: 0, gcbsb: 0,
    gcdgb: 0, gcddb: 0, gcdsb: 0, gcsgb: 0, gcsdb: 0, gcssb: 0,
  };
  /** ngspice CKTstate0 of the previous load (polarity domain). */
  private state: LoadState = {
    vgs: 0, vds: 0, vbs: 0, vbd: 0, mode: 1, cd: 0, cbs: 0, cbd: 0, gm: 0, gds: 0, gmbs: 0, gbd: 0, gbs: 0,
  };
  /** here->B1von in the polarity domain (b1temp.c initialises it to type * vt0). */
  private lastVon: number;
  private limited = false;
  /** Unlimited polarity-domain voltages the last load read (ngspice CKTrhsOld). */
  private loadVoltages = { vgs: 0, vds: 0, vbs: 0 };

  private dcSweepStamp: { ctx: StampContext; values: Float64Array; rhs: Float64Array; slots: Int32Array } | undefined;

  /** Bind only a locked DC sweep topology; other contexts retain generic stamping. */
  bindDCSweepStamp(binding?: {
    ctx: StampContext; values: Float64Array; rhs: Float64Array;
    index(row: number, col: number): number;
  }): void {
    this.dcSweepStamp = undefined;
    if (!binding) return;
    const [d, g, s, b] = this.nodes;
    const pairs = [[b, b], [d, d], [s, s], [b, d], [b, s], [d, g], [d, b], [d, s], [s, g], [s, b], [s, d]];
    const slots = Int32Array.from(pairs, ([row, col]) => row >= 0 && col >= 0 ? binding.index(row, col) : -1);
    this.dcSweepStamp = { ctx: binding.ctx, values: binding.values, rhs: binding.rhs, slots };
  }

  constructor(
    readonly name: string,
    /** [drain', gate, source', bulk]: the prime nodes behind any RSH resistors. */
    readonly nodes: number[],
    readonly setup: ClassicBsimSetup,
    readonly instance: ClassicBsimInstance,
  ) {
    const { jctSatCurDensity } = setup;
    // b1ld.c: saturation currents below 1e-15 A are raised to 1e-15 A.
    const drainSat = instance.AD * jctSatCurDensity;
    const sourceSat = instance.AS * jctSatCurDensity;
    this.drainSatCurrent = drainSat < 1e-15 ? 1e-15 : drainSat;
    this.sourceSatCurrent = sourceSat < 1e-15 ? 1e-15 : sourceSat;
    this.sourceVcrit = CONSTVT0 * Math.log(CONSTVT0 / (CONSTROOT2 * this.sourceSatCurrent));
    this.drainVcrit = CONSTVT0 * Math.log(CONSTVT0 / (CONSTROOT2 * this.drainSatCurrent));
    this.effectiveLength = instance.L - setup.deltaL * 1e-6;
    this.lastVon = setup.polarity * setup.vt0;
  }

  /** ngspice-47 BSIM1/BSIM2 have no circuit-temperature law; the value is recorded only. */
  setTemperature(value: number): void {
    this.temperature = value;
  }

  getTemperature(): number {
    return this.temperature;
  }

  /** Terminal voltages [vgs, vds, vbs] in the polarity domain. */
  private terminalVoltages(voltage: (node: number) => number): [number, number, number] {
    const [nD, nG, nS, nB] = this.nodes;
    const type = this.setup.polarity;
    const vS = voltage(nS);
    return [type * (voltage(nG) - vS), type * (voltage(nD) - vS), type * (voltage(nB) - vS)];
  }

  limitNewtonStep(previous: Float64Array, candidate: Float64Array): number {
    const [nD, nG, nS] = this.nodes;
    const type = this.setup.polarity;
    const sOld = solutionVoltage(previous, nS);
    const sNew = solutionVoltage(candidate, nS);
    const vgsOld = type * (solutionVoltage(previous, nG) - sOld);
    const vdsOld = type * (solutionVoltage(previous, nD) - sOld);
    const vgsNew = type * (solutionVoltage(candidate, nG) - sNew);
    const vdsNew = type * (solutionVoltage(candidate, nD) - sNew);
    const vgdOld = vgsOld - vdsOld;
    const vgdNew = vgsNew - vdsNew;
    const von = this.lastVon;
    // b1ld.c limits vgs (vgd in inverse mode) with DEVfetlim and vds with
    // DEVlimvds; spice-ts applies them as a scale on the whole Newton step.
    const gateScale = vdsOld >= 0
      ? stepScale(vgsOld, vgsNew, fetlim(vgsNew, vgsOld, von))
      : stepScale(vgdOld, vgdNew, fetlim(vgdNew, vgdOld, von));
    const drainScale = vdsOld >= 0
      ? stepScale(vdsOld, vdsNew, limvds(vdsNew, vdsOld))
      : stepScale(-vdsOld, -vdsNew, limvds(-vdsNew, -vdsOld));
    return Math.min(gateScale, drainScale);
  }

  limitedLastStamp(): boolean {
    return this.limited;
  }

  /**
   * b1cvtest.c / b2cvtest.c. ngspice evaluates the predicted drain and bulk
   * currents at CKTrhsOld, the iterate the last load linearised at (not the
   * new Newton solution), so the test only fails when the load's limiting
   * moved the voltages away from that iterate. `_solution` is therefore unused.
   */
  convergenceTest(_solution: Float64Array, tolerances: ConvergenceTolerances): boolean {
    const { vgs, vds, vbs } = this.loadVoltages;
    const s = this.state;
    const vbd = vbs - vds;
    const vgd = vgs - vds;
    const vgdo = s.vgs - s.vds;
    const delvbs = vbs - s.vbs;
    const delvbd = vbd - s.vbd;
    const delvgs = vgs - s.vgs;
    const delvds = vds - s.vds;
    const delvgd = vgd - vgdo;
    const cdhat = s.mode >= 0
      ? s.cd - s.gbd * delvbd + s.gmbs * delvbs + s.gm * delvgs + s.gds * delvds
      : s.cd - (s.gbd - s.gmbs) * delvbd - s.gm * delvgd + s.gds * delvds;
    const cbhat = s.cbs + s.cbd + s.gbd * delvbd + s.gbs * delvbs;
    const { reltol, abstol } = tolerances;
    if (Math.abs(cdhat - s.cd) >= reltol * Math.max(Math.abs(cdhat), Math.abs(s.cd)) + abstol) return false;
    return Math.abs(cbhat - (s.cbs + s.cbd)) <= reltol * Math.max(Math.abs(cbhat), Math.abs(s.cbs + s.cbd)) + abstol;
  }

  /** Evaluate the channel at polarity-domain voltages, mapping inverse mode as b1ld.c does. */
  private evaluateChannel(vgs: number, vds: number, vbs: number, chargeNeeded: boolean): ClassicBsimEvaluation {
    const out = this.evaluation;
    if (vds >= 0) {
      this.setup.evaluate(vds, vbs, vgs, chargeNeeded, out);
    } else {
      this.setup.evaluate(-vds, vbs - vds, vgs - vds, chargeNeeded, out);
    }
    return out;
  }

  stamp(ctx: StampContext): void {
    const type = this.setup.polarity;
    const m = this.instance.M;
    const gmin = ctx.gmin ?? DEVICE_GMIN;
    const [nD, nG, nS, nB] = this.nodes;
    const vS = contextVoltage(ctx, nS);
    const vgs = type * (contextVoltage(ctx, nG) - vS);
    const vds = type * (contextVoltage(ctx, nD) - vS);
    const vbsRaw = type * (contextVoltage(ctx, nB) - vS);
    this.loadVoltages = { vgs, vds, vbs: vbsRaw };

    // b1ld.c junction limiting against CKTstate0 (DEVfetlim/DEVlimvds act through limitNewtonStep).
    let vbs = vbsRaw;
    let vbd = vbs - vds;
    let limited: boolean;
    if (vds >= 0) {
      [vbs, limited] = pnjlim(vbs, this.state.vbs, CONSTVT0, this.sourceVcrit);
      vbd = vbs - vds;
    } else {
      [vbd, limited] = pnjlim(vbd, this.state.vbd, CONSTVT0, this.drainVcrit);
      vbs = vbd + vds;
    }
    this.limited = limited;

    const isS = this.sourceSatCurrent;
    const isD = this.drainSatCurrent;
    let gbs: number;
    let cbs: number;
    if (vbs <= 0) {
      gbs = isS / CONSTVT0 + gmin;
      cbs = gbs * vbs;
    } else {
      const evbs = Math.exp(vbs / CONSTVT0);
      gbs = isS * evbs / CONSTVT0 + gmin;
      cbs = isS * (evbs - 1) + gmin * vbs;
    }
    let gbd: number;
    let cbd: number;
    if (vbd <= 0) {
      gbd = isD / CONSTVT0 + gmin;
      cbd = gbd * vbd;
    } else {
      const evbd = Math.exp(vbd / CONSTVT0);
      gbd = isD * evbd / CONSTVT0 + gmin;
      cbd = isD * (evbd - 1) + gmin * vbd;
    }

    const mode = vds >= 0 ? 1 : -1;
    const ev = this.evaluateChannel(vgs, vds, vbs, false);
    const { gm, gds, gmbs, cdrain } = ev;
    this.lastVon = ev.von;
    const cd = mode * cdrain - cbd;
    this.state = { vgs, vds, vbs, vbd, mode, cd, cbs, cbd, gm, gds, gmbs, gbd, gbs };

    const vgd = vgs - vds;
    const ceqbs = type * (cbs - (gbs - gmin) * vbs);
    const ceqbd = type * (cbd - (gbd - gmin) * vbd);
    const xnrm = mode >= 0 ? 1 : 0;
    const xrev = 1 - xnrm;
    const cdreq = mode >= 0
      ? type * (cdrain - gds * vds - gm * vgs - gmbs * vbs)
      : -type * (cdrain + gds * vds - gm * vgd - gmbs * vbd);

    const bound = this.dcSweepStamp;
    if (bound?.ctx === ctx) {
      const { values, rhs, slots } = bound;
      if (nB >= 0) rhs[nB] += m * -(ceqbs + ceqbd);
      if (nD >= 0) rhs[nD] += m * (ceqbd - cdreq);
      if (nS >= 0) rhs[nS] += m * (cdreq + ceqbs);
      // Preserve the generic stamp's addition order, even when nodes alias.
      if (slots[0] >= 0) values[slots[0]] += m * (gbd + gbs);
      if (slots[1] >= 0) values[slots[1]] += m * (gds + gbd + xrev * (gm + gmbs));
      if (slots[2] >= 0) values[slots[2]] += m * (gds + gbs + xnrm * (gm + gmbs));
      if (slots[3] >= 0) values[slots[3]] += m * -gbd;
      if (slots[4] >= 0) values[slots[4]] += m * -gbs;
      if (slots[5] >= 0) values[slots[5]] += m * ((xnrm - xrev) * gm);
      if (slots[6] >= 0) values[slots[6]] += m * (-gbd + (xnrm - xrev) * gmbs);
      if (slots[7] >= 0) values[slots[7]] += m * (-gds - xnrm * (gm + gmbs));
      if (slots[8] >= 0) values[slots[8]] += m * (-(xnrm - xrev) * gm);
      if (slots[9] >= 0) values[slots[9]] += m * (-gbs - (xnrm - xrev) * gmbs);
      if (slots[10] >= 0) values[slots[10]] += m * (-gds - xrev * (gm + gmbs));
      return;
    }

    stampRhs(ctx, m, nB, -(ceqbs + ceqbd));
    stampRhs(ctx, m, nD, ceqbd - cdreq);
    stampRhs(ctx, m, nS, cdreq + ceqbs);

    stampConductance(ctx, m, nB, nB, gbd + gbs);
    stampConductance(ctx, m, nD, nD, gds + gbd + xrev * (gm + gmbs));
    stampConductance(ctx, m, nS, nS, gds + gbs + xnrm * (gm + gmbs));
    stampConductance(ctx, m, nB, nD, -gbd);
    stampConductance(ctx, m, nB, nS, -gbs);
    stampConductance(ctx, m, nD, nG, (xnrm - xrev) * gm);
    stampConductance(ctx, m, nD, nB, -gbd + (xnrm - xrev) * gmbs);
    stampConductance(ctx, m, nD, nS, -gds - xnrm * (gm + gmbs));
    stampConductance(ctx, m, nS, nG, -(xnrm - xrev) * gm);
    stampConductance(ctx, m, nS, nB, -gbs - (xnrm - xrev) * gmbs);
    stampConductance(ctx, m, nS, nD, -gds - xrev * (gm + gmbs));
  }

  /**
   * b1ld.c charge block at polarity-domain voltages: evaluator charges plus
   * junction charges and B1mosCap overlaps, with the transcapacitances scaled
   * by `ag0` (CKTag[0] in transient, 1 for capacitances).
   */
  private chargeFrame(vgs: number, vds: number, vbs: number, ag0: number): ChargeFrame {
    const setup = this.setup;
    const inst = this.instance;
    const vbd = vbs - vds;
    const vgd = vgs - vds;
    const vgb = vgs - vbs;
    const ev = this.evaluateChannel(vgs, vds, vbs, true);

    const phiB = setup.bulkJctPotential;
    const phiBSW = setup.sidewallJctPotential;
    const mj = setup.bulkJctBotGradingCoeff;
    const mjsw = setup.bulkJctSideGradingCoeff;
    const [qbs, capbs] = junctionCharge(
      vbs, setup.unitAreaJctCap * inst.AS, setup.unitLengthSidewallJctCap * inst.PS, phiB, phiBSW, mj, mjsw,
    );
    const [qbd, capbd] = junctionCharge(
      vbd, setup.unitAreaJctCap * inst.AD, setup.unitLengthSidewallJctCap * inst.PD, phiB, phiBSW, mj, mjsw,
    );
    // b1ld.c overlaps: drawn W, effective L.
    const gso = setup.cgso * inst.W;
    const gdo = setup.cgdo * inst.W;
    const gbo = setup.cgbo * this.effectiveLength;

    const f = this.frameScratch;
    if (vds >= 0) {
      const mos = mosCap(
        ag0, vgd, vgs, vgb, gdo, gso, gbo, capbd, capbs, ev.cggb, ev.cgdb, ev.cgsb,
        ev.cbgb, ev.cbdb, ev.cbsb, ev.cdgb, ev.cddb, ev.cdsb, ev.qg, ev.qb, ev.qd,
      );
      f.gcggb = mos.g1g; f.gcgdb = mos.g1x; f.gcgsb = mos.g1y;
      f.gcbgb = mos.b1g; f.gcbdb = mos.b1x; f.gcbsb = mos.b1y;
      f.gcdgb = mos.xg; f.gcddb = mos.xx; f.gcdsb = mos.xy;
      f.gcsgb = mos.yg; f.gcsdb = mos.yx; f.gcssb = mos.yy;
      f.qg = mos.qg;
      f.qd = mos.qx - qbd;
      f.qb = mos.qb + qbd + qbs;
    } else {
      // Inverse mode: the evaluator's drain is the physical source (b1ld.c
      // passes &cgsb for its cgdb slot, and so on).
      const mos = mosCap(
        ag0, vgs, vgd, vgb, gso, gdo, gbo, capbs, capbd, ev.cggb, ev.cgdb, ev.cgsb,
        ev.cbgb, ev.cbdb, ev.cbsb, ev.cdgb, ev.cddb, ev.cdsb, ev.qg, ev.qb, ev.qd,
      );
      f.gcggb = mos.g1g; f.gcgsb = mos.g1x; f.gcgdb = mos.g1y;
      f.gcbgb = mos.b1g; f.gcbsb = mos.b1x; f.gcbdb = mos.b1y;
      f.gcsgb = mos.xg; f.gcssb = mos.xx; f.gcsdb = mos.xy;
      f.gcdgb = mos.yg; f.gcdsb = mos.yx; f.gcddb = mos.yy;
      f.qg = mos.qg;
      f.qd = mos.qy - qbd;
      f.qb = mos.qb + qbd + qbs;
    }
    return f;
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const charges = this.charges;
    charges.begin(integration);
    const ag0 = charges.factor;
    // b1ld.c integrates the charges at the limited voltages of this load.
    const { vgs, vds, vbs } = this.state;
    const f = this.chargeFrame(vgs, vds, vbs, ag0);
    const vbd = vbs - vds;
    const vgb = vgs - vbs;
    const cqgate = charges.current(QG, f.qg);
    const cqbulk = charges.current(QB, f.qb);
    const cqdrn = charges.current(QD, f.qd);
    const type = this.setup.polarity;
    const ceqqg = type * (cqgate - f.gcggb * vgb + f.gcgdb * vbd + f.gcgsb * vbs);
    const ceqqb = type * (cqbulk - f.gcbgb * vgb + f.gcbdb * vbd + f.gcbsb * vbs);
    const ceqqd = type * (cqdrn - f.gcdgb * vgb + f.gcddb * vbd + f.gcdsb * vbs);
    this.stampChargeMatrix(f, (row, col, value) => ctx.stampG(row, col, value));
    const m = this.instance.M;
    const [nD, nG, nS, nB] = this.nodes;
    if (nG >= 0) ctx.stampB(nG, -m * ceqqg);
    if (nB >= 0) ctx.stampB(nB, -m * ceqqb);
    if (nD >= 0) ctx.stampB(nD, -m * ceqqd);
    if (nS >= 0) ctx.stampB(nS, m * (ceqqg + ceqqb + ceqqd));
  }

  /** The gc* entries of b1ld.c's y-matrix load, times the parallel multiplier. */
  private stampChargeMatrix(
    f: ChargeFrame,
    stamp: (row: number, col: number, value: number) => void,
  ): void {
    const k = this.instance.M;
    const [nD, nG, nS, nB] = this.nodes;
    const add = (row: number, col: number, value: number) => {
      if (row >= 0 && col >= 0) stamp(row, col, k * value);
    };
    add(nG, nG, f.gcggb);
    add(nB, nB, -f.gcbgb - f.gcbdb - f.gcbsb);
    add(nD, nD, f.gcddb);
    add(nS, nS, f.gcssb);
    add(nG, nB, -f.gcggb - f.gcgdb - f.gcgsb);
    add(nG, nD, f.gcgdb);
    add(nG, nS, f.gcgsb);
    add(nB, nG, f.gcbgb);
    add(nB, nD, f.gcbdb);
    add(nB, nS, f.gcbsb);
    add(nD, nG, f.gcdgb);
    add(nD, nB, -f.gcdgb - f.gcddb - f.gcdsb);
    add(nD, nS, f.gcdsb);
    add(nS, nG, f.gcsgb);
    add(nS, nB, -f.gcsgb - f.gcsdb - f.gcssb);
    add(nS, nD, f.gcsdb);
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    const type = this.setup.polarity;
    const m = this.instance.M;
    const [nD, nG, nS, nB] = this.nodes;
    stampChargeCurrent(ctx, nG, nS, type * m * this.charges.acceptedChargeCurrent(QG));
    stampChargeCurrent(ctx, nB, nS, type * m * this.charges.acceptedChargeCurrent(QB));
    stampChargeCurrent(ctx, nD, nS, type * m * this.charges.acceptedChargeCurrent(QD));
  }

  acceptTransientStep(ctx: StampContext): void {
    const [vgs, vds, vbs] = this.terminalVoltages(node => (node >= 0 ? ctx.getVoltage(node) : 0));
    const f = this.chargeFrame(vgs, vds, vbs, 0);
    this.charges.accept(QG, f.qg);
    this.charges.accept(QB, f.qb);
    this.charges.accept(QD, f.qd);
    this.charges.commit();
  }

  /** b1trunc.c: CKTterr on B1qb, B1qg and B1qd. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }

  resetTransient(): void {
    this.charges.reset();
  }

  /**
   * b1acld.c / b2acld.c capacitance matrix at the present solution. Uses the
   * temp-routine overlap capacitances (effective width), as ngspice's AC load
   * does. In inverse mode ngspice leaves the drain-row charge capacitances
   * (cdgb, cddb, cdsb) unset by the load and reads stale values; spice-ts uses
   * zero for them.
   */
  stampDynamic(ctx: StampContext): void {
    const [vgs, vds, vbs] = this.terminalVoltages(node => (node >= 0 ? ctx.getVoltage(node) : 0));
    const setup = this.setup;
    const inst = this.instance;
    const ev = this.evaluateChannel(vgs, vds, vbs, true);
    const vbd = vbs - vds;
    const phiB = setup.bulkJctPotential;
    const phiBSW = setup.sidewallJctPotential;
    const mj = setup.bulkJctBotGradingCoeff;
    const mjsw = setup.bulkJctSideGradingCoeff;
    const capbs = junctionCharge(
      vbs, setup.unitAreaJctCap * inst.AS, setup.unitLengthSidewallJctCap * inst.PS, phiB, phiBSW, mj, mjsw,
    )[1];
    const capbd = junctionCharge(
      vbd, setup.unitAreaJctCap * inst.AD, setup.unitLengthSidewallJctCap * inst.PD, phiB, phiBSW, mj, mjsw,
    )[1];
    let cggb: number; let cgdb: number; let cgsb: number;
    let cbgb: number; let cbdb: number; let cbsb: number;
    let cdgb: number; let cddb: number; let cdsb: number;
    if (vds >= 0) {
      ({ cggb, cgdb, cgsb, cbgb, cbdb, cbsb, cdgb, cddb, cdsb } = ev);
    } else {
      cggb = ev.cggb; cgsb = ev.cgdb; cgdb = ev.cgsb;
      cbgb = ev.cbgb; cbsb = ev.cbdb; cbdb = ev.cbsb;
      cdgb = 0; cddb = 0; cdsb = 0;
    }
    const { gd, gs, gb } = setup.acOverlap;
    const f = this.frameScratch;
    f.gcdgb = cdgb - gd;
    f.gcddb = cddb + capbd + gd;
    f.gcdsb = cdsb;
    f.gcsgb = -(cggb + cbgb + cdgb + gs);
    f.gcsdb = -(cgdb + cbdb + cddb);
    f.gcssb = capbs + gs - (cgsb + cbsb + cdsb);
    f.gcggb = cggb + gd + gs + gb;
    f.gcgdb = cgdb - gd;
    f.gcgsb = cgsb - gs;
    f.gcbgb = cbgb - gb;
    f.gcbdb = cbdb - capbd;
    f.gcbsb = cbsb - capbs;
    this.stampChargeMatrix(f, (row, col, value) => ctx.stampC(row, col, value));
  }

  stampAC(ctx: StampContext, _omega: number): void {
    this.stampDynamic(ctx);
  }
}

/**
 * b1moscap.c B1mosCap in the evaluator frame (x = evaluator drain, y = evaluator source):
 * equivalent conductances scaled by ag0 and total terminal charges with overlaps.
 */
function mosCap(
  ag0: number,
  vgx: number, vgy: number, vgb: number,
  overlapGX: number, overlapGY: number, overlapGB: number,
  capbx: number, capby: number,
  cggb: number, cgxb: number, cgyb: number,
  cbgb: number, cbxb: number, cbyb: number,
  cxgb: number, cxxb: number, cxyb: number,
  qgate: number, qbulk: number, qx: number,
) {
  const xg = (cxgb - overlapGX) * ag0;
  const xx = (cxxb + capbx + overlapGX) * ag0;
  const xy = cxyb * ag0;
  const yg = -(cggb + cbgb + cxgb + overlapGY) * ag0;
  const yx = -(cgxb + cbxb + cxxb) * ag0;
  const yy = (capby + overlapGY - (cgyb + cbyb + cxyb)) * ag0;
  const g1g = (cggb + overlapGX + overlapGY + overlapGB) * ag0;
  const g1x = (cgxb - overlapGX) * ag0;
  const g1y = (cgyb - overlapGY) * ag0;
  const b1g = (cbgb - overlapGB) * ag0;
  const b1x = (cbxb - capbx) * ag0;
  const b1y = (cbyb - capby) * ag0;
  const qgd = overlapGX * vgx;
  const qgs = overlapGY * vgy;
  const qgb = overlapGB * vgb;
  const qg = qgate + qgd + qgs + qgb;
  const qb = qbulk - qgb;
  const qxOut = qx - qgd;
  const qy = -(qg + qb + qxOut);
  return { xg, xx, xy, yg, yx, yy, g1g, g1x, g1y, b1g, b1x, b1y, qg, qb, qx: qxOut, qy };
}

/** Throw the shared fatal checks of b1temp.c / b2temp.c for an instance. */
export function assertClassicBsimGeometry(
  kind: string,
  deviceName: string,
  modelName: string,
  instance: ClassicBsimInstance,
  deltaL: number,
  deltaW: number,
): void {
  if (!(instance.L - deltaL * 1e-6 > 0)) {
    throw new InvalidCircuitError(
      `${kind}: mosfet ${deviceName}, model ${modelName}: Effective channel length <=0`,
    );
  }
  if (!(instance.W - deltaW * 1e-6 > 0)) {
    throw new InvalidCircuitError(
      `${kind}: mosfet ${deviceName}, model ${modelName}: Effective channel width <=0`,
    );
  }
}
