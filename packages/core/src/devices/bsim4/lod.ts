/* BSIM4 4.8.3, Copyright (c) 2025 University of California.
 * Ported from ngspice-47 b4temp.c by spice-ts under ECL-2.0.
 * Licensed under the Educational Community License, Version 2.0.
 * You may not use this file except in compliance with the License.
 * http://opensource.org/licenses/ECL-2.0 (also LICENSE-ECL-2.0).
 * Distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 * See the License for permissions and limitations; NOTICE-BSIM4.txt for credits.
 */
import type { Bsim4Size, Bsim4TemperatureInstance, Bsim4TemperatureModel } from './temperature-kernel.js';

/** ngspice-47 b4temp.c:1574-1602,1656-1702, ECL-2.0 (see LICENSE-ECL-2.0).
 * Called before DELVTO, MULU0 and the derived instance electrostatics.
 * WPE remains unsupported. Size coefficients are local, never shared by instances.
 */
export function applyLod(
  model: Bsim4TemperatureModel, here: Bsim4TemperatureInstance, size: Bsim4Size,
  temperature: number, length: number, width: number,
): void {
  if (!(here.sa > 0 && here.sb > 0 && (here.nf === 1 || (here.nf > 1 && here.sd > 0)))) return;
  const w = width + Math.max(model.wlod, 0);
  const lMob = Math.pow(length, model.llodku0);
  const wMob = Math.pow(w, model.wlodku0);
  const ku0 = 1 + model.lku0 / lMob + model.wku0 / wMob + model.pku0 / (lMob * wMob);
  const lVth = Math.pow(length, model.llodvth);
  const wVth = Math.pow(w, model.wlodvth);
  const vth = 1 + model.lkvth0 / lVth + model.wkvth0 / wVth + model.pkvth0 / (lVth * wVth);
  const kvth0 = Math.sqrt(vth * vth + 1e-9);
  const ku0temp = ku0 * (1 + model.tku0 * (temperature / model.tnom - 1)) + 1e-9;
  const invRef = 1 / (model.saref + 0.5 * here.l) + 1 / (model.sbref + 0.5 * here.l);
  const rhoRef = model.ku0 / ku0temp * invRef;
  let invSa = 0, invSb = 0;
  // Preserve native i < NF semantics, including nonintegral NF.
  for (let i = 0; i < here.nf; i++) {
    invSa += 1 / here.nf / (here.sa + 0.5 * here.l + i * (here.sd + here.l));
    invSb += 1 / here.nf / (here.sb + 0.5 * here.l + i * (here.sd + here.l));
  }
  const invOd = invSa + invSb;
  const rho = model.ku0 / ku0temp * invOd;
  const kvsat = Math.max(-1, Math.min(1, model.kvsat));
  here.u0temp = size.u0temp * ((1 + rho) / (1 + rhoRef));
  here.vsattemp = size.vsattemp * ((1 + kvsat * rho) / (1 + kvsat * rhoRef));
  const offset = invOd - invRef;
  here.vth0 = size.vth0 + model.kvth0 / kvth0 * offset;
  here.k2 = size.k2 + model.stk2 / Math.pow(kvth0, model.lodk2) * offset;
  here.eta0 = size.eta0 + model.steta0 / Math.pow(kvth0, model.lodeta0) * offset;
  // b4temp.c:1763 deliberately overwrites u0temp with size.u0temp * MULU0.
  // Retain that native ordering rather than silently correcting ngspice physics.
}
