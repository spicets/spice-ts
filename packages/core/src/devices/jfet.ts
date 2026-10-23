import { UnsupportedModelParameterError } from '../errors.js';
import type {
  ChargeIntegration, ChargeTruncation, DeviceModel, StampContext,
} from './device.js';
import { DEVICE_GMIN } from './device.js';
import type { JFETInstanceParams } from '../parser/jfet-parser.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';

export interface JFETParams {
  TNOM: number;
  N: number;
  EG: number;
  XTI: number;
  TCV: number;
  VTOTC: number;
  BEX: number;
  BETATCE: number;
  /** Nominal Sydney coefficient (not recomputed from temperature-adjusted PB/VTO). */
  bFactor?: number;
  LEVEL: number;
  VTO: number;
  BETA: number;
  LAMBDA: number;
  RD: number;
  RS: number;
  CGS: number;
  CGD: number;
  PB: number;
  IS: number;
  B: number;
  FC: number;
  KF: number;
  AF: number;
  DELTA: number;
  /** ngspice-47 warns that THETA is unrecognized and ignores it. */
  THETA: number;
}

export const NJF_LEVEL1_PARAMETERS = new Set<keyof JFETParams>([
  'LEVEL', 'VTO', 'BETA', 'LAMBDA', 'RD', 'RS', 'CGS', 'CGD',
  'PB', 'IS', 'B', 'FC', 'KF', 'AF', 'TNOM', 'N', 'EG', 'XTI', 'TCV', 'VTOTC', 'BEX', 'BETATCE',
]);

export const NJF_LEVEL2_PARAMETERS = new Set<keyof JFETParams>([
  'LEVEL', 'VTO', 'BETA', 'LAMBDA', 'DELTA', 'THETA', 'RD', 'RS',
  'CGS', 'CGD', 'PB', 'IS', 'FC', 'KF', 'AF', 'TNOM', 'N',
]);

const K_OVER_Q = 1.38064852e-23 / 1.6021766208e-19;
const REFERENCE_K = 300.15;

export interface JFETTemperatureEnvironment {
  temperatureC?: number;
  nominalTemperatureC?: number;
}

/** ngspice a80f6e3e95d51534905b1f23410a951802666656
 * jfettemp.c:JFETtemp; jfet2temp.c:JFET2temp; psmodel.h:NVT/VBI.
 * Resolve once per instance, before AREA/M. RD/RS remain nominal.
 */
function applyTemperature(p: JFETParams, card: Record<string, number>, temperatureC: number): void {
  const temperature = temperatureC + 273.15;
  const nominal = p.TNOM + 273.15;
  if (!Number.isFinite(temperature) || temperature <= 0 || !Number.isFinite(nominal) || nominal <= 0) {
    throw new Error('JFET TEMP and TNOM must be finite and above absolute zero');
  }
  p.bFactor = (1 - p.B) / (p.PB - p.VTO);
  p.FC = Math.min(p.FC, 0.95);
  const correction = (kelvin: number): number => {
    const gap = 1.16 - 7.02e-4 * kelvin * kelvin / (kelvin + 1108);
    return -2 * K_OVER_Q * kelvin * (1.5 * Math.log(kelvin / REFERENCE_K)
      + (-gap / (2 * kelvin) + 1.1150877 / (2 * REFERENCE_K)) / K_OVER_Q);
  };
  const pbo = (p.PB - correction(nominal)) / (nominal / REFERENCE_K);
  const oldGamma = (p.PB - pbo) / pbo;
  p.PB = temperature / REFERENCE_K * pbo + correction(temperature);
  const newGamma = (p.PB - pbo) / pbo;
  const capFactor = (1 + 0.5 * (4e-4 * (temperature - REFERENCE_K) - newGamma))
    / (1 + 0.5 * (4e-4 * (nominal - REFERENCE_K) - oldGamma));
  p.CGS *= capFactor;
  p.CGD *= capFactor;
  const ratio = temperature / nominal;
  p.IS *= Math.exp((ratio - 1) * (p.LEVEL === 1 ? p.EG / p.N : 1.11) / (temperature * K_OVER_Q));
  if (p.LEVEL === 1) {
    // XTI's setup default is 3, but ngspice applies it only when explicitly given.
    if (card.XTI !== undefined) p.IS *= Math.pow(ratio, p.XTI);
    p.VTO += (card.VTOTC !== undefined ? p.VTOTC : -p.TCV) * (temperature - nominal);
    p.BETA *= card.BETATCE !== undefined
      ? Math.pow(1.01, p.BETATCE * (temperature - nominal)) : Math.pow(ratio, p.BEX);
  }
}

