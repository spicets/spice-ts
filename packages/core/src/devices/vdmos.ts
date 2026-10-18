import type {
  ChargeIntegration, ChargeTruncation, DeviceModel, StampContext,
} from './device.js';
import { DEVICE_GMIN } from './device.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';
import type { VdmosModel } from './vdmos-model.js';
import { InvalidCircuitError } from '../errors.js';
import { fetlim, limvds, pnjlim, stepScale } from './devsup.js';

/**
 * VDMOS power MOSFET, ported from ngspice-47 src/spicelib/devices/vdmos:
 * vdmostemp.c (temperature update), vdmosload.c (Shichman-Hodges channel with
 * the logarithmic weak-inversion overdrive, MTRIODE, quasi saturation, the
 * DevCapVDMOS gate capacitances and the body diode with breakdown and
 * transit-time charge), vdmosacld.c (small signal) and vdmostrun.c.
 *
 * Nodes: [D, G, S, D', G', S', B'] where D'/G'/S' are the inner channel
 * terminals behind RD/RG/RS and B' the body diode anode behind RB; a prime
 * node equals its external node when the resistance is zero (vdmosset.c).
 * The drain-source shunt RDS sits between the external D and S, and the body
 * diode between B' and the external drain.
 *
 * Thermal instances append Tj, Tc and ground. Soft reverse recovery (VP
 * with TT) remains unsupported.
 */

// ngspice const.h
const CHARGE = 1.6021766208e-19;
const CONSTBOLTZ = 1.38064852e-23;
const CONSTKOVERQ = CONSTBOLTZ / CHARGE;
const CONSTCTOK = 273.15;
const REFTEMP = 27 + CONSTCTOK;
const CONSTROOT2 = Math.SQRT2;
const CONSTE = Math.E;

const D = 0;
const G = 1;
const S = 2;
const DP = 3;
const GP = 4;
const SP = 5;
const BP = 6;

/** Charge indices: gate-source, gate-drain (Meyer style, averaged) and body diode. */
const GATE_SOURCE = 0;
const GATE_DRAIN = 1;
const BODY_DIODE = 2;
/** [positive, negative] node slots of each charge, in charge-index order. */
const CHARGE_BRANCHES: ReadonlyArray<readonly [number, number]> = [[GP, SP], [GP, DP], [BP, D], [7, 9]];

export interface VdmosInstanceParams {
  /** Parallel multiplier (ngspice VDMOSm). */
  M: number;
  /** Instance temperature in Celsius (overrides the circuit temperature). */
  TEMP?: number;
  /** Offset from the circuit temperature in Celsius. */
  DTEMP: number;
}

/** vdmosnoi.c inputs, evaluated at the same bias/temperature as the AC stamp. */
export interface VdmosNoiseOperatingPoint {
  gm: number;
  gds: number;
  id: number;
  drainConductance: number;
  sourceConductance: number;
  kf: number;
  af: number;
  /** Tj / circuit temperature for active self heating, otherwise one. */
  temperatureRatio: number;
  temperatureKelvin: number;
}

/** Temperature-dependent instance values (vdmostemp.c VDMOStempUpdate). */
interface VdmosTemperatureState {
  temp: number;
  vt: number;
  beta: number;
  vth: number;
  ksubthres: number;
  drainResistance: number;
  qsResistance: number;
  gateConductance: number;
  sourceConductance: number;
  dsConductance: number;
  bodyConductance: number;
  satCur: number;
  vte: number;
  vcrit: number;
  jctCap: number;
  jctPot: number;
  gradingCoeff: number;
  depCap: number;
  f1: number;
  f2: number;
  f3: number;
  brkdwnV: number;
  transitTime: number;
}

