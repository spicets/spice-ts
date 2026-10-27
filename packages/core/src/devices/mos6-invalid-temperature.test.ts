import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../parser/index.js';
import { MOS6, resolveMOS6Model } from './mos6.js';

const model = resolveMOS6Model('MOD', { VTO: 0.7, GAMMA: 0.4 }, 1);
const invalidTemperatures = [-300, -273.15, NaN, Infinity, -Infinity];
const invalidTemperatureError = { code: 'INVALID_CIRCUIT', message: expect.stringContaining('M1') };

describe('MOS6 invalid effective instance temperatures', () => {
  it.each(invalidTemperatures)('rejects constructor TEMP=%s', temperature => {
    expect(() => new MOS6('M1', [1, 2, 0, 0], model, { TEMP: temperature }))
      .toThrowError(expect.objectContaining(invalidTemperatureError));
  });

  it.each(invalidTemperatures)('rejects constructor circuit + DTEMP yielding %s', temperature => {
    expect(() => new MOS6('M1', [1, 2, 0, 0], model, { DTEMP: temperature - 40 }, 40))
      .toThrowError(expect.objectContaining(invalidTemperatureError));
  });

  it.each(['TEMP=-300', 'DTEMP=-400'])('rejects invalid compiled fixture %s', parameter => {
    const deck = readFileSync(new URL('../../../../benchmarks/fixtures/issue-1847/n-temp.cir', import.meta.url), 'utf8');
    expect(() => parse(deck.replace('TEMP=75', parameter)).compile())
      .toThrowError(expect.objectContaining(invalidTemperatureError));
  });

  it.each(invalidTemperatures)('preserves the last valid state after a hook yielding %s', temperature => {
    const device = new MOS6('M1', [1, 2, 0, 0], model, { DTEMP: 30 }, 40);
    const before = device.evaluateChannel(2, 1, -0.4);
    expect(Object.values(before).every(Number.isFinite)).toBe(true);
    expect(() => device.setTemperature(temperature - 30))
      .toThrowError(expect.objectContaining(invalidTemperatureError));
    expect(device.getCircuitTemperature()).toBe(40);
    expect(device.getTemperature()).toBe(70);
    expect(device.evaluateChannel(2, 1, -0.4)).toEqual(before);
    device.setTemperature(50);
    expect(device.getTemperature()).toBe(80);
  });

  it('ignores invalid DTEMP when explicit TEMP is valid', () => {
    for (const DTEMP of invalidTemperatures) {
      const device = new MOS6('M1', [1, 2, 0, 0], model, { TEMP: 75, DTEMP }, 40);
      device.setTemperature(50);
      expect(device.getCircuitTemperature()).toBe(50);
      expect(device.getTemperature()).toBe(75);
      expect(Object.values(device.evaluateChannel(2, 1, -0.4)).every(Number.isFinite)).toBe(true);
    }
  });
});
