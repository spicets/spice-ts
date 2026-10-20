import { describe, expect, it } from 'vitest';
import { simulate } from '../index.js';
import { EKV26 } from './ekv.js';

const relative = (actual: number, expected: number) =>
  expect(Math.abs((actual - expected) / expected)).toBeLessThanOrEqual(1e-12);

const deck = (polarity: number, temperature: number) => `EKV intrinsic temperature
VD d 0 ${polarity}
VG g 0 ${polarity * 0.3}
M1 d g 0 0 m L=1u W=1u
.model m ${polarity === 1 ? 'NMOS' : 'PMOS'} LEVEL=260 TNOM=27 VTO=${polarity * 0.5} TCV=${polarity * 0.001} BEX=-1.5 UCEX=0.8 IBBT=0.0009 E0=0 Q0=0 LETA=0 WETA=0
.options TEMP=${temperature}
.op
.end`;

describe('EKV intrinsic temperature scaling', () => {
  it.each([1, -1])('applies EPFL equations 7, 17-21 at 125 C, polarity=%s', polarity => {
    const model = new EKV26('m', [0, 1, 2, 3], {
      TNOM: 27, VTO: polarity * 0.5, TCV: polarity * 0.001,
      KP: 150e-6, BEX: -1.5, UCRIT: 2e6, UCEX: 0.8, IBB: 4e8, IBBT: 0.0009,
    }, {}, polarity);
    model.setTemperature(125);
    // Independent substitutions in the EPFL equations, Kelvin ratio (not Celsius).
    const scaled = model.temperatureParameters;
    relative(scaled.VTO, polarity * (0.5 - 0.001 * 98));
    relative(scaled.KP, 150e-6 * (398.15 / 300.15) ** -1.5);
    relative(scaled.UCRIT, 2e6 * (398.15 / 300.15) ** 0.8);
    relative(scaled.IBB, 4e8 * (1 + 0.0009 * 98));
    relative(scaled.vt, 8.617333262145e-5 * 398.15);
    const eg = (t: number) => 1.16 - 0.000702 * t * t / (t + 1108);
    relative(scaled.PHI, 0.5 * (398.15 / 300.15) - 3 * scaled.vt * Math.log(398.15 / 300.15)
      - eg(300.15) * (398.15 / 300.15) + eg(398.15));
    expect(model.getTemperature()).toBe(125);
    expect(model.params.VTO).toBe(polarity * 0.5);
    expect(model.params.KP).toBe(150e-6);
  });

  it.each([1, -1])('increases weak-inversion .op drain-current magnitude when heated, polarity=%s', async polarity => {
    const cold = await simulate(deck(polarity, 27));
    const hot = await simulate(deck(polarity, 125));
    expect(Math.abs(hot.dc!.current('VD'))).toBeGreaterThan(Math.abs(cold.dc!.current('VD')));
  });

  it('scales from nominal parameters without cumulative drift and restores bit-identical current/charges', () => {
    const model = new EKV26('m', [0, 1, 2, 3], {});
    const point: [number, number, number, number] = [1, 0.6, 0, -0.2];
    const nominal = model.evaluate(point);
    const charges = model.evaluateCharges(point);
    model.setTemperature(125);
    const hot = model.evaluate(point);
    const hotCharges = model.evaluateCharges(point);
    model.setTemperature(40);
    model.setTemperature(125);
    expect(model.evaluate(point)).toEqual(hot);
    expect(model.evaluateCharges(point)).toEqual(hotCharges);
    model.setTemperature(27);
    expect(model.evaluate(point)).toEqual(nominal);
    expect(model.evaluateCharges(point)).toEqual(charges);
  });

  it.each([1, -1])('retains analytic current and charge derivatives at 125 C, polarity=%s', polarity => {
    const model = new EKV26('m', [0, 1, 2, 3], { VTO: polarity * 0.5 }, {}, polarity);
    model.setTemperature(125);
    const point: [number, number, number, number] = [polarity, 0.7 * polarity, 0, -0.2 * polarity];
    const current = model.evaluate(point);
    const charges = model.evaluateCharges(point);
    for (let terminal = 0; terminal < 4; terminal++) {
      const plus: typeof point = [...point];
      const minus: typeof point = [...point];
      plus[terminal] += 1e-6;
      minus[terminal] -= 1e-6;
      const fd = (model.evaluate(plus).current - model.evaluate(minus).current) / 2e-6;
      expect(Math.abs(fd - current.derivatives[terminal])).toBeLessThan(1e-12 + 2e-5 * Math.abs(fd));
      const qPlus = model.evaluateCharges(plus).charges;
      const qMinus = model.evaluateCharges(minus).charges;
      for (let row = 0; row < 4; row++) {
        const derivative = (qPlus[row] - qMinus[row]) / 2e-6;
        expect(Math.abs(derivative - charges.jacobian[row][terminal])).toBeLessThan(1e-22 + 2e-5 * Math.abs(derivative));
      }
    }
  });

  it('uses physical PMOS defaults and accepts explicit zero intrinsic exponents', () => {
    const p = new EKV26('p', [0, 1, 2, 3], { VTO: -0.5 }, {}, -1);
    p.setTemperature(125);
    relative(p.temperatureParameters.VTO, -0.402);
    const zero = new EKV26('n', [0, 1, 2, 3], { TCV: 0, BEX: 0, UCEX: 0, IBBT: 0 });
    zero.setTemperature(125);
    for (const key of ['VTO', 'KP', 'UCRIT', 'IBB'] as const) expect(zero.temperatureParameters[key]).toBe(zero.params[key]);
  });

  it('rejects invalid scaled fields atomically', () => {
    const model = new EKV26('m', [0, 1, 2, 3], { IBBT: -1 });
    const nominal = model.evaluate([1, 0.5, 0, 0]);
    expect(() => model.setTemperature(125)).toThrow();
    expect(model.getTemperature()).toBe(27);
    expect(model.evaluate([1, 0.5, 0, 0])).toEqual(nominal);
  });

  it.each(['TP_XTI', 'TP_CJ', 'TP_PB', 'XD_JS', 'XD_CJ', 'AD'])('rejects off-nominal junction term %s by name', parameter => {
    const model = new EKV26('m', [0, 1, 2, 3], { [parameter]: 1 });
    expect(() => model.setTemperature(125)).toThrow(expect.objectContaining({
      code: 'UNSUPPORTED_TEMPERATURE', parameter, temperature: 125, deviceName: 'm',
    }));
    expect(model.getTemperature()).toBe(27);
  });

  it.each([NaN, Infinity, -273.15, -300])('rejects invalid device temperature %s without changing state', temperature => {
    const model = new EKV26('m', [0, 1, 2, 3], {});
    expect(() => model.setTemperature(temperature)).toThrow();
    expect(model.getTemperature()).toBe(27);
  });
});