export function resolveNJFETParams(params: Record<string, number>): JFETParams {
  const level = params.LEVEL ?? 1;
  if (level !== 1 && level !== 2) throw new Error(`Unsupported NJF model level: ${level}`);

  const supported = level === 1 ? NJF_LEVEL1_PARAMETERS : NJF_LEVEL2_PARAMETERS;
  for (const name of Object.keys(params)) {
    if (!supported.has(name as keyof JFETParams)) {
      throw new UnsupportedModelParameterError('', name,
        `Unsupported NJF level-${level} model parameter: '${name}'`, { model: `JFET${level}` });
    }
  }

  const resolved: JFETParams = {
    TNOM: params.TNOM ?? 27,
    N: params.N ?? 1,
    EG: params.EG ?? 1.11,
    XTI: params.XTI ?? 3,
    TCV: params.TCV ?? 0,
    VTOTC: params.VTOTC ?? 0,
    BEX: params.BEX ?? 0,
    BETATCE: params.BETATCE ?? 0,
    LEVEL: level,
    VTO: params.VTO ?? -2,
    BETA: params.BETA ?? 1e-4,
    LAMBDA: params.LAMBDA ?? 0,
    RD: params.RD ?? 0,
    RS: params.RS ?? 0,
    CGS: params.CGS ?? 0,
    CGD: params.CGD ?? 0,
    PB: params.PB ?? 1,
    IS: params.IS ?? 1e-14,
    B: params.B ?? 1,
    FC: params.FC ?? 0.5,
    KF: params.KF ?? 0,
    AF: params.AF ?? 1,
    DELTA: params.DELTA ?? 0,
    THETA: params.THETA ?? 0,
  };

  if (resolved.BETA < 0 || resolved.RD < 0 || resolved.RS < 0
    || resolved.CGS < 0 || resolved.CGD < 0 || resolved.PB <= 0
    || resolved.IS <= 0 || resolved.FC <= 0 || resolved.FC >= 1
    || resolved.DELTA < 0 || !Number.isFinite(resolved.N) || resolved.N <= 0) {
    throw new Error(`Invalid NJF level-${level} model parameter value`);
  }
  return resolved;
}

