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

// Modified/ported to TypeScript by spice-ts. ngspice-47 a80f6e3e95d51534905b1f23410a951802666656.
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';
import { setupBsim4Junction } from '../bsim4-junction.js';
import type { Bsim4Junction } from '../bsim4-junction.js';
import type { Bsim4InstanceSetup, Bsim4ModelSetup } from './setup.js';
import { applyTemperature } from './temperature-kernel.js';
import type { Bsim4Size, Bsim4TemperatureInstance, Bsim4TemperatureModel } from './temperature-kernel.js';

export type Bsim4StaticInstance = Bsim4TemperatureInstance & {
  Aseff: number; Adeff: number; Pseff: number; Pdeff: number;
  SourceSatCurrent: number; DrainSatCurrent: number;
  Nvtms: number; Nvtmd: number;
  vjsmFwd: number; vjdmFwd: number; IVjsmFwd: number; IVjdmFwd: number;
  sourceConductance: number; drainConductance: number;
};
export interface Bsim4Preprocessed {
  readonly temperatureK: number;
  readonly model: Readonly<Bsim4TemperatureModel>;
  readonly size: Readonly<Bsim4Size>;
  readonly instance: Readonly<Bsim4StaticInstance>;
  readonly sourceJunction: Bsim4Junction;
  readonly drainJunction: Bsim4Junction;
}
function unsupported(parameter: string, reason: string): never {
  throw new UnsupportedModelParameterError('', parameter, reason, { model: 'BSIM4 static temperature' });
}
function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new InvalidCircuitError(`BSIM4 ${name} must be finite and positive`);
}
function finiteRecord(name: string, values: object): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new InvalidCircuitError(`BSIM4 ${name}.${key} is not finite`);
  }
}

/** Static baseline port of b4temp. Input is the frozen stage-1 setup result.
 * Operating temperature is Kelvin; TNOM has already been converted to Kelvin.
 * No model cache is retained, so temperatures and given flags cannot leak across instances.
 * This prepares DC terms, not channel evaluation, b4check or simulator registration.
 */
