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
import type { DeviceModel, StampContext } from '../device.js';
import { DEVICE_GMIN } from '../device.js';
import { fetlim, limvds, pnjlim } from '../devsup.js';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';
import { setupBsim4Model, setupBsim4Instance } from './setup.js';
import type { Bsim4ModelSetup, Bsim4InstanceSetup } from './setup.js';
import { preprocessBsim4 } from './temp.js';
import type { Bsim4Preprocessed } from './temp.js';
import { evaluateBsim4 } from './load.js';
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

/** DC-only BSIM4 baseline. No alternate-level fallback or dynamic zero stamps. */
export class BSIM4 implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = true;
  private readonly model: Bsim4ModelSetup;
  private readonly instance: Bsim4InstanceSetup;
  private processed: Bsim4Preprocessed;
  private previous: Bsim4Bias = { vgs: 0, vds: 0, vbs: 0 };
  private von = 0;
  private limited = false;
  private temperatureC = 27;

  constructor(readonly name: string, readonly nodes: number[],
    modelCard: Readonly<Record<string, number | string | undefined>>,
    instanceCard: Readonly<Record<string, number | undefined>>, polarity: 1 | -1) {
    if (nodes.length !== 4 || nodes.some(n => !Number.isInteger(n) || n < -1)) {
      throw new InvalidCircuitError('BSIM4 requires four valid terminal indices');
    }
    const card = lowercaseCard(modelCard);
    if (Object.hasOwn(card, 'type')) throw new UnsupportedModelParameterError(name, 'type', 'polarity comes from the NMOS/PMOS model type, not an internal TYPE parameter');
    this.model = setupBsim4Model({ ...card, type: polarity });
    const instance = lowercaseCard(instanceCard);
    // Setup uses native C node numbering (ground=0); MNA uses ground=-1.
    this.instance = setupBsim4Instance(this.model, instance,
      { d: nodes[0] + 1, g: nodes[1] + 1, s: nodes[2] + 1, b: nodes[3] + 1 });
    this.processed = preprocessBsim4(this.model, this.instance);
    this.von = this.evaluate(this.previous).von; // enforce all DC guards at construction
  }
  private unsupported(request: string): never {
    throw new UnsupportedModelParameterError(this.name, request, 'BSIM4 supports only static OP/DC in this slice', { model: 'BSIM4' });
  }
  assertAnalyses(analyses: readonly string[]): void {
    for (const analysis of analyses) if (analysis !== 'op' && analysis !== 'dc') this.unsupported(analysis);
  }
  capacitances(): never { return this.unsupported('capacitances'); }
  charges(): never { return this.unsupported('charge'); }
  noise(): never { return this.unsupported('noise'); }
  stampSmallSignal(): never { return this.unsupported('ac'); }
  stampDynamic(): never { return this.unsupported('capacitances'); }
  stampAC(): never { return this.unsupported('ac'); }
  resetTransient(): never { return this.unsupported('tran'); }
  setTransientTimestep(): never { return this.unsupported('tran'); }
  beginTransientNewton(): never { return this.unsupported('tran'); }
  stampTransientCharge(): never { return this.unsupported('charge'); }
  evaluate(bias: Bsim4Bias, gmin = DEVICE_GMIN): Bsim4OperatingPoint {
    return evaluateBsim4(this.processed, this.model.given, bias, gmin);
  }
  setTemperature(value: number): void {
    const processed = preprocessBsim4(this.model, this.instance, value + 273.15);
    evaluateBsim4(processed, this.model.given, { vgs: 0, vds: 0, vbs: 0 });
    this.processed = processed;
    this.temperatureC = value;
    this.beginOperatingPoint();
  }
  getTemperature(): number { return this.temperatureC; }
  beginOperatingPoint(): void {
    this.previous = { vgs: 0, vds: 0, vbs: 0 };
    this.von = this.evaluate(this.previous).von;
    this.limited = false;
  }
  limitedLastStamp(): boolean { return this.limited; }

  stamp(ctx: StampContext): void {
    if (ctx.dt !== 0) this.unsupported('tran');
    const p = this.model.values.type;
    const [d, g, s, b] = this.nodes;
    const read = (node: number) => node < 0 ? 0 : ctx.getVoltage(node);
    const vs = read(s);
    const raw = { vgs: p * (read(g) - vs), vds: p * (read(d) - vs), vbs: p * (read(b) - vs) };
    let { vgs, vds, vbs } = raw;
    // b4ld.c:605-685, baseline networks. Shared helpers port DEVfetlim/DEVlimvds/DEVpnjlim.
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
    // Reverse-mode reconstruction changes a voltage by a few ulps even when
    // DEV* did not limit it. Do not keep Newton nonconverged on roundoff alone.
    const changed = (a: number, b: number) => Math.abs(a - b) > 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
    this.limited = changed(vgs, raw.vgs) || changed(vds, raw.vds) || changed(vbs, raw.vbs);
    this.previous = { vgs, vds, vbs };
    const op = this.evaluate(this.previous, ctx.gmin ?? DEVICE_GMIN);
    this.von = op.von;
    const voltage = [vs + p * vds, vs + p * vgs, vs, vs + p * vbs];
    const mult = this.instance.values.m * this.instance.values.mult_i;
    // Stamp I(V) between two terminals using the analytic Jacobian. This is
    // the baseline b4ld DC Newton stamp, with KCL and orientation explicit.
    const pair = (from: number, to: number, current: number, gradient: readonly number[]) => {
      let equivalent = p * current;
      for (let column = 0; column < 4; column++) {
        equivalent -= gradient[column] * voltage[column];
        if (this.nodes[from] >= 0 && this.nodes[column] >= 0) ctx.stampG(this.nodes[from], this.nodes[column], mult * gradient[column]);
        if (this.nodes[to] >= 0 && this.nodes[column] >= 0) ctx.stampG(this.nodes[to], this.nodes[column], -mult * gradient[column]);
      }
      if (this.nodes[from] >= 0) ctx.stampB(this.nodes[from], -mult * equivalent);
      if (this.nodes[to] >= 0) ctx.stampB(this.nodes[to], mult * equivalent);
    };
    const dr = op.mode > 0 ? 0 : 2, sr = op.mode > 0 ? 2 : 0;
    const channel = [0, op.gm, 0, op.gmbs];
    channel[dr] = op.gds; channel[sr] = -(op.gds + op.gm + op.gmbs);
    pair(dr, sr, op.ids, channel);
    const substrate = [0, op.gbgs, 0, op.gbbs];
    substrate[dr] = op.gbds; substrate[sr] = -(op.gbds + op.gbgs + op.gbbs);
    pair(dr, 3, op.isub, substrate);
    pair(3, 2, op.cbs, [0, 0, -op.gbs, op.gbs]);
    pair(3, 0, op.cbd, [-op.gbd, 0, 0, op.gbd]);
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
