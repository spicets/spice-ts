import { describe, expect, it } from 'vitest';
import { InvalidCircuitError, UnsupportedModelParameterError } from '../../errors.js';
import { setupBsim4Instance, setupBsim4Model } from './setup.js';
import { preprocessBsim4 } from './temp.js';

const nodes = { d: 1, g: 2, s: 0, b: 0 };
const card = {
  tnom: 27, toxe: 2e-9, toxm: 2e-9, ndep: 1e17, nsd: 1e20,
  k1: 0.5, k2: -0.02, vth0: 0.7, lvth0: 0.04, wvth0: 0.08, pvth0: 0.16,
  lint: 1e-8, wint: 2e-8, dwj: 1e-8,
  u0: 500, ute: -1.5, up: 0, vsat: 1e5, at: 2e4,
  ua: 1e-9, ua1: 2e-9, ub: 1e-19, ub1: 2e-19, uc: -1e-11, uc1: -2e-11,
  rdsw: 100, prt: 20, wr: 1, kt1: -0.1, kt1l: 0, kt2: 0.02,
  jss: 1e-4, jsd: 2e-4, jsws: 1e-10, jswd: 2e-10, jswgs: 3e-10, jswgd: 4e-10,
  njs: 1, njd: 1.2, xtis: 3, xtid: 2, pbs: 0.9, pbd: 0.8, tpb: 1e-3,
};
const geometry = { l: 1.02e-6, w: 4.08e-6, nf: 2, as: 2e-12, ad: 3e-12, ps: 8e-6, pd: 9e-6 };
function run(modelCard: Record<string, number> = card, instanceCard: Record<string, number> = geometry, temperatureK = 300.15) {
  const model = setupBsim4Model(modelCard);
  return preprocessBsim4(model, setupBsim4Instance(model, instanceCard, nodes), temperatureK);
}
// Fixed relative 2e-12 tolerance for elementary double formulas, not circuit-tuned.
function close(actual: number, expected: number) {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2e-12 * Math.max(Math.abs(expected), 1e-30));
}

