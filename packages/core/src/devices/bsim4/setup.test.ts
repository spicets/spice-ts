import { describe, expect, it } from 'vitest';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';
import { MODEL_PARAMETER_NAMES } from './params.js';
import { setupBsim4Instance, setupBsim4Model, UnsupportedModel } from './setup.js';

const nodes = { d: 1, g: 2, s: 3, b: 0 };

describe('BSIM4 ordered ngspice47 setup', () => {
  it('uses b4set.c minimal NMOS defaults and original given flags', () => {
    const model = setupBsim4Model();
    expect(model.values).toMatchObject({
      type: 1, version: '4.8.3', v48intversion: 483, binunit: 1,
      mobmod: 0, capmod: 2, diomod: 1, permod: 1, geomod: 0,
      rdsmod: 0, rbodymod: 0, rgatemod: 0, tempmod: 0, igcmod: 0, igbmod: 0,
      toxe: 3e-9, toxp: 3e-9, toxm: 3e-9, ndep: 1.7e17,
      vth0: 0.7, u0: 0.067, ua: 1e-9, uc: -0.0465e-9,
      vsat: 8e4, rdsw: 200, jss: 1e-4, jsd: 1e-4,
      njs: 1, njd: 1, xtis: 3, xtid: 3, ijthsfwd: 0.1, ijthdfwd: 0.1,
      tnom: 300.15, saref: 1e-6, lodk2: 1,
      lvth0: 0, wvth0: 0, pvth0: 0,
    });
    expect(model.given.size).toBe(0);
    expect(Object.keys(model.values)).toHaveLength(MODEL_PARAMETER_NAMES.length);
    expect(Object.values(model.values).every(v => typeof v === 'string' || Number.isFinite(v))).toBe(true);
  });
  it('resolves PMOS defaults and level aliases', () => {
    for (const level of [14, 54]) {
      const model = setupBsim4Model({ level, type: -1 });
      expect(model.values).toMatchObject({ type: -1, vth0: -0.7, u0: 0.025, eu: 1, aigc: 9.8e-3 });
      expect(model.given.has('type')).toBe(true);
    }
  });
  it('preserves explicit zero and source-to-drain inheritance', () => {
    const model = setupBsim4Model({ toxe: 2e-9, jss: 0, njs: 1.7, ijthsfwd: 0.2, jsd: 0.003, vtho: 0 });
    expect(model.values).toMatchObject({ toxp: 2e-9, toxm: 2e-9, jss: 0, jsd: 0.003, njd: 1.7, ijthdfwd: 0.2, vth0: 0 });
    expect(model.given.has('vth0')).toBe(true);
    expect(model.given.has('toxp')).toBe(false);
  });
  it('shared aigsd overrides given aigs/aigd and binning uses original base flags', () => {
    const model = setupBsim4Model({ aigsd: 0.02, aigs: 0.03, aigd: 0.04, laigsd: 0.1, laigs: 0.2, laigd: 0.3 });
    expect(model.values).toMatchObject({ aigs: 0.02, aigd: 0.02, laigs: 0.1, laigd: 0.1 });
    expect(model.given.has('aigs')).toBe(true);
    const split = setupBsim4Model({ aigs: 0.03, laigs: 0.2, laigd: 0.3 });
    expect(split.values).toMatchObject({ laigs: 0.2, laigd: 0.3 });
  });
  it('converts raw card Celsius and doping units like b4mpar.c', () => {
    const model = setupBsim4Model({ tnom: 0, ndep: 2e24, nsd: 2e26, ngate: 2e26, lndep: 3e24, wnsd: 3e26, pngate: 3e26 });
    expect(model.values).toMatchObject({ tnom: 273.15, ndep: 2e18, nsd: 2e20, ngate: 2e20, lndep: 3e18, wnsd: 3e20, pngate: 3e20 });
    expect(setupBsim4Model({}, { nominalTemperatureK: 310 }).values.tnom).toBe(310);
    expect(setupBsim4Model({ ndep: 1e20 }).values.ndep).toBe(1e20);
  });
  it.each(['4.8', '4.8.0', '4.8.1', '4.8.2', '4.8.3', '4.80', '4.81', '4.82', '4.83'])('preserves upstream broad version check for %s', version => {
    expect(setupBsim4Model({ version }).values.v48intversion).toBe(483);
  });
  it('copies caller data and makes values/given immutable', () => {
    const card = { vth0: 0.8 };
    const model = setupBsim4Model(card);
    card.vth0 = 9;
    expect(model.values.vth0).toBe(0.8);
    expect(Object.isFrozen(model.values)).toBe(true);
    expect('add' in model.given).toBe(false);
  });
});

