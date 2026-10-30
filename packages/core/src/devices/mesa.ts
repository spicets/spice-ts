import type {
  ChargeIntegration, ChargeTruncation, DeviceModel, StampContext,
} from './device.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';
import {
  evaluateMESA,
  mesaACConductance,
  mesaInstanceState,
  MESA_JUNCTION_GMIN,
  resolveMESAInstance,
  type MESAInstanceParams,
  type MESAInstanceState,
  type MESAModel,
  type MESASmallSignalTerms,
} from './mesa-model.js';

/**
 * Intrinsic ngspice MESA (`NMF` level 2/3) MESFET. Nodes are
 * `[drain', gate', source', source'', drain'']`: the channel and the gate
 * junctions sit between gate', drain' and source'; the gate charges qgs/qgd
 * between gate' and the RI/RF nodes source''/drain'' (which coincide with
 * source'/drain' when RI/RF are 0, as in mesasetup.c). External RD/RS/RG and
 * RI/RF are expanded to series resistors at compile time.
 */
export class MESA implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (MESAtrunc: qgs, qgd). */
  readonly truncationCoversCharges = true;
  /**
   * Transient gate charges qgs and qgd, advanced as ngspice mesaload.c does:
   * q = q(n) + C(v) * (v - v(n)) and integrated with NIintegrate.
   */
  readonly integratesTransientCharge = true;
  private readonly charges = new TransientChargeState(2);
  private state: MESAInstanceState;
  /** Channel terms of the last conducting load (ngspice instance fields for MESAacLoad). */
  private small: MESASmallSignalTerms | undefined;

  constructor(
    readonly name: string,
    readonly nodes: number[],
    readonly model: MESAModel,
    readonly instance: MESAInstanceParams,
    readonly junctionGmin = MESA_JUNCTION_GMIN,
  ) {
    this.state = mesaInstanceState(model, instance);
  }

  /** mesasetup.c TS/TD override CKTtemp + DTEMP independently. */
  setTemperature(celsius: number): void {
    const instance = resolveMESAInstance({
      L: this.instance.L, W: this.instance.W,
      ...(this.instance.sourceTemperature === undefined ? {} : { TS: this.instance.sourceTemperature }),
      ...(this.instance.drainTemperature === undefined ? {} : { TD: this.instance.drainTemperature }),
      ...(this.instance.deltaTemperature === undefined ? {} : { DTEMP: this.instance.deltaTemperature }),
    }, celsius);
    this.state = mesaInstanceState({
      ...this.model,
      TF: this.model.defaultTF ? celsius + 273.15 : this.model.TF,
    }, instance);
    this.small = undefined;
  }

  private terminals(): [number, number, number, number, number] {
    const [drain, gate, source] = this.nodes;
    return [drain, gate, source, this.nodes[3] ?? source, this.nodes[4] ?? drain];
  }

  private evaluate(ctx: StampContext) {
    const [drain, gate, source, sourceCharge, drainCharge] = this.terminals();
    const vG = voltage(ctx, gate);
    const vgs = vG - voltage(ctx, source);
    const vgd = vG - voltage(ctx, drain);
    const vgspp = vG - voltage(ctx, sourceCharge);
    const vgdpp = vG - voltage(ctx, drainCharge);
    return { vgs, vgd, vgspp, vgdpp, point: evaluateMESA(vgs, vgd, this.state, ctx.gmin ?? this.junctionGmin) };
  }

  stamp(ctx: StampContext): void {
    const [drain, gate, source] = this.terminals();
    const { vgs, vgd, point } = this.evaluate(ctx);
    if (point.small) this.small = point.small;
    const vds = vgs - vgd;
    // ngspice MESAload stamps the forward-orientation gm/gds against the
    // signed vgs/vds, with a matching equivalent current.
    const equivalentDrainCurrent = point.drainCurrent - point.gm * vgs - point.gds * vds;
    stampChannel(ctx, drain, gate, source, point.gm, point.gds, equivalentDrainCurrent);
    stampJunction(ctx, gate, source, point.gateSourceConductance,
      point.gateSourceCurrent - point.gateSourceConductance * vgs);
    stampJunction(ctx, gate, drain, point.gateDrainConductance,
      point.gateDrainCurrent - point.gateDrainConductance * vgd);
    if (this.model.AG !== 0) {
      const correction = this.model.AG * (point.gateSourceCurrent - point.gateDrainCurrent);
      if (drain >= 0) ctx.stampB(drain, correction);
      if (source >= 0) ctx.stampB(source, -correction);
    }
  }

  /**
   * ngspice MESAacLoad: gate junction conductances of the operating point and
   * gm/gds rebuilt from the stored channel terms at LAMBDA. The
   * frequency-dependent part (LAMBDAHF dispersion) is
   * {@link stampFrequencyConductance}. A channel that never conducted keeps
   * ngspice's zero-initialised terms, so gm = gds = 0.
   */
  stampSmallSignal(ctx: StampContext): void {
    const [drain, gate, source] = this.terminals();
    const { vgs, vgd, point } = this.evaluate(ctx);
    // The MODEINITSMSIG load re-evaluates the channel at the operating point.
    if (point.small) this.small = point.small;
    const { gm, gds } = this.acConductance(vgs - vgd, null);
    stampChannel(ctx, drain, gate, source, gm, gds, 0);
    stampJunction(ctx, gate, source, point.gateSourceConductance, 0);
    stampJunction(ctx, gate, drain, point.gateDrainConductance, 0);
  }

  /** Whether MESAacLoad's gm/gds depend on frequency (DELFO != 0). */
  get frequencyDependent(): boolean {
    return this.state.delf !== 0;
  }

  /**
   * Add gm(f) - gm(LAMBDA) and gds(f) - gds(LAMBDA) at angular frequency
   * `omega`, on top of {@link stampSmallSignal}.
   */
  stampFrequencyConductance(ctx: StampContext, omega: number): void {
    if (!this.frequencyDependent) return;
    const [drain, gate, source] = this.terminals();
    const vds = voltage(ctx, drain) - voltage(ctx, source);
    const base = this.acConductance(vds, null);
    const atFrequency = this.acConductance(vds, omega / 2 / Math.PI);
    stampChannel(ctx, drain, gate, source, atFrequency.gm - base.gm, atFrequency.gds - base.gds, 0);
  }

  private acConductance(vds: number, frequency: number | null): { gm: number; gds: number } {
    if (!this.small) return { gm: 0, gds: 0 };
    if (frequency === null) {
      return mesaACConductance({ ...this.state, delf: 0 }, this.small, vds, 0);
    }
    return mesaACConductance(this.state, this.small, vds, frequency);
  }

  stampDynamic(ctx: StampContext): void {
    const [, gate, , sourceCharge, drainCharge] = this.terminals();
    const { point } = this.evaluate(ctx);
    stampCapacitance(ctx, gate, sourceCharge, point.capGS);
    stampCapacitance(ctx, gate, drainCharge, point.capGD);
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const [, gate, , sourceCharge, drainCharge] = this.terminals();
    const { vgspp, vgdpp, point } = this.evaluate(ctx);
    const charges = this.charges;
    charges.begin(integration);
    const qgs = charges.incrementalCharge(GATE_SOURCE, vgspp, point.capGS);
    const qgd = charges.incrementalCharge(GATE_DRAIN, vgdpp, point.capGD);
    stampChargeBranch(ctx, gate, sourceCharge, charges.current(GATE_SOURCE, qgs), charges.factor * point.capGS, vgspp);
    stampChargeBranch(ctx, gate, drainCharge, charges.current(GATE_DRAIN, qgd), charges.factor * point.capGD, vgdpp);
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    const [, gate, , sourceCharge, drainCharge] = this.terminals();
    stampChargeCurrent(ctx, gate, sourceCharge, this.charges.acceptedChargeCurrent(GATE_SOURCE));
    stampChargeCurrent(ctx, gate, drainCharge, this.charges.acceptedChargeCurrent(GATE_DRAIN));
  }

  acceptTransientStep(ctx: StampContext): void {
    const { vgspp, vgdpp, point } = this.evaluate(ctx);
    const charges = this.charges;
    charges.accept(GATE_SOURCE, charges.incrementalCharge(GATE_SOURCE, vgspp, point.capGS), vgspp, point.capGS);
    charges.accept(GATE_DRAIN, charges.incrementalCharge(GATE_DRAIN, vgdpp, point.capGD), vgdpp, point.capGD);
    charges.commit();
  }

  resetTransient(): void {
    this.charges.reset();
  }

  /** ngspice MESAtrunc: qgs and qgd. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }
}

const GATE_SOURCE = 0;
const GATE_DRAIN = 1;

function voltage(ctx: StampContext, node: number): number {
  return node >= 0 ? ctx.getVoltage(node) : 0;
}

/**
 * Stamp a three-terminal FET channel current (drain to source) with
 * transconductance `gm` (gate-source) and output conductance `gds`, as
 * ngspice MESAload/MESload do.
 */
export function stampChannel(
  ctx: StampContext,
  drain: number,
  gate: number,
  source: number,
  gm: number,
  gds: number,
  equivalentCurrent: number,
): void {
  if (drain >= 0) {
    if (gate >= 0) ctx.stampG(drain, gate, gm);
    ctx.stampG(drain, drain, gds);
    if (source >= 0) ctx.stampG(drain, source, -(gm + gds));
    ctx.stampB(drain, -equivalentCurrent);
  }
  if (source >= 0) {
    if (gate >= 0) ctx.stampG(source, gate, -gm);
    if (drain >= 0) ctx.stampG(source, drain, -gds);
    ctx.stampG(source, source, gm + gds);
    ctx.stampB(source, equivalentCurrent);
  }
}

/** Stamp a two-terminal nonlinear conductance with its equivalent current. */
export function stampJunction(
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

/** Stamp a capacitance between two nodes into the dynamic matrix. */
export function stampCapacitance(
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
