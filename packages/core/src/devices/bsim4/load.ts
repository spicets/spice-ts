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

// Modified/ported to TypeScript by spice-ts. Pinned ngspice-47 static b4check/b4ld subset.
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';
import { evaluateBsim4Junction } from '../bsim4-junction.js';
import { applyLoad } from './load-kernel.js';
import type { Bsim4LoadInstance, Bsim4LoadSize } from './load-kernel.js';
import type { Bsim4Preprocessed } from './temp.js';
import type { Bsim4ModelParameter } from './params.js';

/** Voltages normalized by model polarity, relative to the physical source.
 * ids/gm/gds/gmbs refer to the oriented positive-Vds channel, before instance
 * M/MULT_I scaling; NF is already included. Junction identities never swap.
 */
export interface Bsim4Bias { readonly vgs: number; readonly vds: number; readonly vbs: number }
export interface Bsim4OperatingPoint {
  readonly mode: 1 | -1;
  readonly ids: number; readonly gm: number; readonly gds: number; readonly gmbs: number;
  readonly isub: number; readonly gbgs: number; readonly gbds: number; readonly gbbs: number;
  readonly cbs: number; readonly cbd: number; readonly gbs: number; readonly gbd: number;
  readonly von: number; readonly vdsat: number; readonly vdseff: number;
  readonly igcs: number; readonly igcd: number; readonly igs: number; readonly igd: number;
  readonly gigcsg: number; readonly gigcsd: number; readonly gigcsb: number;
  readonly gigcdg: number; readonly gigcdd: number; readonly gigcdb: number;
  readonly gigsg: number; readonly gigdg: number;
  readonly igb: number; readonly gigbg: number; readonly gigbd: number; readonly gigbb: number;
}
function unsupported(parameter: string, reason: string): never {
  throw new UnsupportedModelParameterError('', parameter, reason, { model: 'BSIM4 static load' });
}

/** Relevant b4check DC fatal domains. Clamp domains are rejected rather than
 * applying an incomplete correction after b4temp. No warning/reset fallback.
 */
function checkDc(p: Bsim4Preprocessed, given: ReadonlySet<Bsim4ModelParameter>): void {
  const { model: m, size: s, instance: i } = p;
  // b4check.c:319-330; binned accumulation/inversion slope factors.
  if (m.igbmod === 1 && (s.nigbacc <= 0 || s.nigbinv <= 0)) {
    throw new InvalidCircuitError('BSIM4 NIGBACC and NIGBINV must be positive with IGBMOD=1');
  }
  // b4check.c:331-347; enabled gate-current fatal domains.
  if (m.igcmod === 1 && (s.nigc <= 0 || s.poxedge <= 0 || s.pigcd <= 0)) {
    throw new InvalidCircuitError('BSIM4 NIGC, POXEDGE and PIGCD must be positive with IGCMOD=1');
  }
  for (const key of ['off', 'icvgs', 'icvds', 'icvbs'] as const) {
    if (i[key] !== 0) unsupported(key, 'nondefault instance initialization is not ported');
  }
  for (const key of ['agidl', 'agisl'] as const) {
    if (s[key] !== 0) unsupported(key, 'GIDL/GISL terminal currents are not ported');
  }
  for (const key of ['eot', 'tempeot', 'ni0sub', 'toxref'] as const) {
    if (m[key] <= 0) throw new InvalidCircuitError(`BSIM4 ${key} must be positive`);
  }
  for (const key of ['epsrgate', 'epsrsub', 'easub', 'pditsl'] as const) {
    if (m[key] < 0) throw new InvalidCircuitError(`BSIM4 ${key} must be nonnegative`);
  }
  for (const key of ['dvt1', 'dvt1w', 'dsub', 'delta', 'drout', 'fprout', 'pdits'] as const) {
    if (s[key] < 0) throw new InvalidCircuitError(`BSIM4 ${key} must be nonnegative`);
  }
  if (s.lpe0 < -s.leff || s.lpeb < -s.leff || s.ngate > 1e25 || s.pclm <= 0
    || s.w0 === -s.weff || s.b1 === -s.weff || i.toxp <= 0 || i.u0temp <= 0 || i.vsattemp <= 0
    || i.m <= 0 || i.nf < 1 || i.l + m.xl <= m.xgl || i.ngcon < 1) {
    throw new InvalidCircuitError('BSIM4 invalid DC b4check domain');
  }
  // b4check.c:517-558,578-596,797-806. PARAMCHK=0 skips corrections.
  if (m.paramchk === 1) {
    for (const [key, bad] of [
      ['a2', s.a2 < 0.01 || s.a2 > 1], ['prwg', s.prwg < 0], ['rdsw', s.rdsw < 0],
      ['rds0', s.rds0 < 0], ['rdswmin', s.rdswmin < 0],
      ['xn', given.has('vtl') && s.vtl > 0 && s.xn < 3],
      ['lc', given.has('vtl') && s.vtl > 0 && m.lc < 0],
      ['njs', m.njs < 0.1], ['njd', m.njd < 0.1],
    ] as const) {
      if (bad) unsupported(key, 'PARAMCHK correction domain is outside the static subset');
    }
  }
}

/** Standalone static law. Dynamic requests are rejected at the device boundary. */
export function evaluateBsim4(
  processed: Bsim4Preprocessed, given: ReadonlySet<Bsim4ModelParameter>, bias: Bsim4Bias, gmin = 1e-12,
): Bsim4OperatingPoint {
  checkDc(processed, given);
  if (![bias.vgs, bias.vds, bias.vbs, gmin].every(Number.isFinite) || gmin < 0) {
    throw new InvalidCircuitError('BSIM4 bias and gmin must be finite, gmin nonnegative');
  }
  const here = { ...processed.instance } as Bsim4LoadInstance;
  const ids = applyLoad(processed.model, given, here, processed.size as Bsim4LoadSize,
    processed.temperatureK, bias.vgs, bias.vds, bias.vbs) * here.nf;
  const source = evaluateBsim4Junction(processed.sourceJunction, bias.vbs, gmin);
  const drain = evaluateBsim4Junction(processed.drainJunction, bias.vbs - bias.vds, gmin);
  const result: Bsim4OperatingPoint = {
    mode: here.mode as 1 | -1, ids, gm: here.gm * here.nf, gds: here.gds * here.nf, gmbs: here.gmbs * here.nf,
    isub: here.csub * here.nf, gbgs: here.gbgs * here.nf, gbds: here.gbds * here.nf, gbbs: here.gbbs * here.nf,
    cbs: source.current, cbd: drain.current, gbs: source.conductance, gbd: drain.conductance,
    von: here.von, vdsat: here.vdsat, vdseff: here.Vdseff,
    igcs: here.Igcs * here.nf, igcd: here.Igcd * here.nf, igs: here.Igs * here.nf, igd: here.Igd * here.nf,
    gigcsg: here.gIgcsg * here.nf, gigcsd: here.gIgcsd * here.nf, gigcsb: here.gIgcsb * here.nf,
    gigcdg: here.gIgcdg * here.nf, gigcdd: here.gIgcdd * here.nf, gigcdb: here.gIgcdb * here.nf,
    gigsg: here.gIgsg * here.nf, gigdg: here.gIgdg * here.nf,
    igb: here.Igb * here.nf, gigbg: here.gIgbg * here.nf,
    gigbd: here.gIgbd * here.nf, gigbb: here.gIgbb * here.nf,
  };
  if (!Object.values(result).every(Number.isFinite)) throw new InvalidCircuitError('BSIM4 nonfinite DC evaluation');
  return Object.freeze(result);
}
