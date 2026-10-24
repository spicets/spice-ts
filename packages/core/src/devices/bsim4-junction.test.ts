import { describe, expect, it } from 'vitest';
import { UnsupportedModelParameterError } from '../errors.js';
import { evaluateBsim4Junction, setupBsim4Junction } from './bsim4-junction.js';

const geometry = { area: 2e-12, perimeter: 3e-6, gateEdge: 1e-6 };
const input = (parameters: Record<string, number> = {}) => ({
  terminal: 'source' as const, parameters, geometry,
});

describe('BSIM4 default DIOMOD=1 standalone DC junction subset', () => {
  it('ports source defaults and default drain inheritance', () => {
    const source = setupBsim4Junction(input());
    const drain = setupBsim4Junction({ ...input(), terminal: 'drain' });
    expect(source.saturationCurrent).toBe(2e-16);
    expect(source.nvtm).toBeCloseTo(8.617087e-5 * 300.15, 15);
    expect(drain).toEqual(source);
    expect(source.forwardVoltage).toBeCloseTo(source.nvtm * Math.log(1 + 0.1 / 2e-16), 15);
  });

  it('inherits drain densities/emission/temperature exponent/limit from source, with independent overrides', () => {
    const parameters = { jss: 0.01, jsws: 2e-7, jswgs: 3e-7, njs: 1.2, xtis: 4, ijthsfwd: 0.02 };
    const source = setupBsim4Junction(input(parameters));
    const drain = setupBsim4Junction({ ...input(parameters), terminal: 'drain' });
    expect(drain).toEqual(source);
    expect(source.saturationCurrent).toBeCloseTo(2e-14 + 6e-13 + 3e-13, 25);
    const overridden = setupBsim4Junction({ ...input({ ...parameters, jsd: 0, jswd: 0, jswgd: 0 }), terminal: 'drain' });
    expect(overridden.saturationCurrent).toBe(0);
  });

  it('does not fabricate 1e-14 A or gate-edge current with zero area and perimeter', () => {
    const model = setupBsim4Junction({ ...input({ jswgs: 1 }), geometry: { ...geometry, area: 0, perimeter: 0 } });
    expect(model.saturationCurrent).toBe(0);
    expect(evaluateBsim4Junction(model, 0.4, 1e-12)).toEqual({ current: 4e-13, conductance: 1e-12 });
  });

  it('ports negative density clamping and nonpositive forward-limit reset', () => {
    expect(setupBsim4Junction(input({ jss: -1, jsws: -2 })).saturationCurrent).toBe(0);
    const model = setupBsim4Junction(input({ ijthsfwd: -1 }));
    expect(model.forwardVoltage).toBe(0);
    const result = evaluateBsim4Junction(model, 0.5, 0);
    expect(result.conductance).toBe(model.saturationCurrent / model.nvtm);
    expect(result.current).toBe(result.conductance * 0.5);
  });

  it.each([-40, 27, 160])('uses the silicon junction temperature law at %s C', temperatureC => {
    const model = setupBsim4Junction({ ...input(), temperatureC });
    const t = temperatureC + 273.15;
    const tn = 300.15;
    const eg = (k: number) => 1.16 - 7.02e-4 * k * k / (k + 1108);
    const scale = Math.exp(eg(tn) / (8.617087e-5 * tn) - eg(t) / (8.617087e-5 * t) + 3 * Math.log(t / tn));
    expect(model.saturationCurrent).toBeCloseTo(2e-16 * scale, 25);
    expect(model.nvtm).toBeCloseTo(8.617087e-5 * t, 15);
  });

  it('uses TNOM in Celsius, independently of circuit temperature', () => {
    const model = setupBsim4Junction({ ...input({ tnom: 50 }), temperatureC: 50 });
    expect(model.saturationCurrent).toBe(2e-16);
    expect(model.nvtm).toBe(8.617087e-5 * 323.15);
  });

  it('evaluates zero, forward exponential, reverse clamp and forward linear continuation', () => {
    const model = setupBsim4Junction(input());
    const gmin = 1e-12;
    expect(evaluateBsim4Junction(model, 0, gmin)).toEqual({ current: 0, conductance: model.saturationCurrent / model.nvtm + gmin });
    const v = 0.4;
    expect(evaluateBsim4Junction(model, v, gmin)).toEqual({
      current: model.saturationCurrent * (Math.exp(v / model.nvtm) - 1) + gmin * v,
      conductance: model.saturationCurrent * Math.exp(v / model.nvtm) / model.nvtm + gmin,
    });
    expect(evaluateBsim4Junction(model, -2, gmin)).toEqual({ current: model.saturationCurrent * (1.713908431e-15 - 1) - 2 * gmin, conductance: gmin });
    const beyond = model.forwardVoltage + 0.1;
    const slope = model.forwardExponentialCurrent / model.nvtm;
    expect(evaluateBsim4Junction(model, beyond, gmin)).toEqual({
      current: model.forwardExponentialCurrent - model.saturationCurrent + slope * (beyond - model.forwardVoltage) + gmin * beyond,
      conductance: slope + gmin,
    });
  });

  it.each([-1, -0.2, 0, 0.3, 0.9, 1.2])('returns the analytic Newton derivative at %s V', voltage => {
    const model = setupBsim4Junction(input());
    const h = 1e-6;
    const numeric = (evaluateBsim4Junction(model, voltage + h, 1e-12).current - evaluateBsim4Junction(model, voltage - h, 1e-12).current) / (2 * h);
    const analytic = evaluateBsim4Junction(model, voltage, 1e-12).conductance;
    expect(Math.abs(numeric - analytic) / Math.max(1e-12, Math.abs(analytic))).toBeLessThan(1e-8);
  });

  it.each(['transient', 'ac', 'noise', 'charge', 'capacitance'])('rejects %s requests before evaluation', analysis => {
    expect(() => setupBsim4Junction({ ...input(), analysis })).toThrow(UnsupportedModelParameterError);
  });
  it.each(['trnqsmod', 'acnqsmod', 'sa', 'sb', 'saref', 'rgatemod', 'rbodymod', 'mtrlmod', 'jtss', 'capmod', 'vth0', 'typo'])('never silently accepts unported parameter %s', parameter => {
    expect(() => setupBsim4Junction(input({ [parameter]: 1 }))).toThrow(UnsupportedModelParameterError);
  });
  it.each(['source', 'drain'] as const)('DIOMOD=0 evaluates exponential and breakdown laws for %s', terminal => {
    const model = setupBsim4Junction({ ...input({ diomod: 0, bvs: 0.6, xjbvs: 2 }), terminal });
    for (const voltage of [-0.8, -0.6, 0, 0.4, 1]) {
      const ev = Math.exp(voltage / model.nvtm);
      const breakdown = 2 * Math.exp(-(0.6 + voltage) / model.nvtm);
      const result = evaluateBsim4Junction(model, voltage, 1e-12);
      expect(result.current).toBeCloseTo(model.saturationCurrent * (ev + 2 * Math.exp(-0.6 / model.nvtm) - breakdown - 1) + 1e-12 * voltage, 18);
      expect(result.conductance).toBeCloseTo(model.saturationCurrent * (ev + breakdown) / model.nvtm + 1e-12, 16);
    }
  });

  it.each(['source', 'drain'] as const)('DIOMOD=2 evaluates all three regions and Newton slopes for %s', terminal => {
    const model = setupBsim4Junction({ ...input({ diomod: 2, bvs: 0.6, xjbvs: 2, ijthsfwd: 1e-6, ijthsrev: 1e-6 }), terminal });
    const is = model.saturationCurrent;
    const nv = model.nvtm;
    const x = 2 * Math.exp(-0.6 / nv);
    const reverseVoltage = -0.6 - nv * Math.log((1e-6 / is - 1) / 2);
    const reverseExp = 2 * Math.exp(-(0.6 + reverseVoltage) / nv);
    for (const voltage of [reverseVoltage - 0.1, reverseVoltage, -0.7, -0.2, 0, 0.4, model.forwardVoltage, model.forwardVoltage + 0.1]) {
      let expected: number;
      if (voltage < reverseVoltage) {
        expected = (1.713908431e-15 - 1) * (is * (1 + reverseExp) - is * reverseExp / nv * (voltage - reverseVoltage));
      } else if (voltage <= model.forwardVoltage) {
        expected = is * ((voltage / nv < -34 ? 1.713908431e-15 : Math.exp(voltage / nv)) + x - 1 - 2 * Math.exp(-(0.6 + voltage) / nv));
      } else {
        const ev = Math.exp(model.forwardVoltage / nv);
        expected = is * (ev - x / ev + x - 1) + is * (ev + x / ev) / nv * (voltage - model.forwardVoltage);
      }
      const actual = evaluateBsim4Junction(model, voltage, 1e-12);
      expect(actual.current).toBeCloseTo(expected + 1e-12 * voltage, 18);
      const h = 1e-7;
      const numeric = (evaluateBsim4Junction(model, voltage + h, 1e-12).current - evaluateBsim4Junction(model, voltage - h, 1e-12).current) / (2 * h);
      expect(Math.abs(numeric - actual.conductance) / Math.max(1e-12, actual.conductance)).toBeLessThan(3e-6);
    }
  });

  it.each([-1, 3, 1.5])('rejects invalid DIOMOD=%s rather than resetting', diomod => {
    expect(() => setupBsim4Junction(input({ diomod }))).toThrow(UnsupportedModelParameterError);
  });
  it.each(['4.3', '4.7', 'other'])('rejects VERSION=%s', version => {
    expect(() => setupBsim4Junction({ ...input(), version })).toThrow(UnsupportedModelParameterError);
  });
  it.each(['4.8', '4.8.2', '4.8.3', 'default'])('accepts selected family VERSION=%s', version => {
    expect(() => setupBsim4Junction({ ...input(), version })).not.toThrow();
  });
  it('rejects nonfinite inputs, invalid geometry/emission/temperature and duplicate case aliases', () => {
    const invalid: Record<string, number>[] = [{ njs: 0 }, { njs: -1 }, { jss: Infinity }, { diomod: NaN }, { tnom: -273.15 }, { JSS: 1, jss: 2 }];
    for (const parameters of invalid) {
      expect(() => setupBsim4Junction(input(parameters))).toThrow();
    }
    expect(() => setupBsim4Junction({ ...input(), temperatureC: NaN })).toThrow();
    expect(() => setupBsim4Junction({ ...input(), geometry: { ...geometry, area: -1 } })).toThrow();
    const model = setupBsim4Junction(input());
    expect(() => evaluateBsim4Junction(model, Infinity, 0)).toThrow();
    expect(() => evaluateBsim4Junction(model, 0, -1)).toThrow();
  });
});
