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

// Modified/ported to TypeScript by spice-ts: static-only API, validation, immutable outputs.
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';
import { applyModelDefaults } from './model-defaults.js';
import { MODEL_ALIASES, MODEL_INTEGER_PARAMETERS, MODEL_PARAMETER_NAMES } from './params.js';
import type { Bsim4ModelParameter, Bsim4ModelValues } from './params.js';
import { INSTANCE_PARAMETER_NAMES } from './instance-params.js';
import type { Bsim4ExternalNodes, Bsim4InstanceParameter, Bsim4InstanceValues, Bsim4Nodes } from './instance-params.js';

export { UnsupportedModelParameterError as UnsupportedModel } from '../../errors.js';
export interface Bsim4SetupOptions { readonly nominalTemperatureK?: number; readonly analysis?: string }
export interface Bsim4ModelSetup {
  readonly values: Readonly<Bsim4ModelValues>;
  readonly given: ReadonlySet<Bsim4ModelParameter>;
}
export interface Bsim4InstanceSetup {
  readonly values: Bsim4InstanceValues;
  readonly given: ReadonlySet<Bsim4InstanceParameter>;
  readonly nodes: Bsim4Nodes;
  /** b4set.c:2306-2308. Effective layout constants, not b4temp's effective channel dimensions. */
  readonly geometry: Readonly<{ dmcgeff: number; dmcieff: number; dmdgeff: number }>;
}

function unsupported(parameter: string, reason: string): never {
  throw new UnsupportedModelParameterError('', parameter, reason, { model: 'BSIM4 static setup' });
}
function numeric(key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidCircuitError(`BSIM4 ${key} must be finite`);
  return value;
}
/** A frozen Set still has a working add(). Expose only read operations on a private copy. */
function readonlySet<T>(input: Set<T>): ReadonlySet<T> {
  const set = new Set(input);
  const view: ReadonlySet<T> = Object.freeze({
    size: set.size, has: (value: T) => set.has(value),
    keys: () => set.keys(), values: () => set.values(), entries: () => set.entries(),
    [Symbol.iterator]: () => set[Symbol.iterator](),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => {
      set.forEach(value => callback.call(thisArg, value, value, view));
    },
  });
  return view;
}

// b4set.c:81-203,469-470,2281-2285. Only baseline paths have a downstream
// static implementation contract. Reject BEFORE upstream warning/reset branches.
// This is not a claim of channel-current support; b4temp/b4ld remain separate ports.
const BASELINE_MODES = {
  mobmod: 0, capmod: 2, diomod: 1, rdsmod: 0, rbodymod: 0, rgatemod: 0,
  geomod: 0, permod: 1, tempmod: 0,
  trnqsmod: 0, acnqsmod: 0, mtrlmod: 0, mtrlcompatmod: 0, cvchargemod: 0,
  gidlmod: 0, wpemod: 0, fnoimod: 1, tnoimod: 0,
} as const satisfies Partial<Record<Bsim4ModelParameter, number>>;
// b4set.c:2224-2304. b4temp.c:1657-1761 applies stress/WPE corrections
// subsequently consumed by b4ld.c. Conservatively reject explicitly nondefault
// layout parameters even when another activation parameter is currently absent.
const LAYOUT_DEFAULTS = {
  saref: 1e-6, sbref: 1e-6, wlod: 0, ku0: 0, kvsat: 0, kvth0: 0, tku0: 0,
  llodku0: 0, wlodku0: 0, llodvth: 0, wlodvth: 0, lku0: 0, wku0: 0, pku0: 0,
  lkvth0: 0, wkvth0: 0, pkvth0: 0, stk2: 0, lodk2: 1, steta0: 0, lodeta0: 1,
  web: 0, wec: 0, kvth0we: 0, k2we: 0, ku0we: 0, scref: 1e-6,
  lkvth0we: 0, lk2we: 0, lku0we: 0, wkvth0we: 0, wk2we: 0, wku0we: 0,
  pkvth0we: 0, pk2we: 0, pku0we: 0,
} as const satisfies Partial<Record<Bsim4ModelParameter, number>>;

/** Raw lowercase .model values. TNOM is Celsius on input and Kelvin in values.
 * LEVEL=14/54 select this family. No parser/device registration in this module. */