export class VDMOS implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (VDMOStrunc: qgs, qgd, body diode charge). */
  readonly truncationCoversCharges = true;
  readonly integratesTransientCharge = true;
  readonly storesCharge: boolean;
  readonly modelWarnings: readonly string[];
  readonly instance: VdmosInstanceParams;
  private circuitTemperature = 27;
  private readonly thermal: boolean;
  private temp!: VdmosTemperatureState;
  /** ngspice CKTstate0 VDMOSvgs/VDMOSvds/VDIOvoltage of the previous load. */
  private lastVgs = 0;
  private lastVds = 0;
  private lastVd = 0;
  /** ngspice VDMOSvon, stored in the node polarity as vdmosload.c does. */
  private lastVon = 0;
  /** ngspice VDMOSdrainConductance: updated by every load, kept across loads. */
  private drainConductance = 0;
  /** The last stamp limited the body diode junction (ngspice CKTnoncon). */
  private limited = false;
  private readonly charges = new TransientChargeState(CHARGE_BRANCHES.length);
  private readonly capacitanceScratch = new Float64Array(CHARGE_BRANCHES.length);
  private readonly chargeScratch = new Float64Array(CHARGE_BRANCHES.length);

  constructor(
    readonly name: string,
    /** [D, G, S, D', G', S', B'] */
    readonly nodes: number[],
    readonly model: VdmosModel,
    instance: Partial<VdmosInstanceParams>,
    warnings: readonly string[] = [],
  ) {
    this.thermal = nodes.length === 9;
    if (nodes.length !== 7 && !this.thermal) throw new Error(`VDMOS '${name}' needs 7 or 9 node slots, got ${nodes.length}`);
    if (!this.thermal) nodes.push(-1, -1);
    nodes.push(-1);
    if (model.diode.vp !== 0 && model.diode.tt !== 0) {
      throw new InvalidCircuitError(
        `VDMOS '${name}': soft reverse recovery (model '${model.name}' VP with TT) is not implemented`,
      );
    }
    // vdmosset.c: with both TEMP and DTEMP given, ngspice-47 warns and drops
    // TEMP (VDMOStempGiven = FALSE), so the instance runs at circuit temp + DTEMP.
    const bothTemps = instance.TEMP !== undefined && instance.DTEMP !== undefined;
    this.instance = {
      M: instance.M ?? 1,
      TEMP: bothTemps ? undefined : instance.TEMP,
      DTEMP: instance.DTEMP ?? 0,
    };
    this.modelWarnings = bothTemps
      ? [...warnings, `${name}: temp and dtemp instance parameter given - using dtemp`]
      : warnings;
    const m = this.instance.M;
    if (model.rd > 0) this.drainConductance = m / model.rd;
    this.applyTemperature();
    this.storesCharge = model.cgs !== 0 || model.cgdmin !== 0 || model.cgdmax !== 0
      || model.diode.cjo !== 0 || model.diode.tt !== 0 || (this.thermal && model.cthj !== 0);
  }

  setTemperature(value: number): void {
    this.circuitTemperature = value;
    this.applyTemperature();
  }

  getTemperature(): number {
    return this.circuitTemperature;
  }

  /** vdmostemp.c VDMOStemp + VDMOStempUpdate, including absolute Tj in Celsius. */
  private applyTemperature(junctionTemperature?: number): void {
    const model = this.model;
    const diode = model.diode;
    const m = this.instance.M;
    const temp = junctionTemperature !== undefined ? junctionTemperature + CONSTCTOK : this.instance.TEMP !== undefined
      ? this.instance.TEMP + CONSTCTOK
      : this.circuitTemperature + CONSTCTOK + this.instance.DTEMP;
    const tnom = model.tnom;

    const fact1 = tnom / REFTEMP;
    const vtnom = tnom * CONSTKOVERQ;
    const kt1 = CONSTBOLTZ * tnom;
    const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
    const arg1Nom = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTBOLTZ * (REFTEMP + REFTEMP));
    const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1Nom);
    const xfc = Math.log(1 - diode.fc);
    const dt = temp - tnom;
    const ratio = temp / tnom;

    const beta = model.kp * m * Math.pow(ratio, model.mu);
    const vth = model.vth0 + model.tcvth * dt;
    const ksubthres = model.ksubthres * (1 + model.tksubthres1 * dt + model.tksubthres2 * dt * dt);
    const drainResistance = model.texp0Given
      ? model.rd / m * Math.pow(ratio, model.texp0)
      : model.rd / m * (1 + model.trd1 * dt + model.trd2 * dt * dt);
    const gateConductance = model.rg > 0
      ? m / model.rg / (1 + model.trg1 * dt + model.trg2 * dt * dt)
      : 0;
    const sourceConductance = model.rs > 0
      ? m / model.rs / (1 + model.trs1 * dt + model.trs2 * dt * dt)
      : 0;
    const qsResistance = model.qsGiven ? model.rq / m * Math.pow(ratio, model.texp1) : 0;
    // vdmosset.c: RDS shunt and RB body conductance are temperature independent
    // apart from the RB coefficients below.
    const dsConductance = model.rdsGiven && model.rds > 0 ? m / model.rds : 1e-15;

    const vt = temp * CONSTKOVERQ;
    const fact2 = temp / REFTEMP;
    const kt = temp * CONSTBOLTZ;
    const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
    const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTBOLTZ * (REFTEMP + REFTEMP));
    const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);

    // Body diode. Grading-coefficient temperature coefficients are not
    // settable in ngspice-47, so the factor is 1.
    const gradingCoeff = diode.m;
    const pbo = (diode.vj - pbfact1) / fact1;
    const gmaold = (diode.vj - pbo) / pbo;
    let jctCap = m * diode.cjo / (1 + gradingCoeff * (400e-6 * (tnom - REFTEMP) - gmaold));
    let jctPot = pbfact + fact2 * pbo;
    const gmanew = (jctPot - pbo) / pbo;
    jctCap *= 1 + gradingCoeff * (400e-6 * (temp - REFTEMP) - gmanew);

    const vte = diode.n * vt;
    const satArg1 = ((temp / tnom) - 1) * diode.eg / vte;
    const satArg2 = diode.xti / diode.n * Math.log(temp / tnom);
    const satCur = m * diode.is * Math.exp(satArg1 + satArg2);

    const f1 = jctPot * (1 - Math.exp((1 - gradingCoeff) * xfc)) / (1 - gradingCoeff);
    let depCap = diode.fc * jctPot;
    const vcrit = vte * Math.log(vte / (CONSTROOT2 * satCur));
    if (depCap > 2.5) {
      jctPot = 2.5 / diode.n;
      depCap = diode.n * jctPot;
    }

    let brkdwnV = 0;
    if (diode.bvGiven) {
      const tBreakdownVoltage = Math.abs(diode.bv);
      const cbv = diode.ibv;
      let xbv: number;
      if (cbv < satCur * tBreakdownVoltage / vt) {
        xbv = tBreakdownVoltage;
      } else {
        const tol = 1e-3 * cbv;
        xbv = tBreakdownVoltage - diode.nbv * vt * Math.log(1 + cbv / satCur);
        for (let iter = 0; iter < 25; iter++) {
          xbv = tBreakdownVoltage - diode.nbv * vt * Math.log(cbv / satCur + 1 - xbv / vt);
          const xcbv = satCur * (Math.exp((tBreakdownVoltage - xbv) / (diode.nbv * vt)) - 1 + xbv / vt);
          if (Math.abs(xcbv - cbv) <= tol) break;
        }
      }
      brkdwnV = xbv;
    }

    const rbFactor = 1 + diode.trb1 * dt + diode.trb2 * dt * dt;
    const bodyConductance = diode.rb > 0 ? m / diode.rb / rbFactor : 0;

    this.temp = {
      temp, vt, beta, vth, ksubthres, drainResistance, qsResistance,
      gateConductance, sourceConductance, dsConductance, bodyConductance,
      satCur, vte, vcrit, jctCap, jctPot, gradingCoeff, depCap, f1,
      f2: Math.exp((1 + gradingCoeff) * xfc),
      f3: 1 - diode.fc * (1 + gradingCoeff),
      brkdwnV,
      transitTime: diode.tt,
    };
  }

  /** Inner terminal voltages [vgs, vds] in the polarity domain. */
  private channelVoltages(voltage: (node: number) => number): [number, number] {
    const type = this.model.type;
    const vS = voltage(this.nodes[SP]);
    return [type * (voltage(this.nodes[GP]) - vS), type * (voltage(this.nodes[DP]) - vS)];
  }

  limitNewtonStep(previous: Float64Array, candidate: Float64Array): number {
    const read = (solution: Float64Array) => (node: number) => (node >= 0 ? solution[node] : 0);
    const [vgsOld, vdsOld] = this.channelVoltages(read(previous));
    const [vgsNew, vdsNew] = this.channelVoltages(read(candidate));
    const vgdOld = vgsOld - vdsOld;
    const vgdNew = vgsNew - vdsNew;
    const von = this.model.type * this.lastVon;
    // vdmosload.c limits vgs (vgd in inverse mode) with DEVfetlim and vds
    // with DEVlimvds. spice-ts limits by scaling the whole Newton step, as for
    // MOS6: each limited voltage contributes its own scale.
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
   * vdmosload.c channel block: drain current and derivatives in the polarity
   * domain for inner voltages vgs, vds (normal mode when vds >= 0).
   */
  evaluateChannel(vgs: number, vds: number): { mode: 1 | -1; cdrain: number; gm: number; gds: number } {
    const model = this.model;
    const t = this.temp;
    const mode: 1 | -1 = vds >= 0 ? 1 : -1;
    const vgd = vgs - vds;
    const von = t.vth * model.type;
    let vgst = (mode === 1 ? vgs : vgd) - von;
    const vdsat = Math.max(vgst, 0);
    const slope = t.ksubthres;
    const { lambda, theta, subshift: shift, mtriode: mtr } = model;
    const beta = t.beta;

    const vdss = vds * mtr * mode;
    const t0 = 1 + lambda * vds;
    const t1 = 1 + theta * vdsat;
    const betap = beta * t0 / t1;
    const dbetapdvgs = -beta * theta * t0 / (t1 * t1);
    const dbetapdvds = beta * lambda / t1;

    // vgst = slope * log(1 + exp(x)), dvgst/dvgs = exp(x) / (1 + exp(x)),
    // evaluated without overflowing exp for a large overdrive.
    const x = (vgst - shift) / slope;
    let dvgstdvgs: number;
    if (x > 0) {
      const e = Math.exp(-x);
      vgst = slope * (x + Math.log1p(e));
      dvgstdvgs = 1 / (1 + e);
    } else {
      const e = Math.exp(x);
      vgst = slope * Math.log1p(e);
      dvgstdvgs = e / (e + 1);
    }

    let cdrain: number;
    let gm: number;
    let gds: number;
    if (vgst <= vdss) {
      cdrain = betap * vgst * vgst * 0.5;
      gm = betap * vgst * dvgstdvgs + 0.5 * dbetapdvgs * vgst * vgst;
      gds = 0.5 * dbetapdvds * vgst * vgst;
    } else {
      cdrain = betap * vdss * (vgst - 0.5 * vdss);
      gm = betap * vdss * dvgstdvgs + vdss * dbetapdvgs * (vgst - 0.5 * vdss);
      gds = vdss * dbetapdvds * (vgst - 0.5 * vdss) + betap * mtr * (vgst - 0.5 * vdss) - 0.5 * vdss * betap * mtr;
    }
    return { mode, cdrain, gm, gds };
  }

  stamp(ctx: StampContext): void {
    this.stampLoad(ctx, false);
  }

  stampSmallSignal(ctx: StampContext): void {
    this.stampLoad(ctx, true);
  }

  private stampLoad(ctx: StampContext, smallSignal: boolean): void {
    if (this.thermal) this.applyTemperature(Math.max(-200, ctx.getVoltage(this.nodes[7])));
    const model = this.model;
    const type = model.type;
    const t = this.temp;
    const nodes = this.nodes;
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const g = (row: number, col: number, value: number) => {
      const r = nodes[row];
      const c = nodes[col];
      if (r >= 0 && c >= 0) ctx.stampG(r, c, value);
    };
    const b = (row: number, value: number) => {
      const r = nodes[row];
      if (r >= 0) ctx.stampB(r, value);
    };
    const gmin = ctx.gmin ?? DEVICE_GMIN;

    // ---- channel (limiting is applied to the Newton step, see limitNewtonStep)
    const [vgs, vds] = this.channelVoltages(voltage);
    const vgd = vgs - vds;
    const { mode, cdrain, gm, gds } = this.evaluateChannel(vgs, vds);
    this.lastVon = t.vth;
    this.lastVgs = vgs;
    this.lastVds = vds;

    // Quasi saturation (vdmosload.c): RD depends on the external drain-source voltage.
    const rd0T = t.drainResistance;
    if (model.qsGiven && mode === 1) {
      const vdsn = type * (voltage(nodes[D]) - voltage(nodes[S]));
      const rd = rd0T + t.qsResistance * (vdsn / (vdsn + Math.abs(model.vq)));
      this.drainConductance = rd > 0 ? 1 / rd + gmin : 1 / rd0T;
    } else if (rd0T > 0) {
      this.drainConductance = 1 / rd0T;
    }

    const xnrm = mode === 1 ? 1 : 0;
    const xrev = 1 - xnrm;
    const cdreq = mode === 1
      ? type * (cdrain - gds * vds - gm * vgs)
      : -type * (cdrain - gds * (-vds) - gm * vgd);

    b(DP, -cdreq);
    b(SP, cdreq);

    const gdrain = this.drainConductance;
    const gsource = t.sourceConductance;
    const ggate = t.gateConductance;
    const gshunt = t.dsConductance;
    g(D, D, gdrain + gshunt);
    g(G, G, ggate);
    g(S, S, gsource + gshunt);
    g(DP, DP, gdrain + gds + xrev * gm);
    g(SP, SP, gsource + gds + xnrm * gm);
    g(GP, GP, ggate);
    g(G, GP, -ggate);
    g(D, DP, -gdrain);
    g(GP, G, -ggate);
    g(S, SP, -gsource);
    g(DP, D, -gdrain);
    g(DP, GP, (xnrm - xrev) * gm);
    g(DP, SP, -gds - xnrm * gm);
    g(SP, GP, -(xnrm - xrev) * gm);
    g(SP, S, -gsource);
    g(SP, DP, -gds - xrev * gm);
    g(D, S, -gshunt);
    g(S, D, -gshunt);

    // ---- body diode (anode B', cathode D in the n-channel polarity)
    const vdRaw = type * (voltage(nodes[BP]) - voltage(nodes[D]));
    const vd = this.limitBodyDiode(vdRaw);
    this.limited = vd !== vdRaw;
    this.lastVd = vd;
    const { cd: cdb, gd: gdb } = this.bodyDiodeCurrent(vd);
    const cd = cdb + gmin * vd;
    const gd = gdb + gmin;
    const cdeq = type * (cd - gd * vd);
    b(D, cdeq);
    b(BP, -cdeq);
    const gbpr = t.bodyConductance;
    g(S, S, gbpr);
    g(D, D, gd);
    g(BP, BP, gd + gbpr);
    g(S, BP, -gbpr);
    g(D, BP, -gd);
    g(BP, S, -gbpr);
    g(BP, D, -gd);
    if (this.thermal) {
      if (smallSignal) this.stampThermalSmallSignal(ctx, vgs, vds);
      else this.stampThermal(ctx);
    }
  }

  /** ngspice-47 vdmosacld.c uses the channel thermal couplings, not the
   * DC power Jacobian (which also includes series resistors and the diode).
   * Its thermal row has the opposite power-derivative sign to vdmosload.c.
   */
  private stampThermalSmallSignal(ctx: StampContext, vgs: number, vds: number): void {
    const model = this.model;
    const t = this.temp;
    const { mode, cdrain, gm, gds } = this.evaluateChannel(vgs, vds);
    const overdrive = (mode === 1 ? vgs : vgs - vds) - t.vth * model.type;
    const x = (overdrive - model.subshift) / t.ksubthres;
    const vgst = t.ksubthres * (Math.max(x, 0) + Math.log1p(Math.exp(-Math.abs(x))));
    const vdss = vds * model.mtriode * mode;
    const t0 = 1 + model.lambda * vds;
    const t1 = 1 + model.theta * Math.max(overdrive, 0);
    const betap = t.beta * t0 / t1;
    // vdmosload.c deliberately uses this derivative of the overdrive, even
    // in weak inversion; differentiating our DC equations is not equivalent.
    const dvgst = model.type * model.tcvth;
    const dbeta = t.beta * model.mu / t.temp;
    const dbetap = t0 * (t1 * dbeta - t.beta * model.theta * (vgst > 0 ? dvgst : 0)) / (t1 * t1);
    const gmT = vgst <= vdss
      ? 0.5 * dbetap * vgst * vgst + betap * vgst * dvgst
      : vdss * (dbetap * vgst + betap * dvgst) - 0.5 * dbetap * vdss * vdss;
    const g = (row: number, col: number, value: number) => {
      if (this.nodes[row] >= 0 && this.nodes[col] >= 0) ctx.stampG(this.nodes[row], this.nodes[col], value);
    };
    const channelVds = mode * vds;
    const gTg = mode * model.type * gm * channelVds;
    const gTd = mode * model.type * (gds * channelVds + cdrain);
    const gjc = this.instance.M / model.rthjc;
    const gca = this.instance.M / model.rthca;
    g(DP, 7, mode * model.type * gmT);
    g(SP, 7, -mode * model.type * gmT);
    g(7, GP, gTg);
    g(7, DP, gTd);
    // vdmosacld.c sums the already-negated couplings in inverse mode.
    g(7, SP, -mode * (gTg + gTd));
    g(7, 7, mode * gmT * channelVds + gjc);
    g(7, 8, -gjc);
    g(8, 7, -gjc);
    g(8, 8, gjc + gca);
    // vdmosacld.c reverses cTt in inverse mode. stampDynamic adds the
    // positive CTHJ, so correct that AC-only entry here, never in TRAN.
    if (mode < 0 && this.nodes[7] >= 0) ctx.stampC(this.nodes[7], this.nodes[7], -2 * this.instance.M * model.cthj);
    // cgT and cdT in vdmosacld.c remain zero in ngspice-47. CTHJ is
    // stamped by stampDynamic alongside the electrical capacitances.
  }

  /** vdmosload.c: channel, RD/RS, diode and RB dissipate into Tj.
   * Temperature derivatives use symmetric differences of the same electrical
   * equations, avoiding a second, divergent temperature model.
   */
  private stampThermal(ctx: StampContext): void {
    const nodes = this.nodes;
    const tj = nodes[7];
    const tc = nodes[8];
    const readVoltage = (node: number) => ctx.getVoltage(node);
    const voltage = (slot: number) => nodes[slot] < 0 ? 0 : readVoltage(nodes[slot]);
    const temperature = Math.max(-200, voltage(7));
    const branchSlots = [[DP, SP], [D, DP], [S, SP], [BP, D], [S, BP]];
    const currents = () => {
      const t = this.temp;
      const [vgs, vds] = this.channelVoltages(n => n < 0 ? 0 : readVoltage(n));
      const ch = this.evaluateChannel(vgs, vds);
      let rd = t.drainResistance;
      if (this.model.qsGiven && ch.mode === 1) {
        const v = this.model.type * (voltage(D) - voltage(S));
        rd += t.qsResistance * v / (v + Math.abs(this.model.vq));
      }
      return [this.model.type * ch.mode * ch.cdrain,
        rd > 0 ? (voltage(D) - voltage(DP)) / rd : 0,
        t.sourceConductance * (voltage(S) - voltage(SP)),
        this.model.type * this.bodyDiodeCurrent(this.model.type * (voltage(BP) - voltage(D))).cd,
        t.bodyConductance * (voltage(S) - voltage(BP))];
    };
    const current = currents();
    const h = 1e-3;
    this.applyTemperature(temperature + h);
    const plus = currents();
    this.applyTemperature(temperature - h);
    const minus = currents();
    this.applyTemperature(temperature);
    let power = 0;
    let dpdt = 0;
    for (let i = 0; i < branchSlots.length; i++) {
      const [p, n] = branchSlots[i];
      const v = voltage(p) - voltage(n);
      const derivative = (plus[i] - minus[i]) / (2 * h);
      power += current[i] * v;
      dpdt += derivative * v;
      for (const [slot, sign] of [[p, 1], [n, -1]]) {
        if (nodes[slot] < 0) continue;
        if (tj >= 0) ctx.stampG(nodes[slot], tj, sign * derivative);
        ctx.stampB(nodes[slot], sign * derivative * temperature);
      }
    }
    // Differentiate I * V analytically, using the electrical load's gm/gds
    // (as in vdmosload.c), not fourteen perturbed channel/diode evaluations
    // per load. Stamp by slot so aliased external/intrinsic nodes accumulate.
    let rhs = power - dpdt * temperature;
    const powerDerivative = (slot: number, derivative: number) => {
      const node = nodes[slot];
      if (node < 0) return;
      if (tj >= 0) ctx.stampG(tj, node, -derivative);
      rhs -= derivative * ctx.getVoltage(node);
    };
    const [vgs, vds] = this.channelVoltages(n => n < 0 ? 0 : readVoltage(n));
    const channel = this.evaluateChannel(vgs, vds);
    const channelVoltage = voltage(DP) - voltage(SP);
    powerDerivative(DP, current[0] + channelVoltage * (channel.gds + (channel.mode === -1 ? channel.gm : 0)));
    powerDerivative(GP, channelVoltage * channel.mode * channel.gm);
    powerDerivative(SP, -current[0] - channelVoltage * (channel.gds + (channel.mode === 1 ? channel.gm : 0)));
    for (const i of [1, 2, 4]) {
      const [p, n] = branchSlots[i];
      powerDerivative(p, 2 * current[i]);
      powerDerivative(n, -2 * current[i]);
    }
    const diodeVoltage = voltage(BP) - voltage(D);
    const diodeDerivative = current[3] + diodeVoltage * this.bodyDiodeCurrent(this.model.type * diodeVoltage).gd;
    powerDerivative(BP, diodeDerivative);
    powerDerivative(D, -diodeDerivative);
    if (this.model.qsGiven && channel.mode === 1) {
      const v = this.model.type * (voltage(D) - voltage(S));
      const denominator = v + Math.abs(this.model.vq);
      const drdv = this.model.type * this.temp.qsResistance * Math.abs(this.model.vq) / (denominator * denominator);
      const derivative = -current[1] * current[1] * drdv;
      powerDerivative(D, derivative);
      powerDerivative(S, -derivative);
    }
    const gjc = this.instance.M / this.model.rthjc;
    const gca = this.instance.M / this.model.rthca;
    if (tj >= 0) {
      ctx.stampG(tj, tj, gjc - dpdt);
      if (tc >= 0) ctx.stampG(tj, tc, -gjc);
      ctx.stampB(tj, rhs);
    }
    if (tc >= 0) {
      ctx.stampG(tc, tc, gjc + gca);
      if (tj >= 0) ctx.stampG(tc, tj, -gjc);
      ctx.stampB(tc, gca * (this.instance.TEMP ?? this.circuitTemperature));
    }
  }

  /** vdmosload.c body diode junction limiting against the previous load. */
  private limitBodyDiode(vd: number): number {
    const t = this.temp;
    const vtebrk = this.model.diode.nbv * t.vt;
    const vbrknp = t.brkdwnV;
    if (this.model.diode.bvGiven && vd < Math.min(0, -vbrknp + 10 * vtebrk)) {
      const limited = pnjlim(-(vd + vbrknp), -(this.lastVd + vbrknp), vtebrk, t.vcrit);
      return -(limited + vbrknp);
    }
    return pnjlim(vd, this.lastVd, t.vte, t.vcrit);
  }

  /** vdmosload.c body diode DC current (without gmin) and conductance. */
  private bodyDiodeCurrent(vd: number): { cd: number; gd: number } {
    const t = this.temp;
    const vte = t.vte;
    if (vd >= -3 * vte) {
      const evd = Math.exp(vd / vte);
      return { cd: t.satCur * (evd - 1), gd: t.satCur * evd / vte };
    }
    if (!this.model.diode.bvGiven || vd >= -t.brkdwnV) {
      const arg = 3 * vte / (vd * CONSTE);
      const arg3 = arg * arg * arg;
      return { cd: -t.satCur * (1 + arg3), gd: t.satCur * 3 * arg / vd };
    }
    const vtebrk = this.model.diode.nbv * t.vt;
    const evrev = Math.exp(-(t.brkdwnV + vd) / vtebrk);
    return { cd: -t.satCur * evrev, gd: t.satCur * evrev / vtebrk };
  }

  /** vdmosload.c body diode depletion + diffusion charge and capacitance (polarity domain). */
  private bodyDiodeCharge(vd: number): { charge: number; capacitance: number } {
    const t = this.temp;
    const czero = t.jctCap;
    let deplcharge: number;
    let deplcap: number;
    if (vd < t.depCap) {
      const arg = 1 - vd / t.jctPot;
      const sarg = Math.exp(-t.gradingCoeff * Math.log(arg));
      deplcharge = t.jctPot * czero * (1 - arg * sarg) / (1 - t.gradingCoeff);
      deplcap = czero * sarg;
    } else {
      const czof2 = czero / t.f2;
      deplcharge = czero * t.f1 + czof2 * (t.f3 * (vd - t.depCap)
        + (t.gradingCoeff / (t.jctPot + t.jctPot)) * (vd * vd - t.depCap * t.depCap));
      deplcap = czof2 * (t.f3 + t.gradingCoeff * vd / t.jctPot);
    }
    if (t.transitTime === 0) return { charge: deplcharge, capacitance: deplcap };
    const { cd, gd } = this.bodyDiodeCurrent(vd);
    return { charge: t.transitTime * cd + deplcharge, capacitance: t.transitTime * gd + deplcap };
  }

  /** DevCapVDMOS: the full (not halved) gate-drain capacitance at polarity-domain vgd. */
  private gateDrainCapacitance(vgd: number): number {
    const m = this.instance.M;
    const cgdmin = m * this.model.cgdmin;
    const cgdmax = m * this.model.cgdmax;
    const a = this.model.a;
    const s = (cgdmax - cgdmin) / (1 + Math.PI / 2);
    const y = cgdmax - s;
    return vgd > 0 ? s * Math.tanh(a * vgd) + y : s * Math.atan(a * vgd) + y;
  }

  /**
   * Node-domain capacitance of every charge at the present solution, and the
   * exact body diode charge (scaled by the polarity so q and C refer to the
   * node-domain branch voltage). The gate entries are the full capacitances;
   * TransientChargeState averages them with the accepted values, which is
   * vdmosload.c's capgs/capgd = state0 + state1 halves.
   */
  private evaluateCharges(ctx: StampContext, capacitances: Float64Array, charges: Float64Array): void {
    const voltage = (node: number) => (node >= 0 ? ctx.getVoltage(node) : 0);
    const type = this.model.type;
    const [vgs, vds] = this.channelVoltages(voltage);
    capacitances[GATE_SOURCE] = this.instance.M * this.model.cgs;
    capacitances[GATE_DRAIN] = this.gateDrainCapacitance(vgs - vds);
    const vd = type * (voltage(this.nodes[BP]) - voltage(this.nodes[D]));
    const diode = this.bodyDiodeCharge(vd);
    capacitances[BODY_DIODE] = diode.capacitance;
    charges[BODY_DIODE] = type * diode.charge;
    capacitances[3] = this.thermal ? this.instance.M * this.model.cthj : 0;
    charges[3] = capacitances[3] * (this.thermal ? ctx.getVoltage(this.nodes[7]) : 0);
  }

  stampDynamic(ctx: StampContext): void {
    const capacitances = this.capacitanceScratch;
    this.evaluateCharges(ctx, capacitances, this.chargeScratch);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      stampCapacitance(ctx, this.nodes[p], this.nodes[n], capacitances[index]);
    }
  }

  stampAC(ctx: StampContext, _omega: number): void {
    this.stampDynamic(ctx);
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const charges = this.charges;
    const capacitances = this.capacitanceScratch;
    const exact = this.chargeScratch;
    this.evaluateCharges(ctx, capacitances, exact);
    charges.begin(integration);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      const positive = this.nodes[p];
      const negative = this.nodes[n];
      if (positive === negative) continue;
      const voltage = branchVoltage(ctx, positive, negative);
      const capacitance = capacitances[index];
      if (index === BODY_DIODE || index === 3) {
        stampChargeBranch(
          ctx, positive, negative, charges.current(index, exact[index]),
          charges.factor * capacitance, voltage,
        );
      } else {
        const charge = charges.incrementalCharge(index, voltage, capacitance, true);
        const effective = charges.factor * charges.incrementalCapacitance(index, capacitance, true);
        stampChargeBranch(ctx, positive, negative, charges.current(index, charge), effective, voltage);
      }
    }
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      if (this.nodes[p] === this.nodes[n]) continue;
      stampChargeCurrent(ctx, this.nodes[p], this.nodes[n], this.charges.acceptedChargeCurrent(index));
    }
  }

  acceptTransientStep(ctx: StampContext): void {
    const charges = this.charges;
    const capacitances = this.capacitanceScratch;
    const exact = this.chargeScratch;
    this.evaluateCharges(ctx, capacitances, exact);
    for (let index = 0; index < CHARGE_BRANCHES.length; index++) {
      const [p, n] = CHARGE_BRANCHES[index];
      const voltage = branchVoltage(ctx, this.nodes[p], this.nodes[n]);
      const capacitance = capacitances[index];
      const charge = index === BODY_DIODE || index === 3
        ? exact[index]
        : charges.incrementalCharge(index, voltage, capacitance, true);
      charges.accept(index, charge, voltage, capacitance);
    }
    charges.commit();
  }

  resetTransient(): void {
    this.charges.reset();
  }

  /** vdmostrun.c: qgs, qgd and the body diode charge. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }

  get selfHeating(): boolean {
    return this.thermal;
  }

  /** Read-only noise seam; does not change the electrical operating point. */
  noiseOperatingPoint(solution: Float64Array): VdmosNoiseOperatingPoint {
    const voltage = (node: number) => node < 0 ? 0 : solution[node];
    const [vgs, vds] = this.channelVoltages(voltage);
    const { mode, cdrain, gm, gds } = this.evaluateChannel(vgs, vds);
    const ambient = this.circuitTemperature + CONSTCTOK;
    // Non-self-heated instances use CKTtemp in NevalSrc, even with TEMP/DTEMP.
    const temperatureRatio = this.thermal ? this.temp.temp / ambient : 1;
    return {
      gm, gds, id: mode * cdrain,
      drainConductance: this.drainConductance,
      sourceConductance: this.temp.sourceConductance,
      kf: this.model.kf, af: this.model.af,
      temperatureRatio, temperatureKelvin: ambient * temperatureRatio,
    };
  }

  /** Channel state of the last load, for diagnostics and tests. */
  get operatingPoint(): { vgs: number; vds: number; vd: number } {
    return { vgs: this.lastVgs, vds: this.lastVds, vd: this.lastVd };
  }
}

function branchVoltage(ctx: StampContext, positive: number, negative: number): number {
  return (positive >= 0 ? ctx.getVoltage(positive) : 0)
    - (negative >= 0 ? ctx.getVoltage(negative) : 0);
}

/** Stamp a two-terminal capacitance (zero values too, so the sparsity pattern is stable). */
function stampCapacitance(ctx: StampContext, n1: number, n2: number, value: number): void {
  if (n1 === n2) return;
  if (n1 >= 0) {
    ctx.stampC(n1, n1, value);
    if (n2 >= 0) ctx.stampC(n1, n2, -value);
  }
  if (n2 >= 0) {
    ctx.stampC(n2, n2, value);
    if (n1 >= 0) ctx.stampC(n2, n1, -value);
  }
}