describe('b4temp static preprocessing', () => {
  it.each([undefined, 0, 3e-10])('isolates AC default CF without mutating static/transient setup (cf=%s)', cf => {
    const model = setupBsim4Model(cf === undefined ? card : { ...card, cf });
    const instance = setupBsim4Instance(model, geometry, nodes);
    const before = preprocessBsim4(model, instance);
    const ac = preprocessBsim4(model, instance, 300.15, 'ac');
    const nativeCf = 2 * model.values.epsrox * 8.85418e-12 / 3.141592654
      * Math.log(1 + 0.4e-6 / model.values.toxe);
    expect(ac.model.cf).toBe(cf ?? nativeCf);
    expect(preprocessBsim4(model, instance)).toEqual(before);
    if (cf !== undefined) expect(ac).toEqual(before);
    else expect(ac.size.cgso).toBeGreaterThan(before.size.cgso);
  });
  it('resolves per-finger effective dimensions and L/W/P at TNOM', () => {
    const p = run();
    close(p.size.leff, 1e-6);
    close(p.size.weff, 2e-6);
    close(p.size.weffCJ, 2.02e-6);
    // Inv_L=1, Inv_W=0.5, Inv_LW=0.5, hence 0.7+0.04+0.04+0.08.
    close(p.size.vth0, 0.86);
    close(p.size.u0temp, 0.05);
    close(p.size.vsattemp, 1e5);
    close(p.size.rds0, 100 / 2.02);
    close(p.instance.Pseff, 8e-6 - 2.02e-6 * 2);
    close(p.instance.Pdeff, 9e-6 - 2.02e-6 * 2);
  });
  it('applies drawn offsets and length/width/cross corrections before binning', () => {
    const p = run({ ...card, xl: 2e-8, xw: 3e-8, ll: 1e-14, lw: 4e-14, lwl: 8e-20,
      wl: 2e-14, ww: 8e-14, wwl: 16e-20, wlc: 4e-14, wwc: 4e-14, wwlc: 8e-20 },
    { ...geometry, l: 1.98e-6, w: 7.94e-6 });
    const Lnew = 2e-6, Wnew = 4e-6;
    const dl = 1e-8 + 1e-14 / Lnew + 4e-14 / Wnew + 8e-20 / (Lnew * Wnew);
    const dw = 2e-8 + 2e-14 / Lnew + 8e-14 / Wnew + 16e-20 / (Lnew * Wnew);
    const dwj = 1e-8 + 4e-14 / Lnew + 4e-14 / Wnew + 8e-20 / (Lnew * Wnew);
    close(p.size.dl, dl); close(p.size.dw, dw); close(p.size.dwj, dwj);
    close(p.size.leff, Lnew - 2 * dl); close(p.size.weff, Wnew - 2 * dw);
    close(p.size.weffCJ, Wnew - 2 * dwj);
  });
  it('scales mobility, velocity, resistance and junctions off TNOM', () => {
    const Temp = 360.15, Tnom = 300.15, T0 = Temp / Tnom - 1;
    const p = run(card, geometry, Temp);
    close(p.size.u0temp, 0.05 * Math.pow(Temp / Tnom, -1.5));
    close(p.size.ua, 1e-9 + 2e-9 * T0);
    close(p.size.ub, 1e-19 + 2e-19 * T0);
    close(p.size.uc, -1e-11 - 2e-11 * T0);
    close(p.size.vsattemp, 1e5 - 2e4 * T0);
    close(p.size.rds0, (100 + 20 * T0) / 2.02);
    close(p.model.PhiBS, 0.84);
    close(p.model.PhiBD, 0.74);
    const Eg = (t: number) => 1.16 - 7.02e-4 * t * t / (t + 1108);
    const thermal = Eg(Tnom) / (8.617087e-5 * Tnom) - Eg(Temp) / (8.617087e-5 * Temp);
    const scaleS = Math.exp(thermal + 3 * Math.log(Temp / Tnom));
    const scaleD = Math.exp((thermal + 2 * Math.log(Temp / Tnom)) / 1.2);
    close(p.instance.SourceSatCurrent, (2e-12 * 1e-4 + 3.96e-6 * 1e-10 + 4.04e-6 * 3e-10) * scaleS);
    close(p.instance.DrainSatCurrent, (3e-12 * 2e-4 + 4.96e-6 * 2e-10 + 4.04e-6 * 4e-10) * scaleD);
    close(p.sourceJunction.nvtm, 8.617087e-5 * Temp);
    close(p.drainJunction.nvtm, 8.617087e-5 * Temp * 1.2);
  });
  it('derives phi, depletion depth, built-in voltage and theta from nominal silicon formulas', () => {
    const p = run();
    const Vtm0 = 8.617087e-5 * 300.15;
    const Eg0 = 1.16 - 7.02e-4 * 300.15 ** 2 / (300.15 + 1108);
    const ni = 1.45e10 * Math.exp(21.5565981 - Eg0 / (2 * Vtm0));
    const phi = Vtm0 * Math.log(1e17 / ni) + 0.4;
    const Xdep0 = Math.sqrt(2 * 1.03594e-10 / (1.60219e-19 * 1e23)) * Math.sqrt(phi);
    close(p.size.phi, phi);
    close(p.size.sqrtPhi, Math.sqrt(phi));
    close(p.size.Xdep0, Xdep0);
    close(p.size.vbi, Vtm0 * Math.log(1e37 / (ni * ni)));
    const exponent = p.size.dsub * 1e-6 / Math.sqrt(1.03594e-10 / (3.9 * 8.85418e-12) * 2e-9 * Xdep0);
    const exp = Math.exp(exponent);
    const theta = exponent < 34 ? exp / ((exp - 1) ** 2 + 2 * exp * 1.713908431e-15) : 1 / (5.834617425e14 - 2);
    close(p.size.theta0vb0, theta);
    // Phi is nominal, not recalculated using the operating temperature.
    close(run(card, geometry, 360.15).size.phi, phi);
  });
  it('honors BINUNIT=2 in SI, explicit zero geometry and instance shifts', () => {
    const p = run({ ...card, binunit: 2, lvth0: 4e-8, wvth0: 8e-8, pvth0: 1.6e-13 }, { ...geometry, as: 0, ps: 0, delvto: 0.03, mulu0: 2 });
    close(p.size.vth0, 0.86);
    close(p.instance.vth0, 0.89);
    close(p.instance.u0temp, 0.1);
    expect(p.instance.SourceSatCurrent).toBe(0);
  });
  it('keeps setup and previous temperature outputs immutable', () => {
    const model = setupBsim4Model(card);
    const instance = setupBsim4Instance(model, geometry, nodes);
    const cold = preprocessBsim4(model, instance, 300.15);
    preprocessBsim4(model, instance, 360.15);
    expect(model.values.u0).toBe(500);
    close(cold.size.u0temp, 0.05);
    expect(Object.isFrozen(cold.size)).toBe(true);
    expect(Object.isFrozen(cold.instance)).toBe(true);
  });
  it('derives K1/K2 from doping and honors individual given defaults', () => {
    const model = { ...card } as Record<string, number>;
    delete model.k1; delete model.k2;
    const p = run(model);
    const gamma1 = 5.753e-12 * Math.sqrt(p.size.ndep) / p.model.coxe;
    const gamma2 = 5.753e-12 * Math.sqrt(p.size.nsub) / p.model.coxe;
    const vbx = -Math.abs(p.size.phi - 7.7348e-4 * p.size.ndep * p.size.xt ** 2);
    const T1 = Math.sqrt(p.size.phi - vbx) - Math.sqrt(p.size.phi);
    const T2 = Math.sqrt(p.size.phi * (p.size.phi - p.size.vbm)) - p.size.phi;
    const k2 = (gamma1 - gamma2) * T1 / (2 * T2 + p.size.vbm);
    close(p.size.gamma1, gamma1); close(p.size.gamma2, gamma2);
    close(p.size.k2, k2);
    close(p.size.k1, gamma2 - 2 * k2 * Math.sqrt(p.size.phi - p.size.vbm));
    close(run({ ...model, k1: 0.5 }).size.k2, -0.0186);
    close(run({ ...model, k2: -0.02 }).size.k1, 0.53);
  });
  it('uses GAMMA1 to infer NDEP only if the original NDEP was absent', () => {
    const model = { ...card, gamma1: 0.4 } as Record<string, number>;
    delete model.ndep;
    const p = run(model);
    close(p.size.ndep, 3.01248e22 * (0.4 * p.model.coxe) ** 2);
    close(run({ ...model, ndep: 1e17 }).size.ndep, 1e17);
  });
  it('keeps KT2 binned for b4ld and applies KT1 only in vfbzbfactor', () => {
    const cold = run(), hot = run(card, geometry, 360.15);
    close(hot.size.vth0, cold.size.vth0);
    close(hot.size.kt2, 0.02);
    close(hot.size.vfbzbfactor - cold.size.vfbzbfactor, -0.1 * (360.15 / 300.15 - 1));
  });
  it.each([1, 2, 3, 4, 2.5])('derives absent GEOMOD=0 junction geometry for nf=%s', nf => {
    const p = run({ ...card, lint: 0, wint: 0, dwj: 0, dmcg: 1e-7, dmci: 2e-7 }, { l: 1e-6, w: nf * 2e-6, nf });
    const odd = Math.trunc(nf) % 2 !== 0;
    const endS = odd ? 1 : 2, endD = odd ? 1 : 0;
    const intS = odd ? nf - 1 : 2 * Math.max(nf / 2 - 1, 0);
    const intD = odd ? nf - 1 : nf;
    close(p.instance.Pseff, endS * 2.6e-6 + intS * 2e-7);
    close(p.instance.Pdeff, endD * 2.6e-6 + intD * 2e-7);
    close(p.instance.Aseff, endS * 6e-13 + intS * 2e-13);
    close(p.instance.Adeff, endD * 6e-13 + intD * 2e-13);
    const swapped = run({ ...card, lint: 0, wint: 0, dwj: 0, dmcg: 1e-7, dmci: 2e-7 }, { l: 1e-6, w: nf * 2e-6, nf, min: 1 });
    close(swapped.instance.Aseff, p.instance.Adeff);
    close(swapped.instance.Adeff, p.instance.Aseff);
  });
  it('distinguishes given zero from absent area/perimeter and clamps gate subtraction', () => {
    const m = { ...card, dmcg: 1e-7, dmci: 2e-7 };
    const p = run(m, { ...geometry, as: 0, ps: 1e-8 });
    expect(p.instance.Aseff).toBe(0); expect(p.instance.Pseff).toBe(0);
    expect(p.instance.SourceSatCurrent).toBe(0);
    const absent = { ...geometry } as Record<string, number>;
    delete absent.as; delete absent.ps;
    expect(run(m, absent).instance.SourceSatCurrent).toBeGreaterThan(0);
  });
  it('reconciles TOXP/DTOX with original flags, not inherited setup defaults', () => {
    const model = { ...card, toxp: 2.5e-9, dtox: 0.5e-9 } as Record<string, number>;
    delete model.toxe; delete model.toxm;
    const p = run(model);
    close(p.model.toxe, 3e-9); close(p.model.toxm, 3e-9);
    close(run({ ...card, dtox: 0.5e-9 }).model.toxp, 1.5e-9);
  });
  it('clamps negative junction densities and built-in potentials exactly as C', () => {
    const p = run({ ...card, jss: -1, jsws: -1, jswgs: -1, pbs: -1, tpb: 0.01 }, geometry, 360.15);
    expect(p.instance.SourceSatCurrent).toBe(0);
    close(p.model.pbs, 0.1); close(p.model.PhiBS, 0.01);
  });
  it.each([-1, 1])('resolves missing threshold from VFB for polarity %s', type => {
    const model = { ...card, type, vfb: -0.9 } as Record<string, number>;
    delete model.vth0;
    const p = run(model);
    close(p.size.vth0, type * (-0.9 + p.size.phi + p.size.k1 * p.size.sqrtPhi));
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid operating Kelvin %s', temperature => {
    expect(() => run(card, geometry, temperature)).toThrow(InvalidCircuitError);
  });
  it('rejects nonpositive effective dimensions', () => {
    expect(() => run({ ...card, lint: 1e-6 })).toThrow(InvalidCircuitError);
    expect(() => run({ ...card, dwj: 2e-6 })).toThrow(InvalidCircuitError);
  });
  it.each([1, 2, 3])('retains fail-closed TEMPMOD=%s', tempmod => {
    expect(() => run({ ...card, tempmod })).toThrow(UnsupportedModelParameterError);
  });
  it('rejects enabled unported trap-assisted junction current and DTEMP', () => {
    expect(() => run({ ...card, jtss: 1e-7 })).toThrow(UnsupportedModelParameterError);
    expect(() => run(card, { ...geometry, dtemp: 10 })).toThrow(UnsupportedModelParameterError);
  });
});