export function setupBsim4Model(
  card: Readonly<Record<string, unknown>> = {},
  options: Bsim4SetupOptions = {},
): Bsim4ModelSetup {
  // b4ld.c:245-247,3014,3947: analysis-dependent charge paths are outside setup.
  if (options.analysis !== undefined && !['op', 'dc'].includes(options.analysis)) {
    unsupported('analysis', 'only static DC/OP setup is ported (b4ld.c:245-247 charge paths)');
  }
  const nominalTemperatureK = numeric('nominalTemperatureK', options.nominalTemperatureK ?? 300.15);
  if (nominalTemperatureK <= 0) throw new InvalidCircuitError('BSIM4 nominal temperature must be positive Kelvin');
  const values = Object.fromEntries(MODEL_PARAMETER_NAMES.map(key => [key, key === 'version' ? '' : 0])) as Bsim4ModelValues;
  const given = new Set<Bsim4ModelParameter>();
  for (const [raw, input] of Object.entries(card)) {
    if (raw === 'level') {
      if (input !== 14 && input !== 54) unsupported(raw, 'only LEVEL=14 and LEVEL=54 use this setup family');
      continue;
    }
    const key = (MODEL_ALIASES as Readonly<Record<string, string>>)[raw] ?? raw;
    if (key === 'v48intversion' || !MODEL_PARAMETER_NAMES.includes(key as Bsim4ModelParameter)) unsupported(raw, 'unknown or internal parameter');
    const parameter = key as Bsim4ModelParameter;
    if (given.has(parameter)) unsupported(raw, 'duplicate canonical parameter through alias');
    if (parameter === 'version') {
      // b4set.c:204-218. 4.7/4.6 belong to DIFFERENT source families.
      // Preserve the upstream broad 4.8 check for known 4.8 versions only.
      if (typeof input !== 'string' || !/^4\.8(?:[0-3]|\.[0-3])?$/.test(input)) unsupported(raw, 'unported BSIM4 version family');
      values.version = input;
    } else {
      let value = numeric(raw, input);
      if ((MODEL_INTEGER_PARAMETERS as readonly string[]).includes(key) && !Number.isInteger(value)) {
        throw new InvalidCircuitError(`BSIM4 ${raw} must be an integer`);
      }
      if (parameter === 'type' && value !== 1 && value !== -1) throw new InvalidCircuitError('BSIM4 type must be 1 (NMOS) or -1 (PMOS)');
      // b4mpar.c:3367-3369,283-299 and corresponding l/w/p cases.
      if (parameter === 'tnom') {
        value += 273.15;
        if (value <= 0) throw new InvalidCircuitError('BSIM4 TNOM must be above absolute zero');
      }
      if (/^[lwp]?ndep$/.test(key) && value > 1e20) value *= 1e-6;
      if (/^[lwp]?(?:nsd|ngate)$/.test(key) && value > 1e23) value *= 1e-6;
      const baseline = (BASELINE_MODES as Readonly<Record<string, number>>)[key];
      if (key === 'igcmod' && value !== 0 && value !== 1) unsupported(raw, 'only IGCMOD=0/1 is ported');
      if (key === 'igbmod' && value !== 0 && value !== 1) unsupported(raw, 'only IGBMOD=0/1 is ported');
      if (baseline !== undefined && value !== baseline) unsupported(raw, 'nonbaseline selector path is not ported; no silent upstream reset');
      const neutral = (LAYOUT_DEFAULTS as Readonly<Record<string, number>>)[key];
      if (neutral !== undefined && value !== neutral) unsupported(raw, 'stress/well-proximity path is not ported');
      if (parameter === 'binunit' && value !== 1 && value !== 2) unsupported(raw, 'unported binunit value (b4temp.c size binning)');
      if (parameter === 'paramchk' && value !== 0 && value !== 1) unsupported(raw, 'unported parameter-check mode (b4set.c:91-92)');
      values[parameter] = value;
    }
    given.add(parameter);
  }
  applyModelDefaults(values, given, nominalTemperatureK);
  return Object.freeze({ values: Object.freeze(values), given: readonlySet(given) });
}

/** Instance card geometry is already in SI units (parser owns scale conversion).
 * Initial conditions use individual icvds/icvgs/icvbs, not an unparsed IC vector.
 * Effective junction areas/perimeters and dimensions are b4temp's responsibility. */
