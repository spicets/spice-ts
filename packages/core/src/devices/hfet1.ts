import {
  DEVICE_GMIN, type ChargeIntegration, type ChargeTruncation, type DeviceModel, type StampContext,
} from './device.js';
import { stampChargeBranch, stampChargeCurrent, TransientChargeState } from './charge-state.js';
import {
  evaluateHFET1,
  type HFET1InstanceParams,
  type HFET1Model,
} from './hfet1-model.js';
import { InvalidCircuitError } from '../errors.js';

export class HFET1 implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  /** {@link truncateTransientStep} is the complete ngspice-47 step bound (HFETAtrunc: qgs, qgd). */
  readonly truncationCoversCharges = true;
  /**
   * Transient gate charges qgs and qgd, advanced as ngspice hfetload.c does:
   * q = q(n) + C(v) * (v - v(n)) and integrated with NIintegrate.
   */
  readonly integratesTransientCharge = true;
  private readonly charges = new TransientChargeState(2);

  constructor(
    readonly name: string,
    readonly nodes: number[],
    readonly model: HFET1Model,
    readonly instance: HFET1InstanceParams,
    circuitTemperature = 27,
  ) {
    this.setTemperature(circuitTemperature);
  }

  /** ngspice-47 hfettemp.c:62-74: absolute TEMP overrides circuit TEMP + DTEMP. */
  setTemperature(celsius: number): void {
    const kelvin = (this.instance.TEMP ?? (celsius + (this.instance.DTEMP ?? 0))) + 273.15;
    if (!Number.isFinite(kelvin) || kelvin <= 0) {
      throw new InvalidCircuitError(`${this.name}: HFET1 temperature must be finite and above absolute zero`);
    }
    this.instance.thermalVoltage = 1.380649e-23 * kelvin / 1.602176634e-19;
  }

  stamp(ctx: StampContext): void {
    const [drain, gate, source] = this.nodes;
    const vD = voltage(ctx, drain);
    const vG = voltage(ctx, gate);
    const vS = voltage(ctx, source);
    const vGS = vG - vS;
    const vDS = vD - vS;
    const evaluated = evaluateHFET1(vGS, vDS, this.model, this.instance, ctx.gmin ?? DEVICE_GMIN);
    const equivalentDrainCurrent = evaluated.drainCurrent
      - evaluated.gm * vGS - evaluated.gds * vDS;

    stampControlledChannel(
      ctx,
      drain,
      gate,
      source,
      evaluated.gm,
      evaluated.gds,
      equivalentDrainCurrent,
    );
    stampJunction(
      ctx,
      gate,
      source,
      evaluated.gateSourceConductance,
      evaluated.gateSourceCurrent - evaluated.gateSourceConductance * vGS,
    );
    const vGD = vGS - vDS;
    stampJunction(
      ctx,
      gate,
      drain,
      evaluated.gateDrainConductance,
      evaluated.gateDrainCurrent - evaluated.gateDrainConductance * vGD,
    );
  }

  stampDynamic(ctx: StampContext): void {
    const [drain, gate, source] = this.nodes;
    const evaluated = evaluateHFET1(
      voltage(ctx, gate) - voltage(ctx, source),
      voltage(ctx, drain) - voltage(ctx, source),
      this.model,
      this.instance,
      ctx.gmin ?? DEVICE_GMIN,
    );
    stampCapacitance(ctx, gate, source, evaluated.capGS);
    stampCapacitance(ctx, gate, drain, evaluated.capGD);
  }

  stampAC(ctx: StampContext, _omega: number): void {
    this.stampDynamic(ctx);
  }

  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const [drain, gate, source] = this.nodes;
    const vGS = voltage(ctx, gate) - voltage(ctx, source);
    const vGD = voltage(ctx, gate) - voltage(ctx, drain);
    const { capGS, capGD } = evaluateHFET1(vGS, vGS - vGD, this.model, this.instance, ctx.gmin ?? DEVICE_GMIN);
    const charges = this.charges;
    charges.begin(integration);
    const qGS = charges.incrementalCharge(GATE_SOURCE, vGS, capGS);
    const qGD = charges.incrementalCharge(GATE_DRAIN, vGD, capGD);
    stampChargeBranch(ctx, gate, source, charges.current(GATE_SOURCE, qGS), charges.factor * capGS, vGS);
    stampChargeBranch(ctx, gate, drain, charges.current(GATE_DRAIN, qGD), charges.factor * capGD, vGD);
  }

  stampAcceptedChargeCurrent(ctx: StampContext): void {
    const [drain, gate, source] = this.nodes;
    stampChargeCurrent(ctx, gate, source, this.charges.acceptedChargeCurrent(GATE_SOURCE));
    stampChargeCurrent(ctx, gate, drain, this.charges.acceptedChargeCurrent(GATE_DRAIN));
  }

  acceptTransientStep(ctx: StampContext): void {
    const [drain, gate, source] = this.nodes;
    const vGS = voltage(ctx, gate) - voltage(ctx, source);
    const vGD = voltage(ctx, gate) - voltage(ctx, drain);
    const { capGS, capGD } = evaluateHFET1(vGS, vGS - vGD, this.model, this.instance, ctx.gmin ?? DEVICE_GMIN);
    const charges = this.charges;
    charges.accept(GATE_SOURCE, charges.incrementalCharge(GATE_SOURCE, vGS, capGS), vGS, capGS);
    charges.accept(GATE_DRAIN, charges.incrementalCharge(GATE_DRAIN, vGD, capGD), vGD, capGD);
    charges.commit();
  }

  resetTransient(): void {
    this.charges.reset();
  }

  /** ngspice HFETAtrunc: qgs and qgd. */
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.charges.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }
}

const GATE_SOURCE = 0;
const GATE_DRAIN = 1;

function voltage(ctx: StampContext, node: number): number {
  return node >= 0 ? ctx.getVoltage(node) : 0;
}

function stampControlledChannel(
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

function stampJunction(
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
