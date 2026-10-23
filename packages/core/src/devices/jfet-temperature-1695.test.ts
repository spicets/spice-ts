import { describe, expect, it } from 'vitest';
import { JFET, resolveNJFETParams } from './jfet.js';
import { parse } from '../parser/index.js';
import { simulate } from '../index.js';
import { UnsupportedModelParameterError, UnsupportedTemperatureError } from '../errors.js';

// Independent transcription of ngspice a80f6e3e95d51534905b1f23410a951802666656:
// jfettemp.c:JFETtemp and jfet2temp.c:JFET2temp (kelvin throughout).
const kq = 1.38064852e-23 / 1.6021766208e-19;
function junction(t: number, tn: number, pb: number) {
  const correction = (k: number) => -2 * kq * k * (1.5 * Math.log(k / 300.15)
    + (- (1.16 - 7.02e-4 * k * k / (k + 1108)) / (2 * k) + 1.1150877 / 600.3) / kq);
  const pbo = (pb - correction(tn)) / (tn / 300.15);
  const potential = t / 300.15 * pbo + correction(t);
  const cap = (1 + 0.5 * (4e-4 * (t - 300.15) - (potential - pbo) / pbo))
    / (1 + 0.5 * (4e-4 * (tn - 300.15) - (pb - pbo) / pbo));
  return { potential, cap };
}

describe('JFET temperature preprocessing (#1695)', () => {
  it.each([1, 2])('level %i uses per-instance thermal voltage including N', async level => {
    for (const type of ['NJF', 'PJF']) {
      const sign = type === 'NJF' ? 1 : -1;
      const result = await simulate(`thermal voltage\nVd d 0 0\nVg g 0 ${sign * 0.2}\nJ1 d g 0 JM TEMP=80 AREA=2 M=3 OFF IC=1,-0.5\n.model JM ${type} LEVEL=${level} N=1.3 IS=2e-14\n.options temp=40\n.op`);
      const t = 353.15;
      const is = 2e-14 * Math.exp((t / 300.15 - 1) * 1.11 / (kq * t * (level === 1 ? 1.3 : 1)));
      const expected = -sign * 2 * (6 * is * Math.expm1(0.2 / (kq * t * 1.3)) + 3e-12 * 0.2);
      expect(result.dc!.current('Vg') / expected).toBeCloseTo(1, 7);
    }
  });

  it.each([1, 2])('level %i resolves environment temperature and nominal overrides', level => {
    const environment = { temperatureC: 80, nominalTemperatureC: 40 };
    const implicit = new JFET('J1', [], { LEVEL: level }, 1, {}, environment);
    const explicit = new JFET('J1', [], { LEVEL: level, TNOM: 40 }, 1, { TEMP: 80 });
    expect(implicit.params).toEqual(explicit.params);
    const nominal = new JFET('J1', [], { LEVEL: level, TNOM: 80 }, 1, {}, environment);
    expect(nominal.params.IS).toBe(1e-14);
  });

  it('uses level-1 coefficient precedence and explicit-XTI semantics', () => {
    const card = { TCV: 0.01, VTOTC: 0.02, BEX: -2, BETATCE: -0.5, XTI: 2, EG: 1.05, N: 1.2 };
    const d = new JFET('J1', [], card, 1, { TEMP: 77 });
    expect(d.params.VTO).toBeCloseTo(-1, 13);
    expect(d.params.BETA / 1e-4).toBeCloseTo(Math.pow(1.01, -25), 13);
    expect(d.params.IS / 1e-14).toBeCloseTo(Math.exp((350.15 / 300.15 - 1) * 1.05 / (kq * 350.15 * 1.2)) * Math.pow(350.15 / 300.15, 2), 10);
    const fallback = new JFET('J1', [], { TCV: 0.01, BEX: -2 }, 1, { TEMP: 77 });
    expect(fallback.params.VTO).toBeCloseTo(-2.5, 13);
    expect(fallback.params.BETA / 1e-4).toBeCloseTo(Math.pow(350.15 / 300.15, -2), 13);
    expect(resolveNJFETParams({}).XTI).toBe(3);
  });

  it('retains structured UnsupportedTemperatureError for unsupported devices', () => {
    expect(() => parse('unsupported\nV1 d 0 1\nM1 d d 0 0 MM\n.model MM NMOS LEVEL=6\n.temp 80\n.op').compile()).toThrow(UnsupportedTemperatureError);
  });

  it.each([1, 2])('level %i rejects unknown model tokens structurally', level => {
    expect(() => parse(`unknown\nJ1 d g 0 JM\n.model JM NJF LEVEL=${level} BOGUS=1\n.op`).compile())
      .toThrow(UnsupportedModelParameterError);
  });

  it.each([1, 2])('level %i circuit TEMP reaches devices unless instance TEMP overrides it', async level => {
    const deck = (instance: string, temperature: string) => `precedence\nVd d 0 3\nVg g 0 -1\nJ1 d g 0 JM ${instance}\n.model JM NJF LEVEL=${level} IS=1e-10\n${temperature}\n.op`;
    const warm = await simulate(deck('', '.temp 80'));
    const explicit = await simulate(deck('TEMP=80', '.temp 40'));
    const nominal = await simulate(deck('TEMP=27', '.temp 80'));
    const plain = await simulate(deck('', ''));
    expect(warm.dc!.current('Vg')).toBe(explicit.dc!.current('Vg'));
    expect(nominal.dc!.current('Vg')).toBe(plain.dc!.current('Vg'));
    expect(Math.abs(warm.dc!.current('Vg'))).toBeGreaterThan(Math.abs(plain.dc!.current('Vg')));
  });

  it.each(['N', 'EG', 'XTI', 'TCV', 'VTOTC', 'BEX', 'BETATCE'])('validates %s by model level', name => {
    expect(() => resolveNJFETParams({ [name]: 1 })).not.toThrow();
    if (name !== 'N') expect(() => resolveNJFETParams({ LEVEL: 2, [name]: 1 })).toThrow(UnsupportedModelParameterError);
  });

  it.each([1, 2])('level %i rejects nonphysical emission coefficients', level => {
    expect(() => new JFET('J1', [], { LEVEL: level, N: 0 })).toThrow(/Invalid NJF/);
  });

  it.each([1, 2])('level %i applies junction laws before AREA/M for NJF and PJF', level => {
    for (const polarity of [1, -1] as const) {
      const model = { LEVEL: level, TNOM: 40, PB: 0.9, IS: 2e-14, CGS: 3e-12, CGD: 2e-12 };
      const device = new JFET('J1', [0, 1, -1], model, polarity,
        { TEMP: 80, AREA: 2, M: 3, OFF: true, ICVDS: 2, ICVGS: -0.5 },
        { temperatureC: 60, nominalTemperatureC: 10 });
      const expected = junction(353.15, 313.15, 0.9);
      expect(device.params.PB).toBeCloseTo(expected.potential, 13);
      expect(device.params.CGS / 18e-12).toBeCloseTo(expected.cap, 13);
      expect(device.params.CGD / 12e-12).toBeCloseTo(expected.cap, 13);
      expect(device.params.IS / 12e-14).toBeCloseTo(Math.exp((353.15 / 313.15 - 1) * 1.11 / (kq * 353.15)), 10);
      expect(model.IS).toBe(2e-14);
    }
  });
});
