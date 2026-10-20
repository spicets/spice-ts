import { describe, it, expect } from 'vitest';
import {
  BSIM3_REVISION, bsim3Revision, computeBsim3Size, resolveBsim3Model, EPSOX, isSupportedBsim3Version,
} from './bsim3v3-params.js';

describe('BSIM3v3 model defaults (ngspice-47 b3set.c)', () => {
  it('applies the b3set.c defaults for an empty NMOS card', () => {
    const model = resolveBsim3Model({ LEVEL: 49 }, 1);
    expect(model.tox).toBe(150e-10);
    expect(model.cox).toBeCloseTo(EPSOX / 150e-10, 20);
    expect(model.values.vth0).toBe(0.7);
    expect(model.values.u0).toBe(0.067);
    expect(model.values.vsat).toBe(8.0e4);
    expect(model.values.rdsw).toBe(0);
    expect(model.values.nfactor).toBe(1);
    expect(model.values.dsub).toBe(model.values.drout);
    expect(model.mobMod).toBe(1);
  });

  it('uses the PMOS type-dependent defaults', () => {
    const model = resolveBsim3Model({}, -1);
    expect(model.values.vth0).toBe(-0.7);
    expect(model.values.u0).toBe(0.025);
  });

  it('accepts upper-case card names, the vtho alias and converts NCH > 1e20 from m^-3', () => {
    const model = resolveBsim3Model({ VTHO: 0.4, NCH: 2.4e23, PDIBLC1: 0.2 }, 1);
    expect(model.values.vth0).toBe(0.4);
    expect(model.values.nch).toBeCloseTo(2.4e17, 3);
    expect(model.values.pdiblc1).toBe(0.2);
    expect(model.given('vth0')).toBe(true);
    expect(model.given('k1')).toBe(false);
  });

  it('defaults the overlap capacitances from XJ and Cox, and CF from TOX', () => {
    const model = resolveBsim3Model({ TOX: 4e-9 }, 1);
    expect(model.values.cgso).toBeCloseTo(0.6 * 0.15e-6 * EPSOX / 4e-9, 20);
    expect(model.values.cf).toBeCloseTo(2 * EPSOX / 3.141592654 * Math.log(1 + 0.4e-6 / 4e-9), 20);
  });
});

describe('BSIM3v3 size-dependent parameters (ngspice-47 b3temp.c)', () => {
  it('defaults W = L = 5 um and AD/AS/PD/PS = 0', () => {
    const size = computeBsim3Size(resolveBsim3Model({}, 1), {});
    expect(size.leff).toBeCloseTo(5e-6, 15);
    expect(size.weff).toBeCloseTo(5e-6, 15);
    expect(size.drainArea).toBe(0);
    expect(size.sourcePerimeter).toBe(0);
    expect(size.sourceSatCurrent).toBe(1e-14);
    expect(Object.isFrozen(size)).toBe(true);
    expect(Reflect.set(size, 'leff', 1)).toBe(false);
    expect(size.leff).toBeCloseTo(5e-6, 15);
  });

  it('computes Leff and Weff from L, W, LINT, WINT', () => {
    const size = computeBsim3Size(resolveBsim3Model({ LINT: 20e-9, WINT: 10e-9 }, 1), { W: 1e-6, L: 0.18e-6 });
    expect(size.leff).toBeCloseTo(0.18e-6 - 2 * 20e-9, 15);
    expect(size.weff).toBeCloseTo(1e-6 - 2 * 10e-9, 15);
  });

  it('rejects a non-positive effective channel length', () => {
    expect(() => computeBsim3Size(resolveBsim3Model({ LINT: 0.2e-6 }, 1), { W: 1e-6, L: 0.18e-6 }))
      .toThrow(/Effective channel length/);
  });

  it('bins L-dependent parameters with BINUNIT=1 (micron) scaling', () => {
    const model = resolveBsim3Model({ VTH0: 0.5, LVTH0: 0.02 }, 1);
    const size = computeBsim3Size(model, { W: 1e-6, L: 0.5e-6 });
    expect(size.vth0).toBeCloseTo(0.5 + 0.02 * 1e-6 / 0.5e-6, 12);
  });

  it('computes phi and Vbi in b3temp.c units (1e20 * NCH / ni^2)', () => {
    const size = computeBsim3Size(resolveBsim3Model({ NCH: 1.7e17 }, 1), { W: 1e-6, L: 1e-6 });
    const tnom = 300.15;
    const vtm0 = 8.617087e-5 * tnom;
    const eg0 = 1.16 - 7.02e-4 * tnom * tnom / (tnom + 1108);
    const ni = 1.45e10 * Math.exp(21.5565981 - eg0 / (2 * vtm0));
    expect(size.phi).toBeCloseTo(2 * vtm0 * Math.log(1.7e17 / ni), 12);
    expect(size.vbi).toBeCloseTo(vtm0 * Math.log(1e20 * 1.7e17 / (ni * ni)), 12);
    expect(size.vbi).toBeGreaterThan(size.phi);
  });

  it('derives K1/K2 from GAMMA1/GAMMA2 when neither K1 nor K2 is given', () => {
    const size = computeBsim3Size(resolveBsim3Model({ GAMMA1: 0.6, GAMMA2: 0.6 }, 1), { W: 1e-6, L: 1e-6 });
    // Equal gammas: K2 = 0 and K1 = GAMMA2.
    expect(size.k2).toBeCloseTo(0, 12);
    expect(size.k1).toBeCloseTo(0.6, 12);
  });

  it('applies DELVTO to the instance threshold', () => {
    const model = resolveBsim3Model({ VTH0: -0.5 }, -1);
    const size = computeBsim3Size(model, { DELVTO: 0.05 });
    expect(size.instVth0).toBeCloseTo(-0.45, 12);
  });
});

