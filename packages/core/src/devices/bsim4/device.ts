/* ******************************************************************************
   *  BSIM4 4.8.3 released on 05/19/2025                                        *
   *  BSIM4 Model Equations                                                     *
   ******************************************************************************

   ******************************************************************************
   *  Copyright (c) 2025 University of California                               *
   *                                                                            *
   *  Project Directors: Prof. Sayeef Salahuddin and Prof. Chenming Hu          *
   *  Developers list: https://www.bsim.berkeley.edu/models/bsim4/auth_bsim4/   *
   ******************************************************************************/

/*
Licensed under Educational Community License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain a copy of the license at
http://opensource.org/licenses/ECL-2.0
Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations
under the License.

BSIM4 model is supported by the members of Silicon Integration Initiative's Compact Model Coalition. A link to the most recent version of this
standard can be found at: http://www.si2.org/cmc
*/

// Modified/ported to TypeScript by spice-ts. Static b4ld limiting and MNA adapter.
import type { ChargeIntegration, ChargeTruncation, DeviceModel, StampContext } from '../device.js';
import { stampChargeCurrent, TransientChargeState } from '../charge-state.js';
import { evaluateBsim4Charges } from './charge.js';
import { DEVICE_GMIN } from '../device.js';
import { fetlim, limvds, pnjlim } from '../devsup.js';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';
import { setupBsim4Model, setupBsim4Instance } from './setup.js';
import type { Bsim4ModelSetup, Bsim4InstanceSetup } from './setup.js';
import { preprocessBsim4 } from './temp.js';
import type { Bsim4Preprocessed } from './temp.js';
import { evaluateBsim4 } from './load.js';
import { evaluateBsim4Junction } from '../bsim4-junction.js';
import type { Bsim4Bias, Bsim4OperatingPoint } from './load.js';

function lowercaseCard(card: Readonly<Record<string, number | string | undefined>>): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const [raw, value] of Object.entries(card)) {
    if (value === undefined) continue;
    const key = raw.toLowerCase();
    if (Object.hasOwn(result, key)) throw new UnsupportedModelParameterError('', raw, 'duplicate case-insensitive BSIM4 parameter');
    result[key] = value;
  }
  return result;
}

/** BSIM4 static and quasi-static capMod=2 transient adapter; no alternate-level fallback. */
export class BSIM4 implements DeviceModel {
  readonly integratesTransientCharge = true;
  readonly truncationCoversCharges = true;
  private readonly chargeState: TransientChargeState;
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  private readonly model: Bsim4ModelSetup;
  private readonly instance: Bsim4InstanceSetup;
  private processed: Bsim4Preprocessed;
  private acProcessed?: Bsim4Preprocessed;
  private previous: Bsim4Bias = { vgs: 0, vds: 0, vbs: 0 };
  private von = 0;
  private limited = false;
  private temperatureC = 27;
  private readonly intrinsicNodes: number[];
  private initializeGate = true;
  private readonly bodyNodes: number[];
  private readonly seriesResistance: readonly number[];
  private previousJunction = [0, 0];