export function setupBsim4Instance(
  model: Bsim4ModelSetup,
  card: Readonly<Record<string, unknown>>,
  external: Bsim4ExternalNodes,
): Bsim4InstanceSetup {
  const given = new Set<Bsim4InstanceParameter>();
  const m = model.values;
  // b4set.c:2321-2432, plus zero-initialized off/wnflag from b4par.c.
  const values: Record<Bsim4InstanceParameter, number> = {
    l: 5e-6, w: 5e-6, m: 1, mult_i: 1, mult_q: 1, mult_fn: 1, nf: 1, min: 0,
    icvds: 0, icvgs: 0, icvbs: 0, ad: 0, pd: 0, nrd: 1, as: 0, ps: 0, nrs: 1,
    rbdb: m.rbdb, rbsb: m.rbsb, rbpb: m.rbpb, rbps: m.rbps, rbpd: m.rbpd,
    delvto: 0, mulu0: 1, xgw: m.xgw, ngcon: m.ngcon, dtemp: 0,
    rbodymod: m.rbodymod, rgatemod: m.rgatemod, geomod: m.geomod, rgeomod: 0,
    trnqsmod: m.trnqsmod, acnqsmod: m.acnqsmod,
    sa: 0, sb: 0, sd: 2 * m.dmcg, sca: 0, scb: 0, scc: 0, sc: 0, off: 0, wnflag: 0,
  };
  for (const [raw, input] of Object.entries(card)) {
    const key = raw === 'delvt0' ? 'delvto' : raw;
    if (!INSTANCE_PARAMETER_NAMES.includes(key as Bsim4InstanceParameter)) unsupported(raw, 'unknown or unparsed instance parameter');
    const parameter = key as Bsim4InstanceParameter;
    if (given.has(parameter)) unsupported(raw, 'duplicate canonical instance parameter');
    const value = numeric(raw, input);
    // b4set.c:2380-2415,2517-2583. No internal body/gate/NQS nodes.
    if (['rbodymod', 'rgatemod', 'geomod', 'rgeomod', 'trnqsmod', 'acnqsmod', 'wnflag'].includes(key) && value !== 0) {
      unsupported(raw, 'instance selector path is not ported');
    }
    // b4set.c:2417-2432, b4temp.c:1657-1761. Conservative neutral-layout guard.
    if (['sa', 'sb', 'sd', 'sca', 'scb', 'scc', 'sc'].includes(key) && value !== values[parameter]) {
      unsupported(raw, 'nondefault instance stress/well-proximity layout is not ported');
    }
    values[parameter] = value;
    given.add(parameter);
  }
  // b4set.c:2331-2332 uses the instance multiplier, not a fixed 1.
  if (!given.has('mult_fn')) values.mult_fn = values.mult_i;
  for (const key of ['l', 'w', 'm', 'nf'] as const) {
    if (values[key] <= 0 || (key === 'nf' && values.nf < 1)) throw new InvalidCircuitError(`BSIM4 ${key} must be positive (nf >= 1)`);
  }
  for (const key of ['ad', 'as', 'pd', 'ps', 'nrd', 'nrs'] as const) {
    if (values[key] < 0) throw new InvalidCircuitError(`BSIM4 ${key} must be nonnegative`);
  }
  for (const key of ['off', 'min'] as const) {
    if (values[key] !== 0 && values[key] !== 1) throw new InvalidCircuitError(`BSIM4 ${key} must be 0 or 1`);
  }
  // b4set.c:2434-2515. With rdsmod/rgeomod guarded, only given positive
  // squares and positive RSH need unported source/drain internal nodes.
  for (const key of ['nrd', 'nrs'] as const) {
    if (m.rsh > 0 && given.has(key) && values[key] > 0) unsupported(key, 'positive sheet resistance needs an internal source/drain node');
  }
  for (const node of Object.values(external)) {
    if (!Number.isInteger(node) || node < 0) throw new InvalidCircuitError('BSIM4 node indices must be nonnegative integers');
  }
  // b4set.c:2473,2515,2533,2541,2573-2583. q is absent, not ground.
  const nodes: Bsim4Nodes = Object.freeze({ ...external, dp: external.d, sp: external.s,
    gp: external.g, gm: external.g, bp: external.b, db: external.b, sb: external.b, q: null });
  return Object.freeze({ values: Object.freeze(values), given: readonlySet(given), nodes,
    geometry: Object.freeze({ dmcgeff: m.dmcg - m.dmcgt, dmcieff: m.dmci, dmdgeff: m.dmdg - m.dmcgt }) });
}