describe('BSIM3 VERSION selection', () => {
  it('accepts absent, default, 3.2.x and 3.3.x versions only (ngspice inpdomod.c)', () => {
    expect(isSupportedBsim3Version(undefined)).toBe(true);
    expect(isSupportedBsim3Version('3.3.0')).toBe(true);
    expect(isSupportedBsim3Version('3.2.4')).toBe(true);
    for (const version of ['3.1', '3.0', '3.0.1', '5.0', '4.5']) expect(isSupportedBsim3Version(version)).toBe(false);
  });

  it('maps VERSION= strings to the b3v32set.c revisions', () => {
    const cases: [string | undefined, number][] = [
      [undefined, BSIM3_REVISION.V330], ['3.3.0', BSIM3_REVISION.V330], ['Default', BSIM3_REVISION.V330],
      ['3.2.4', BSIM3_REVISION.V324], ['3.24', BSIM3_REVISION.V324], ['3.240', BSIM3_REVISION.V324],
      ['3.2.3', BSIM3_REVISION.V323], ['3.23', BSIM3_REVISION.V323],
      ['3.2.2', BSIM3_REVISION.V322], ['3.22', BSIM3_REVISION.V322],
      // strcmp, not a prefix match, for the dotted forms: anything else starting with 3.2 is revision 3.2.
      ['3.2', BSIM3_REVISION.V32], ['3.20', BSIM3_REVISION.V32], ['3.2.4.1', BSIM3_REVISION.V32],
      ['3.2.1', BSIM3_REVISION.V32], ['3.21', BSIM3_REVISION.V32],
    ];
    for (const [version, revision] of cases) expect(bsim3Revision(version), version).toBe(revision);
    expect(resolveBsim3Model({}, 1, undefined, '3.2.2').revision).toBe(BSIM3_REVISION.V322);
    expect(() => resolveBsim3Model({}, 1, undefined, '3.1')).toThrow(RangeError);
  });

  it('scales L by LMLT for the 3.2.x revisions only (b3v32set.c)', () => {
    const card = { LMLT: 0.9, LINT: 0 };
    const v32 = computeBsim3Size(resolveBsim3Model(card, 1, undefined, '3.2.4'), { W: 1e-6, L: 1e-6 });
    const v33 = computeBsim3Size(resolveBsim3Model(card, 1), { W: 1e-6, L: 1e-6 });
    expect(v32.leff).toBeCloseTo(0.9e-6, 18);
    expect(v33.leff).toBeCloseTo(1e-6, 18);
  });

  it('leaves IsEvjsm unset for revision 3.2 (b3v32temp.c)', () => {
    const inst = { W: 1e-6, L: 1e-6, AS: 1e-12, AD: 1e-12 };
    const v32 = computeBsim3Size(resolveBsim3Model({ IJTH: 1e-9 }, 1, undefined, '3.2'), inst);
    const v322 = computeBsim3Size(resolveBsim3Model({ IJTH: 1e-9 }, 1, undefined, '3.2.2'), inst);
    expect(v32.vjsm).toBe(v322.vjsm);
    expect(v32.vjsm).toBeGreaterThan(0);
    expect(v32.IsEvjsm).toBe(0);
    expect(v322.IsEvjsm).toBeGreaterThan(0);
  });
});