describe('BSIM4 instance defaults and baseline nodes', () => {
  it('matches b4set.c:2321-2432 and disabled node aliases', () => {
    const instance = setupBsim4Instance(setupBsim4Model(), {}, nodes);
    expect(instance.values).toMatchObject({ l: 5e-6, w: 5e-6, nf: 1, m: 1, mult_i: 1, mult_q: 1, mult_fn: 1,
      ad: 0, as: 0, pd: 0, ps: 0, nrd: 1, nrs: 1, min: 0, delvto: 0, mulu0: 1, rbdb: 50,
      trnqsmod: 0, acnqsmod: 0, sa: 0, sb: 0, sd: 0, sc: 0, sca: 0, scb: 0, scc: 0 });
    expect(instance.nodes).toEqual({ ...nodes, dp: 1, sp: 3, gp: 2, gm: 2, bp: 0, db: 0, sb: 0, q: null });
    expect(instance.given.size).toBe(0);
    expect(instance.geometry).toEqual({ dmcgeff: 0, dmcieff: 0, dmdgeff: 0 });
  });
  it('preserves given geometry, inherited model values and current multipliers', () => {
    const model = setupBsim4Model({ dmcg: 2e-7, dmci: 3e-7, dmdg: 4e-7, dmcgt: 1e-7, rbdb: 70 });
    const instance = setupBsim4Instance(model, { ad: 0, nrd: 0, nf: 2, mult_i: 1.5, delvt0: 0.1 }, nodes);
    expect(instance.values).toMatchObject({ ad: 0, nrd: 0, nf: 2, mult_fn: 1.5, sd: 4e-7, rbdb: 70, delvto: 0.1 });
    expect(instance.given.has('ad')).toBe(true);
    expect(instance.given.has('sd')).toBe(false);
    expect(instance.geometry).toEqual({ dmcgeff: 1e-7, dmcieff: 3e-7, dmdgeff: 3e-7 });
  });
});