export class JFET implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  readonly initializesOperatingPoint = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (JFETtrunc: qgs, qgd). */
  readonly truncationCoversCharges = true;
  readonly params: JFETParams;
  private readonly multiplicity: number;
  private readonly thermalVoltage: number;
  /** Gate charges qgd/qgs integrated as ngspice jfetload.c (NIintegrate) when CGD or CGS is set. */
  readonly integratesTransientCharge: boolean;
  readonly storesCharge: boolean;
  private readonly charges = new TransientChargeState(2);
  private readonly junction = { charge: 0, capacitance: 0 };

  /**
   * @param polarity - +1 for NJF, -1 for PJF. As in ngspice jfetload.c and
   *   jfet2load.c (`type`), every branch voltage is multiplied by the polarity
   *   before the n-channel equations and every current/charge by it after.
   */
  constructor(
    readonly name: string,
    readonly nodes: number[],
    params: Record<string, number>,
    readonly polarity: 1 | -1 = 1,
    private readonly instance: JFETInstanceParams = {},
    environment: JFETTemperatureEnvironment = {},
  ) {
    this.params = resolveNJFETParams(params);
    this.params.TNOM = params.TNOM ?? environment.nominalTemperatureC ?? 27;
    const temperatureC = instance.TEMP ?? environment.temperatureC ?? 27;
    applyTemperature(this.params, params, temperatureC);
    this.thermalVoltage = (temperatureC + 273.15) * K_OVER_Q * this.params.N;
    const area = instance.AREA ?? 1;
    this.multiplicity = instance.M ?? 1;
    if (!Number.isFinite(area) || area <= 0
      || !Number.isFinite(this.multiplicity) || this.multiplicity <= 0) {
      throw new Error('JFET AREA and M must be finite and positive');
    }
    // ngspice jfetload/jfet2load: AREA scales intrinsic currents/charges;
    // M multiplies the complete device stamp, including junction gmin.
    const scale = area * this.multiplicity;
    for (const key of ['BETA', 'IS', 'CGS', 'CGD'] as const) this.params[key] *= scale;
    // PSids uses DELTA / AREA; applying M to BETA also requires undoing it
    // in the heating coefficient so independent parallel copies stay independent.
    this.params.DELTA /= scale;
    this.storesCharge = this.params.CGS !== 0 || this.params.CGD !== 0;
    this.integratesTransientCharge = this.storesCharge;
  }

  stamp(ctx: StampContext): void {
    let nD = this.nodes[0];
    const nG = this.nodes[1];
    let nS = this.nodes[2];
    const p = this.polarity;
    // ngspice-47 jfetload/jfet2load MODEINITJCT/MODEINITFIX: a
    // device-local bias, not a global node seed. IC is ignored for DC.
    const initializing = ctx.operatingPointPhase === 'junction'
      || (ctx.operatingPointPhase === 'fixed' && this.instance.OFF);
    const vD = initializing ? 0 : p * (nD >= 0 ? ctx.getVoltage(nD) : 0);
    const vG = initializing ? (this.instance.OFF ? 0 : -1) : p * (nG >= 0 ? ctx.getVoltage(nG) : 0);
    const vS = initializing ? 0 : p * (nS >= 0 ? ctx.getVoltage(nS) : 0);

    this.stampGateJunction(ctx, nG, this.nodes[0], vG - vD);
    this.stampGateJunction(ctx, nG, this.nodes[2], vG - vS);

    let vGS = vG - vS;
    let vDS = vD - vS;
    if (vDS < 0) {
      [nD, nS] = [nS, nD];
      vGS -= vDS;
      vDS = -vDS;
    }

    const { current, gm, gds } = channelCurrent(vGS, vDS, this.params);
    const ieq = p * (current - gm * vGS - gds * vDS);

    if (nD >= 0) {
      if (nG >= 0) ctx.stampG(nD, nG, gm);
      ctx.stampG(nD, nD, gds);
      if (nS >= 0) ctx.stampG(nD, nS, -(gm + gds));
      ctx.stampB(nD, -ieq);
    }
    if (nS >= 0) {
      if (nG >= 0) ctx.stampG(nS, nG, -gm);
      if (nD >= 0) ctx.stampG(nS, nD, -gds);
      ctx.stampG(nS, nS, gm + gds);
      ctx.stampB(nS, ieq);
    }
  }

  stampDynamic(ctx: StampContext): void {
    const [nD, nG, nS] = this.nodes;
    const p = this.polarity;
    const vD = p * (nD >= 0 ? ctx.getVoltage(nD) : 0);
    const vG = p * (nG >= 0 ? ctx.getVoltage(nG) : 0);
    const vS = p * (nS >= 0 ? ctx.getVoltage(nS) : 0);
    this.stampJunctionCapacitance(ctx, nG, nD, vG - vD, this.params.CGD);
    this.stampJunctionCapacitance(ctx, nG, nS, vG - vS, this.params.CGS);
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const [nD, nG, nS] = this.nodes;
    const charges = this.charges;
    charges.begin(integration);
    this.stampGateCharge(ctx, GATE_DRAIN, nG, nD, this.params.CGD);
    this.stampGateCharge(ctx, GATE_SOURCE, nG, nS, this.params.CGS);
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    const [nD, nG, nS] = this.nodes;
    stampChargeCurrent(ctx, nG, nD, this.charges.acceptedChargeCurrent(GATE_DRAIN));
    stampChargeCurrent(ctx, nG, nS, this.charges.acceptedChargeCurrent(GATE_SOURCE));
  }

  acceptTransientStep(ctx: StampContext): void {
    if (!this.integratesTransientCharge) return;
    const [nD, nG, nS] = this.nodes;
    const vG = nG >= 0 ? ctx.getVoltage(nG) : 0;
    // jfetic/jfet2ic fill unspecified ICs from external nodes. With UIC,
    // jfetload/jfet2load initialize qgs/qgd from those local voltages.
    const vDS = ctx.initialUIC && this.instance.ICVDS !== undefined
      ? this.instance.ICVDS
      : (nD >= 0 ? ctx.getVoltage(nD) : 0) - (nS >= 0 ? ctx.getVoltage(nS) : 0);
    const vGS = ctx.initialUIC && this.instance.ICVGS !== undefined
      ? this.instance.ICVGS : vG - (nS >= 0 ? ctx.getVoltage(nS) : 0);
    const vGD = vGS - vDS;
    this.circuitJunctionCharge(vGD, this.params.CGD);
    this.charges.accept(GATE_DRAIN, this.junction.charge);
    this.circuitJunctionCharge(vGS, this.params.CGS);
    this.charges.accept(GATE_SOURCE, this.junction.charge);
    this.charges.commit();
  }

  resetTransient(): void {
    this.charges.reset();
  }

  /** ngspice JFETtrunc: qgs and qgd. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }

  private stampGateCharge(
    ctx: StampContext,
    index: number,
    gate: number,
    terminal: number,
    zeroBiasCapacitance: number,
  ): void {
    if (zeroBiasCapacitance === 0) return;
    const voltage = (gate >= 0 ? ctx.getVoltage(gate) : 0)
      - (terminal >= 0 ? ctx.getVoltage(terminal) : 0);
    const { charge, capacitance } = this.circuitJunctionCharge(voltage, zeroBiasCapacitance);
    const charges = this.charges;
    stampChargeBranch(
      ctx, gate, terminal, charges.current(index, charge), charges.factor * capacitance, voltage,
    );
  }

  /**
   * Gate charge and capacitance at circuit-frame branch voltage `voltage`:
   * the n-channel charge at `polarity * voltage`, signed by the polarity
   * (ngspice jfetload.c `type`); the capacitance is polarity-independent.
   */
  private circuitJunctionCharge(
    voltage: number,
    zeroBiasCapacitance: number,
  ): { charge: number; capacitance: number } {
    const result = this.gateJunctionCharge(this.polarity * voltage, zeroBiasCapacitance);
    result.charge *= this.polarity;
    return result;
  }

  /**
   * ngspice jfetload.c gate depletion charge and capacitance (grading 1/2,
   * linear capacitance above FC*PB), written to a reused result object.
   */
  private gateJunctionCharge(
    voltage: number,
    zeroBiasCapacitance: number,
  ): { charge: number; capacitance: number } {
    const result = this.junction;
    if (zeroBiasCapacitance === 0) {
      result.charge = 0;
      result.capacitance = 0;
      return result;
    }
    const { PB, FC } = this.params;
    const corner = FC * PB;
    if (voltage < corner) {
      const sarg = Math.sqrt(1 - voltage / PB);
      result.charge = 2 * PB * zeroBiasCapacitance * (1 - sarg);
      result.capacitance = zeroBiasCapacitance / sarg;
      return result;
    }
    const f1 = 2 * PB * (1 - Math.sqrt(1 - FC));
    const f2 = Math.pow(1 - FC, 1.5);
    const f3 = 1 - 1.5 * FC;
    const scaled = zeroBiasCapacitance / f2;
    result.charge = zeroBiasCapacitance * f1
      + scaled * (f3 * (voltage - corner) + (voltage * voltage - corner * corner) / (4 * PB));
    result.capacitance = scaled * (f3 + voltage / (2 * PB));
    return result;
  }

  private stampGateJunction(
    ctx: StampContext,
    anode: number,
    cathode: number,
    voltage: number,
  ): void {
    const exponential = Math.exp(Math.min(voltage / this.thermalVoltage, 40));
    const gmin = (ctx.gmin ?? DEVICE_GMIN) * this.multiplicity;
    const current = this.params.IS * (exponential - 1) + gmin * voltage;
    const conductance = this.params.IS * exponential / this.thermalVoltage + gmin;
    const ieq = this.polarity * (current - conductance * voltage);
    stampTwoTerminal(ctx, anode, cathode, conductance, ieq);
  }

  private stampJunctionCapacitance(
    ctx: StampContext,
    anode: number,
    cathode: number,
    voltage: number,
    zeroBiasCapacitance: number,
  ): void {
    if (zeroBiasCapacitance === 0) return;
    const { capacitance } = this.gateJunctionCharge(voltage, zeroBiasCapacitance);
    stampCapacitance(ctx, anode, cathode, capacitance);
  }
}