  constructor(readonly name: string, readonly nodes: number[],
    modelCard: Readonly<Record<string, number | string | undefined>>,
    instanceCard: Readonly<Record<string, number | undefined>>, polarity: 1 | -1) {
    if (nodes.length < 4 || nodes.length > 11 || nodes.some(n => !Number.isInteger(n) || n < -1)) {
      throw new InvalidCircuitError('BSIM4 requires four terminals plus enabled internal gate/body/series indices');
    }
    const card = lowercaseCard(modelCard);
    if (Object.hasOwn(card, 'type')) throw new UnsupportedModelParameterError(name, 'type', 'polarity comes from the NMOS/PMOS model type, not an internal TYPE parameter');
    this.model = setupBsim4Model({ ...card, type: polarity });
    const instance = lowercaseCard(instanceCard);
    // Setup uses native C node numbering (ground=0); MNA uses ground=-1.
    this.instance = setupBsim4Instance(this.model, instance,
      { d: nodes[0] + 1, g: nodes[1] + 1, s: nodes[2] + 1, b: nodes[3] + 1 });
    const gate = this.instance.values.rgatemod !== 0;
    const gateNodes = Number(gate) + Number(this.instance.values.rgatemod === 3);
    const body = this.instance.values.rbodymod === 1;
    this.seriesResistance = (['nrd', 'nrs'] as const).map(key => this.model.values.rsh > 0
      && this.instance.given.has(key) && this.instance.values[key] > 0
      ? this.model.values.rsh * this.instance.values[key] : 0);
    const seriesOffset = 4 + gateNodes + 3 * Number(body);
    if (nodes.length !== seriesOffset + this.seriesResistance.filter(r => r > 0).length) {
      throw new InvalidCircuitError('BSIM4 requires internal nodes for enabled RGATEMOD/RBODYMOD/RSH');
    }
    this.bodyNodes = body ? nodes.slice(4 + gateNodes, seriesOffset) : [];
    // 0..2 intrinsic, 3..4 junctions, 5..7 physical GM overlap pairs.
    this.chargeState = new TransientChargeState(this.instance.values.rgatemod === 3 ? 8 : body ? 5 : 3);
    let seriesIndex = seriesOffset;
    const drain = this.seriesResistance[0] > 0 ? nodes[seriesIndex++] : nodes[0];
    const source = this.seriesResistance[1] > 0 ? nodes[seriesIndex] : nodes[2];
    this.intrinsicNodes = [drain, gate ? nodes[4] : nodes[1], source, this.bodyNodes[1] ?? nodes[3]];
    this.processed = preprocessBsim4(this.model, this.instance);
    this.von = this.evaluate(this.previous).von; // enforce all DC guards at construction
  }
  private unsupported(request: string): never {
    throw new UnsupportedModelParameterError(this.name, request, 'BSIM4 supports OP/DC, quasi-static AC and capMod=2 transient (RBODYMOD=0/1) only', { model: 'BSIM4' });
  }
  assertAnalyses(analyses: readonly string[]): void {
    for (const analysis of analyses) {
      if ((analysis === 'tran' || analysis === 'ac') && this.seriesResistance.some(r => r > 0)) this.unsupported('RSH series nodes: ' + analysis);
      if (analysis === 'tran') this.terminalCharges(() => 0);
      else if (analysis !== 'op' && analysis !== 'dc' && analysis !== 'ac') this.unsupported(analysis);
    }
  }
  capacitances(): never { return this.unsupported('capacitances'); }
  charges(): never { return this.unsupported('charge'); }
  noise(): never { return this.unsupported('noise'); }
  stampSmallSignal(ctx: StampContext): void {
    this.stamp(ctx, true);
  }
  stampDynamic(ctx: StampContext): void {
    const p = this.model.values.type;
    const read = (node: number) => node < 0 ? 0 : ctx.getVoltage(node);
    const [d, g, s, b] = this.intrinsicNodes;
    const mult = this.instance.values.m * this.instance.values.mult_q;
    const junction = this.bodyNodes.length ? {
      vbs: p * (read(this.bodyNodes[2]) - read(s)),
      vbd: p * (read(this.bodyNodes[0]) - read(d)),
      stamp: (other: number, _charge: number, c: number) => {
        this.stampConductance(ctx, this.bodyNodes[other === 0 ? 0 : 2], this.intrinsicNodes[other], mult * c, true);
      },
    } : undefined;
    // AC was previously unsupported. Its native CF preprocessing must not
    // change the existing RBODYMOD=0 transient charge path.
    this.acProcessed ??= preprocessBsim4(this.model, this.instance, this.processed.temperatureK, 'ac');
    const tc = evaluateBsim4Charges(this.acProcessed, this.model.given,
      { vgs: p * (read(g) - read(s)), vds: p * (read(d) - read(s)), vbs: p * (read(b) - read(s)) }, junction,
      this.instance.values.rgatemod === 3 ? {
        bias: { vgs: p * (read(this.nodes[5]) - read(s)), vds: p * (read(d) - read(s)), vbs: p * (read(b) - read(s)) },
        stamp: (other, _charge, capacitance) => {
          this.stampConductance(ctx, this.nodes[5], this.intrinsicNodes[other], mult * capacitance, true);
        },
      } : undefined);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
      const r = this.intrinsicNodes[row], c = this.intrinsicNodes[col];
      if (r >= 0 && c >= 0) ctx.stampC(r, c, mult * tc.jacobian[4 * row + col]);
    }
  }
  stampAC(ctx: StampContext, _omega: number): void { this.stampDynamic(ctx); }
  private stampConductance(ctx: StampContext, a: number, b: number, value: number, dynamic = false): void {
    const stamp = (r: number, c: number, x: number) => dynamic ? ctx.stampC(r, c, x) : ctx.stampG(r, c, x);
    if (a >= 0) stamp(a, a, value);
    if (b >= 0) stamp(b, b, value);
    if (a >= 0 && b >= 0) { stamp(a, b, -value); stamp(b, a, -value); }
  }
  resetTransient(): void { this.chargeState.reset(); }
  private terminalCharges(read: (node: number) => number) {
    if (this.seriesResistance.some(r => r > 0)) this.unsupported('RSH series nodes: tran');
    const p = this.model.values.type;
    // RGATEMOD=1/2 store intrinsic and overlap charge at GP (b4ld.c),
    // behind the static/nonlinear gate resistor. Only RGATEMOD=3 splits
    // overlap charge onto a mid-gate node. Acceptance and LTE also use GP.
    const v = this.intrinsicNodes.map(node => node < 0 ? 0 : read(node));
    // All transient modes need native default CF (b4temp.c:173-175).
    // b4ld.c:4149-4177 integrates the same overlap capacitance as AC;
    // omitting fringe charge here loses gate current even with D/S grounded.
    this.acProcessed ??= preprocessBsim4(this.model, this.instance, this.processed.temperatureK, 'ac');
    // b4ld.c: RBODYMOD separates qbd/qbs from intrinsic qbulk/qdrn.
    // Physical junction identities stay DB-D and SB-S in reverse mode too.
    const junctions = this.bodyNodes.length ? [
      { body: this.bodyNodes[0], terminal: this.intrinsicNodes[0], charge: 0, capacitance: 0 },
      { body: this.bodyNodes[2], terminal: this.intrinsicNodes[2], charge: 0, capacitance: 0 },
    ] : [];
    const overlaps: { gate: number; terminal: number; charge: number; capacitance: number }[] = [];
    const voltage = (node: number) => node < 0 ? 0 : read(node);
    const tc = evaluateBsim4Charges(this.acProcessed, this.model.given,
      { vgs: p * (v[1] - v[2]), vds: p * (v[0] - v[2]), vbs: p * (v[3] - v[2]) },
      junctions.length ? {
        vbd: p * (voltage(junctions[0].body) - v[0]),
        vbs: p * (voltage(junctions[1].body) - v[2]),
        stamp: (other, charge, capacitance) => {
          const junction = junctions[other === 0 ? 0 : 1];
          junction.charge += charge;
          junction.capacitance += capacitance;
        },
      } : undefined, this.instance.values.rgatemod === 3 ? {
        bias: { vgs: p * (voltage(this.nodes[5]) - v[2]), vds: p * (v[0] - v[2]), vbs: p * (v[3] - v[2]) },
        stamp: (other, charge, capacitance) => {
          overlaps.push({ gate: this.nodes[5], terminal: this.intrinsicNodes[other], charge, capacitance });
        },
      } : undefined);
    return { ...tc, junctions, overlaps };
  }
  stampTransientCharge(ctx: StampContext, integration: ChargeIntegration): void {
    const tc = this.terminalCharges(node => ctx.getVoltage(node));
    const state = this.chargeState;
    state.begin(integration);
    const mult = this.instance.values.m * this.instance.values.mult_q;
    for (let index = 0; index < 3; index++) {
      const row = [1, 0, 3][index];
      const into = this.intrinsicNodes[row], source = this.intrinsicNodes[2];
      let equivalent = state.current(index, mult * this.model.values.type * tc.q[row]);
      for (let col = 0; col < 4; col++) {
        const node = this.intrinsicNodes[col];
        if (node < 0) continue;
        const g = state.factor * mult * tc.jacobian[4 * row + col];
        equivalent -= g * ctx.getVoltage(node);
        if (into >= 0) ctx.stampG(into, node, g);
        if (source >= 0) ctx.stampG(source, node, -g);
      }
      if (into >= 0) ctx.stampB(into, -equivalent);
      if (source >= 0) ctx.stampB(source, equivalent);
    }
    for (const [index, junction] of tc.junctions.entries()) {
      const { body, terminal, charge, capacitance } = junction;
      const g = state.factor * mult * capacitance;
      const voltage = (node: number) => node < 0 ? 0 : ctx.getVoltage(node);
      const equivalent = state.current(3 + index, mult * this.model.values.type * charge)
        - g * (voltage(body) - voltage(terminal));
      this.stampConductance(ctx, body, terminal, g);
      stampChargeCurrent(ctx, body, terminal, equivalent);
    }
    for (const [index, overlap] of tc.overlaps.entries()) {
      const { gate, terminal, charge, capacitance } = overlap;
      const g = state.factor * mult * capacitance;
      const voltage = (node: number) => node < 0 ? 0 : ctx.getVoltage(node);
      const equivalent = state.current(5 + index, mult * this.model.values.type * charge)
        - g * (voltage(gate) - voltage(terminal));
      this.stampConductance(ctx, gate, terminal, g);
      stampChargeCurrent(ctx, gate, terminal, equivalent);
    }
  }
  stampAcceptedChargeCurrent(ctx: StampContext): void {
    for (let index = 0; index < 3; index++) {
      stampChargeCurrent(ctx, this.intrinsicNodes[[1, 0, 3][index]], this.intrinsicNodes[2], this.chargeState.acceptedChargeCurrent(index));
    }
    if (this.bodyNodes.length) for (const [index, body, terminal] of [
      [3, this.bodyNodes[0], this.intrinsicNodes[0]], [4, this.bodyNodes[2], this.intrinsicNodes[2]],
    ]) stampChargeCurrent(ctx, body, terminal, this.chargeState.acceptedChargeCurrent(index));
    if (this.instance.values.rgatemod === 3) for (const [index, terminal] of [0, 2, 3].entries()) {
      stampChargeCurrent(ctx, this.nodes[5], this.intrinsicNodes[terminal], this.chargeState.acceptedChargeCurrent(5 + index));
    }
  }
  acceptTransientStep(ctx: StampContext): void {
    const tc = this.terminalCharges(node => ctx.getVoltage(node));
    const scale = this.instance.values.m * this.instance.values.mult_q * this.model.values.type;
    for (let index = 0; index < 3; index++) this.chargeState.accept(index, scale * tc.q[[1, 0, 3][index]]);
    for (const [index, junction] of tc.junctions.entries()) this.chargeState.accept(3 + index, scale * junction.charge);
    for (const [index, overlap] of tc.overlaps.entries()) this.chargeState.accept(5 + index, scale * overlap.charge);
    this.chargeState.commit();
  }
  truncateTransientStep(ctx: StampContext, truncation: ChargeTruncation): number {
    return this.chargeState.truncationTimestep(truncation, () => this.acceptTransientStep(ctx));
  }
  evaluate(bias: Bsim4Bias, gmin = DEVICE_GMIN): Bsim4OperatingPoint {
    return evaluateBsim4(this.processed, this.model.given, bias, gmin);
  }
  setTemperature(value: number): void {
    const processed = preprocessBsim4(this.model, this.instance, value + 273.15);
    evaluateBsim4(processed, this.model.given, { vgs: 0, vds: 0, vbs: 0 });
    this.processed = processed;
    this.acProcessed = undefined;
    this.temperatureC = value;
    this.beginOperatingPoint();
  }
  getTemperature(): number { return this.temperatureC; }
  beginOperatingPoint(): void {
    this.previous = { vgs: 0, vds: 0, vbs: 0 };
    this.previousJunction = [0, 0];
    this.initializeGate = true;
    this.von = this.evaluate(this.previous).von;
    this.limited = false;
  }
  limitedLastStamp(): boolean { return this.limited; }

  stamp(ctx: StampContext, smallSignal = false): void {
    const p = this.model.values.type;
    const nodes = this.intrinsicNodes;
    const [d, g, s, b] = nodes;
    const read = (node: number) => node < 0 ? 0 : ctx.getVoltage(node);
    const vs = read(s);
    const raw = { vgs: p * (read(g) - vs), vds: p * (read(d) - vs), vbs: p * (read(b) - vs) };
    let { vgs, vds, vbs } = raw;
    if (!smallSignal) {
      // b4ld.c:605-685, baseline networks. Shared DEV* limiting helpers.
      const old = this.previous;
      if (old.vds >= 0) {
        vgs = fetlim(vgs, old.vgs, this.von);
        vds = limvds(vgs - (raw.vgs - raw.vds), old.vds);
      } else {
        const vgd = fetlim(raw.vgs - raw.vds, old.vgs - old.vds, this.von);
        vds = -limvds(-(raw.vgs - vgd), -old.vds);
        vgs = vgd + vds;
      }
      const vt0 = 1.38064852e-23 * 300.15 / 1.6021766208e-19;
      if (vds >= 0) vbs = pnjlim(vbs, old.vbs, vt0, this.processed.model.vcrit);
      else vbs = pnjlim(raw.vbs - raw.vds, old.vbs - old.vds, vt0, this.processed.model.vcrit) + vds;
      // Reverse-mode reconstruction can change a voltage by a few ulps.
      const changed = (a: number, b: number) => Math.abs(a - b) > 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
      this.limited = changed(vgs, raw.vgs) || changed(vds, raw.vds) || changed(vbs, raw.vbs);
      // b4ld.c:304-312 MODEINITJCT: seed a floating intrinsic gate away
      // from the artificial low-Vgs tunneling branch on the first OP/DC point.
      if (this.initializeGate && this.instance.values.rgatemod !== 0
        && raw.vgs === 0 && raw.vds === 0 && raw.vbs === 0) {
        vgs = p * this.processed.instance.vth0 + 0.1;
        vds = 0.1;
        vbs = 0;
        this.limited = true;
      }
      this.initializeGate = false;
      this.previous = { vgs, vds, vbs };
    }
    const op = this.evaluate({ vgs, vds, vbs }, ctx.gmin ?? DEVICE_GMIN);
    this.von = op.von;
    const voltage = [vs + p * vds, vs + p * vgs, vs, vs + p * vbs];
    const mult = this.instance.values.m * this.instance.values.mult_i;
    // ngspice-47 b4temp.c:2041-2101/b4ld: physical D-DP/S-SP conductance,
    // independent of intrinsic forward/reverse orientation. MULT_I scales both.
    for (const [side, terminal] of [[0, 0], [1, 2]] as const) {
      const resistance = this.seriesResistance[side];
      if (resistance > 0) this.stampConductance(ctx, this.nodes[terminal], nodes[terminal], mult / resistance);
    }
    if (this.bodyNodes.length) {
      const [db, bp, sb] = this.bodyNodes;
      // b4temp.c:1870-1890 and b4ld/b4acld: constant five-resistor body network.
      for (const [a, b, key] of [[bp, this.nodes[3], 'rbpb'], [db, bp, 'rbpd'],
        [sb, bp, 'rbps'], [db, this.nodes[3], 'rbdb'], [sb, this.nodes[3], 'rbsb']] as const) {
        const resistance = this.instance.values[key];
        this.stampConductance(ctx, a, b, mult * (resistance < 1e-3 ? 1e3 : this.model.values.gbmin + 1 / resistance));
      }
      for (const [index, body, terminal, junction] of [[0, db, d, this.processed.drainJunction],
        [1, sb, s, this.processed.sourceJunction]] as const) {
        const rawVoltage = p * (read(body) - read(terminal));
        const v = smallSignal ? rawVoltage : pnjlim(rawVoltage, this.previousJunction[index],
          1.38064852e-23 * 300.15 / 1.6021766208e-19, this.processed.model.vcrit);
        if (!smallSignal) {
          this.previousJunction[index] = v;
          if (Math.abs(v - rawVoltage) > 1e-14) this.limited = true;
        }
        const diode = evaluateBsim4Junction(junction, v, ctx.gmin ?? DEVICE_GMIN);
        this.stampConductance(ctx, body, terminal, mult * diode.conductance);
        if (!smallSignal) {
          const equivalent = mult * p * (diode.current - diode.conductance * v);
          if (body >= 0) ctx.stampB(body, -equivalent);
          if (terminal >= 0) ctx.stampB(terminal, equivalent);
        }
      }
    }
    if (this.instance.values.rgatemod !== 0) {
      const { model, size, instance } = this.processed;
      // ngspice-47 b4temp.c:1926-1938: constant electrode conductance,
      // using junction width per finger and Lnew (not Leff).
      const resistance = model.rshg * (instance.xgw + size.weffCJ / (3 * instance.ngcon))
        / (instance.ngcon * instance.nf * (instance.l + model.xl - model.xgl));
      const electrode = mult * (resistance > 0 ? 1 / resistance : 1e3);
      const conductance = instance.rgatemod > 1 ? mult * op.gcrg : electrode;
      // b4ld.c:5074-5085 (and serial stamp): intrinsic gate tunneling is
      // on GP; the external gate sees only this conservative resistor.
      const external = instance.rgatemod === 3 ? this.nodes[5] : this.nodes[1];
      if (instance.rgatemod === 3) this.stampConductance(ctx, this.nodes[1], external, electrode);
      if (external >= 0) ctx.stampG(external, external, conductance);
      if (g >= 0) ctx.stampG(g, g, conductance);
      if (external >= 0 && g >= 0) {
        ctx.stampG(external, g, -conductance);
        ctx.stampG(g, external, -conductance);
      }
      if (instance.rgatemod > 1) {
        // b4ld/b4acld: d[G(V)*(Vge-Vgp)]/dV. Derivatives follow
        // channel orientation; the gate-resistor current does not.
        const drop = (external < 0 ? 0 : ctx.getVoltage(external)) - voltage[1];
        const gradient = op.mode > 0
          ? [op.gcrgd, op.gcrgg, op.gcrgs, op.gcrgb]
          : [op.gcrgs, op.gcrgg, op.gcrgd, op.gcrgb];
        let equivalent = 0;
        for (let column = 0; column < 4; column++) {
          const derivative = mult * p * drop * gradient[column];
          if (external >= 0 && nodes[column] >= 0) ctx.stampG(external, nodes[column], derivative);
          if (g >= 0 && nodes[column] >= 0) ctx.stampG(g, nodes[column], -derivative);
          equivalent += derivative * voltage[column];
        }
        if (!smallSignal && external >= 0) ctx.stampB(external, equivalent);
        if (!smallSignal && g >= 0) ctx.stampB(g, -equivalent);
      }
    }
    // Stamp I(V) between two terminals using the analytic Jacobian. This is
    // the baseline b4ld DC Newton stamp, with KCL and orientation explicit.
    const pair = (from: number, to: number, current: number, gradient: readonly number[]) => {
      let equivalent = p * current;
      for (let column = 0; column < 4; column++) {
        equivalent -= gradient[column] * voltage[column];
        if (nodes[from] >= 0 && nodes[column] >= 0) ctx.stampG(nodes[from], nodes[column], mult * gradient[column]);
        if (nodes[to] >= 0 && nodes[column] >= 0) ctx.stampG(nodes[to], nodes[column], -mult * gradient[column]);
      }
      if (!smallSignal && nodes[from] >= 0) ctx.stampB(nodes[from], -mult * equivalent);
      if (!smallSignal && nodes[to] >= 0) ctx.stampB(nodes[to], mult * equivalent);
    };
    const dr = op.mode > 0 ? 0 : 2, sr = op.mode > 0 ? 2 : 0;
    const channel = [0, op.gm, 0, op.gmbs];
    channel[dr] = op.gds; channel[sr] = -(op.gds + op.gm + op.gmbs);
    pair(dr, sr, op.ids, channel);
    const substrate = [0, op.gbgs, 0, op.gbbs];
    substrate[dr] = op.gbds; substrate[sr] = -(op.gbds + op.gbgs + op.gbbs);
    pair(dr, 3, op.isub, substrate);
    if (!this.bodyNodes.length) {
      pair(3, 2, op.cbs, [0, 0, -op.gbs, op.gbs]);
      pair(3, 0, op.cbd, [-op.gbd, 0, 0, op.gbd]);
    }
    // b4ld.c:4764-4800,4855-4891. Channel partition follows mode;
    // overlap currents always belong to the physical source/drain terminals.
    const gateChannel = (to: number, current: number, gg: number, gd: number, gb: number) => {
      const gradient = [0, gg, 0, gb];
      gradient[dr] = gd; gradient[sr] = -(gg + gd + gb);
      pair(1, to, current, gradient);
    };
    gateChannel(sr, op.igcs, op.gigcsg, op.gigcsd, op.gigcsb);
    gateChannel(dr, op.igcd, op.gigcdg, op.gigcdd, op.gigcdb);
    // b4ld.c:4801-4811,4892-4902. Gate-body derivatives follow channel
    // orientation, but the current always flows between gate and bulk.
    if (this.model.values.igbmod === 1) gateChannel(3, op.igb, op.gigbg, op.gigbd, op.gigbb);
    pair(1, 2, op.igs, [0, op.gigsg, -op.gigsg, 0]);
    pair(1, 0, op.igd, [-op.gigdg, op.gigdg, 0, 0]);
  }
}