describe('BSIM4 fail-closed setup', () => {
  it('reuses existing typed error', () => { expect(UnsupportedModel).toBe(UnsupportedModelParameterError); });
  it.each([
    ['mobmod', 1], ['capmod', 0], ['diomod', -1], ['diomod', 3], ['rdsmod', 1],
    ['rbodymod', 2], ['rgatemod', 4], ['geomod', 1], ['permod', 0], ['tempmod', 1],
    ['igcmod', 2], ['igbmod', 2], ['mtrlmod', 1], ['mtrlcompatmod', 1], ['cvchargemod', 1],
    ['gidlmod', 1], ['wpemod', 1], ['tnoimod', 1], ['fnoimod', 0],
    ['trnqsmod', 1], ['acnqsmod', 1], ['binunit', 3], ['paramchk', 2],
  ])('rejects genuine alternate selector %s=%s', (parameter, value) => {
    expect(() => setupBsim4Model({ [parameter]: value })).toThrow(UnsupportedModel);
  });
  it('accepts both ported size-binning units', () => {
    expect(setupBsim4Model({ binunit: 2, paramchk: 0 }).values).toMatchObject({ binunit: 2, paramchk: 0 });
  });
  it.each(['mobmod', 'capmod', 'diomod', 'rdsmod', 'rbodymod', 'rgatemod', 'geomod', 'permod',
    'tempmod', 'igcmod', 'igbmod', 'mtrlmod', 'mtrlcompatmod', 'cvchargemod', 'gidlmod', 'wpemod', 'tnoimod', 'fnoimod',
    'trnqsmod', 'acnqsmod'])('rejects nonbaseline model selector %s before upstream resets', parameter => {
    for (const value of [9, -1]) expect(() => setupBsim4Model({ [parameter]: value })).toThrow(UnsupportedModel);
  });
  it.each(['trnqsmod', 'acnqsmod', 'geomod', 'rgeomod', 'wnflag'])('rejects instance mode %s', parameter => {
    expect(() => setupBsim4Instance(setupBsim4Model(), { [parameter]: 1 }, nodes)).toThrow(UnsupportedModel);
  });
  it.each(['saref', 'sbref', 'wlod', 'ku0', 'kvsat', 'kvth0', 'tku0', 'llodku0', 'wlodku0', 'llodvth', 'wlodvth',
    'lku0', 'wku0', 'pku0', 'lkvth0', 'wkvth0', 'pkvth0', 'stk2', 'lodk2', 'steta0', 'lodeta0',
    'web', 'wec', 'kvth0we', 'k2we', 'ku0we', 'scref', 'lkvth0we', 'lk2we', 'lku0we',
    'wkvth0we', 'wk2we', 'wku0we', 'pkvth0we', 'pk2we', 'pku0we'])('guards nondefault layout param %s', parameter => {
    expect(() => setupBsim4Model({ [parameter]: 2 })).toThrow(UnsupportedModel);
  });
  it.each(['sa', 'sb', 'sd', 'sca', 'scb', 'scc', 'sc'])('guards nondefault instance layout %s', parameter => {
    expect(() => setupBsim4Instance(setupBsim4Model(), { [parameter]: 1e-6 }, nodes)).toThrow(UnsupportedModel);
  });
  it('accepts explicitly neutral layout values', () => {
    expect(() => setupBsim4Model({ saref: 1e-6, lodk2: 1, ku0: 0, web: 0 })).not.toThrow();
    expect(() => setupBsim4Instance(setupBsim4Model(), { sa: 0, sca: 0 }, nodes)).not.toThrow();
  });
  it('rejects networks only when node creation is needed', () => {
    const model = setupBsim4Model({ rsh: 20 });
    expect(() => setupBsim4Instance(model, { nrd: 1 }, nodes)).toThrow(UnsupportedModel);
    expect(() => setupBsim4Instance(model, { nrs: 1 }, nodes)).toThrow(UnsupportedModel);
    expect(() => setupBsim4Instance(model, {}, nodes)).not.toThrow();
    expect(() => setupBsim4Instance(model, { nrd: 0, nrs: 0 }, nodes)).not.toThrow();
  });
  it.each(['4.7', '4.6.5', 'garbage', '4.89'])('rejects unsupported version %s', version => {
    expect(() => setupBsim4Model({ version })).toThrow(UnsupportedModel);
  });
  it.each([0, 1, 13, 55])('rejects level %s', level => { expect(() => setupBsim4Model({ level })).toThrow(UnsupportedModel); });
  it('rejects dynamic analyses, unknown keys, aliases collisions and internal fields', () => {
    for (const analysis of ['tran', 'ac', 'noise']) expect(() => setupBsim4Model({}, { analysis })).toThrow(UnsupportedModel);
    for (const card of [{ typo: 1 }, { v48intversion: 483 }, { vtho: 0.7, vth0: 0.8 }]) expect(() => setupBsim4Model(card)).toThrow(UnsupportedModel);
    expect(() => setupBsim4Instance(setupBsim4Model(), { typo: 1 }, nodes)).toThrow(UnsupportedModel);
  });
  it('rejects invalid numeric values instead of returning nonfinite defaults', () => {
    for (const card of [{ vth0: NaN }, { toxe: Infinity }, { type: 0 }, { tnom: -300 }, { binunit: 1.5 }]) {
      expect(() => setupBsim4Model(card)).toThrow(InvalidCircuitError);
    }
    expect(() => setupBsim4Instance(setupBsim4Model(), { l: 0 }, nodes)).toThrow(InvalidCircuitError);
  });
});