const GATE_DRAIN = 0;
const GATE_SOURCE = 1;

function channelCurrent(
  vGS: number,
  vDS: number,
  params: JFETParams,
): { current: number; gm: number; gds: number } {
  if (params.LEVEL === 2) return parkerSkellernCurrent(vGS, vDS, params);

  const overdrive = vGS - params.VTO;
  if (overdrive <= 0) return { current: 0, gm: 0, gds: 0 };

  const betaPrime = params.BETA * (1 + params.LAMBDA * vDS);
  const bFactor = params.bFactor ?? (1 - params.B) / (params.PB - params.VTO);

  if (overdrive >= vDS) {
    const aPart = 2 * params.B + 3 * bFactor * (overdrive - vDS);
    const cPart = vDS * (
      vDS * (bFactor * vDS - params.B) + overdrive * aPart
    );
    return {
      current: betaPrime * cPart,
      gm: betaPrime * vDS * (aPart + 3 * bFactor * overdrive),
      gds: betaPrime * (overdrive - vDS) * aPart
        + params.BETA * params.LAMBDA * cPart,
    };
  }

  const scaledBFactor = overdrive * bFactor;
  const cPart = overdrive * overdrive * (params.B + scaledBFactor);
  return {
    current: betaPrime * cPart,
    gm: betaPrime * overdrive * (2 * params.B + 3 * scaledBFactor),
    gds: params.LAMBDA * params.BETA * cPart,
  };
}