export function preprocessBsim4(
  setup: Bsim4ModelSetup,
  instanceSetup: Bsim4InstanceSetup,
  temperatureK = 300.15,
): Bsim4Preprocessed {
  positive('operating temperature Kelvin', temperatureK);
  const model = { ...setup.values } as Bsim4TemperatureModel;
  const here = { ...instanceSetup.values } as Bsim4StaticInstance;
  // b4temp.c:1385-1397 resets negative overlaps in 4.8.3. Fail closed
  // instead of silently applying an incomplete upstream correction.
  if (model.igcmod === 1 && (model.dlcig < 0 || model.dlcigd < 0)) {
    unsupported('dlcig/dlcigd', 'negative gate-overlap correction is outside the static subset');
  }
  // b4check.c:797-806 corrects both resolved coefficients when PARAMCHK=1.
  // Reject before any temperature law: clamping here would change native
  // b4temp/b4check ordering. NJD inheritance is already resolved by setup.
  if (model.paramchk === 1) {
    for (const key of ['njs', 'njd'] as const) {
      if (model[key] < 0.1) unsupported(key, 'PARAMCHK correction domain is outside the static subset');
    }
  }
  // b4temp.c:2227-2261. Default zero density disables TAT; never discard enabled TAT.
  for (const key of ['jtss', 'jtsd', 'jtssws', 'jtsswd', 'jtsswgs', 'jtsswgd'] as const) {
    if (model[key] !== 0) unsupported(key, 'trap-assisted junction leakage temperature/current law is not ported');
  }
  // Pinned b4temp uses CKTtemp, not instance DTEMP. Do not promise a silent offset.
  if (here.dtemp !== 0) unsupported('dtemp', 'instance temperature offsets are outside the pinned static port');
  const size = { lc: 0, tfactor: 0 } as Bsim4Size;
  applyTemperature(model, setup.given, here, size, temperatureK);
  for (const key of ['toxe', 'toxp', 'toxm', 'epsrox', 'njs', 'njd'] as const) positive(key, model[key]);
  for (const key of ['leff', 'weff', 'leffCV', 'weffCV', 'weffCJ', 'ndep', 'nsub', 'nsd', 'phi', 'u0temp', 'vsattemp'] as const) positive(key, size[key]);
  if (size.ngate < 0 || size.xj <= 0 || here.mulu0 <= 0) throw new InvalidCircuitError('BSIM4 invalid NGATE, XJ or MULU0');

  // b4geo.c:28-54,68-88, GEOMOD=0 (setup guards all other geometries).
  // Cast-to-int only affects parity in C; the count formulas use the original nf.
  let nuIntD: number, nuEndD: number, nuIntS: number, nuEndS: number;
  if (Math.trunc(here.nf) % 2 !== 0) {
    nuEndD = nuEndS = 1;
    nuIntD = nuIntS = 2 * Math.max((here.nf - 1) / 2, 0);
  } else if (here.min === 1) {
    nuEndD = 2; nuIntD = 2 * Math.max(here.nf / 2 - 1, 0);
    nuEndS = 0; nuIntS = here.nf;
  } else {
    nuEndD = 0; nuIntD = here.nf;
    nuEndS = 2; nuIntS = 2 * Math.max(here.nf / 2 - 1, 0);
  }
  const { dmcgeff: DMCG, dmcieff: DMCI } = instanceSetup.geometry;
  const T0 = DMCG + DMCI, T1 = DMCG + DMCG;
  const PSiso = T0 + T0 + size.weffCJ, PSsha = T1;
  const ASiso = T0 * size.weffCJ, ASsha = DMCG * size.weffCJ;
  // b4temp.c:1956-2040. PERMOD=1 subtraction applies only to GIVEN positive perimeter.
  const gateEdge = size.weffCJ * here.nf;
  here.Pseff = Math.max(0, instanceSetup.given.has('ps') ? (here.ps === 0 ? 0 : here.ps - gateEdge) : nuEndS * PSiso + nuIntS * PSsha);
  here.Pdeff = Math.max(0, instanceSetup.given.has('pd') ? (here.pd === 0 ? 0 : here.pd - gateEdge) : nuEndD * PSiso + nuIntD * PSsha);
  here.Aseff = Math.max(0, instanceSetup.given.has('as') ? here.as : nuEndS * ASiso + nuIntS * ASsha);
  here.Adeff = Math.max(0, instanceSetup.given.has('ad') ? here.ad : nuEndD * ASiso + nuIntD * ASsha);
  // b4temp.c:2068-2071,2099-2102. No prime-node resistance network in baseline.
  here.sourceConductance = here.drainConductance = 0;

  // Reuse the independently C-verified DIOMOD=1 law (b4temp.c:2107-2189).
  // Pass nominal densities, not already-scaled densities, to avoid scaling twice.
  const parameters = { tnom: model.tnom - 273.15, diomod: model.diomod,
    jss: model.jss, jsd: model.jsd, jsws: model.jsws, jswd: model.jswd,
    jswgs: model.jswgs, jswgd: model.jswgd, njs: model.njs, njd: model.njd,
    xtis: model.xtis, xtid: model.xtid, ijthsfwd: model.ijthsfwd, ijthdfwd: model.ijthdfwd };
  const sourceJunction = setupBsim4Junction({ terminal: 'source', parameters, temperatureC: temperatureK - 273.15,
    geometry: { area: here.Aseff, perimeter: here.Pseff, gateEdge } });
  const drainJunction = setupBsim4Junction({ terminal: 'drain', parameters, temperatureC: temperatureK - 273.15,
    geometry: { area: here.Adeff, perimeter: here.Pdeff, gateEdge } });
  here.SourceSatCurrent = sourceJunction.saturationCurrent;
  here.DrainSatCurrent = drainJunction.saturationCurrent;
  here.Nvtms = sourceJunction.nvtm; here.Nvtmd = drainJunction.nvtm;
  here.vjsmFwd = sourceJunction.forwardVoltage; here.vjdmFwd = drainJunction.forwardVoltage;
  here.IVjsmFwd = sourceJunction.forwardExponentialCurrent; here.IVjdmFwd = drainJunction.forwardExponentialCurrent;
  finiteRecord('model', model); finiteRecord('size', size); finiteRecord('instance', here);
  return Object.freeze({ temperatureK, model: Object.freeze(model), size: Object.freeze(size),
    instance: Object.freeze(here), sourceJunction, drainJunction });
}