/**
 * Bounded DC subset of the Parker-Skellern model used by ngspice JFET2.
 *
 * This is the PSids Q-law path with the ngspice-47 defaults P=Q=2,
 * XI=1000, Z=1, MXI=VST=LFGAM=HFETA=HFGAM=0, followed by LAMBDA/BETA
 * scaling and DELTA self-heating reduction. THETA is deliberately absent:
 * ngspice-47 reports it as unrecognized and ignores it.
 *
 * Source: ngspice src/spicelib/devices/jfet2/psmodel.c, PSids().
 */
function parkerSkellernCurrent(
  vGS: number,
  vDS: number,
  params: JFETParams,
): { current: number; gm: number; gds: number } {
  const vGT = vGS - params.VTO;
  if (vGT <= 0) return { current: 0, gm: 0, gds: 0 };

  const xi = 1000;
  const z = 1;
  const xiWoo = xi * (params.PB - params.VTO);
  const za = Math.sqrt(1 + z) / 2;
  const vSatFactor = vGT / xiWoo;
  const vSat = vGT / (1 + vSatFactor);
  const aa = za * vDS + vSat / 2;
  const saturationTerm = vSat * vSat * z / 4;
  const rootPositive = Math.sqrt(aa * aa + saturationTerm);
  const rootNegative = Math.sqrt((aa - vSat) ** 2 + saturationTerm);
  const vDT = rootPositive - rootNegative;
  const dvdtDvds = za * (aa / rootPositive - (aa - vSat) / rootNegative);
  // PSids uses (1 + MXI * vSatFactor²); this bounded subset fixes MXI=0.
  const dvdtDvgt = (vDT - vDS * dvdtDvds)
    / (1 + vSatFactor) / vGT;

  const remaining = vGT - vDT;
  let gds = 2 * remaining;
  let current = vDT * remaining + vGT * vDT;
  let gm = 2 * vDT;
  gm += gds * dvdtDvgt;
  gds *= dvdtDvds;

  const betaScale = params.BETA * (1 + params.LAMBDA * vDS);
  gm *= betaScale;
  gds = params.BETA * params.LAMBDA * current + gds * betaScale;
  current *= betaScale;

  const powerFactor = 1 + params.DELTA * vDS * current;
  current /= powerFactor;
  const derivativeScale = 1 / (powerFactor * powerFactor);
  gm *= derivativeScale;
  gds = gds * derivativeScale - params.DELTA * current * current;

  return { current, gm, gds };
}

function stampTwoTerminal(
  ctx: StampContext,
  positive: number,
  negative: number,
  conductance: number,
  equivalentCurrent: number,
): void {
  if (positive >= 0) {
    ctx.stampG(positive, positive, conductance);
    ctx.stampB(positive, -equivalentCurrent);
  }
  if (negative >= 0) {
    ctx.stampG(negative, negative, conductance);
    ctx.stampB(negative, equivalentCurrent);
  }
  if (positive >= 0 && negative >= 0) {
    ctx.stampG(positive, negative, -conductance);
    ctx.stampG(negative, positive, -conductance);
  }
}

function stampCapacitance(
  ctx: StampContext,
  positive: number,
  negative: number,
  capacitance: number,
): void {
  if (positive >= 0) ctx.stampC(positive, positive, capacitance);
  if (negative >= 0) ctx.stampC(negative, negative, capacitance);
  if (positive >= 0 && negative >= 0) {
    ctx.stampC(positive, negative, -capacitance);
    ctx.stampC(negative, positive, -capacitance);
  }
}
