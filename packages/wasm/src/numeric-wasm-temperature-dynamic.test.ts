// Original project-authored fixtures and test source, MIT.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const rectifier = 'V1 in 0 SIN(0 2 1k)\nR1 in a 100 TC1=0.001 TC2=1u\nD1 a out junction\nR2 out 0 thermal 1k\nC1 out 0 100n\n.model thermal R(TC1=0.002 TC2=2u TNOM=40)\n.tran 1u 2m';
const biasedRc = 'V1 in 0 DC 2 AC 1\nR1 in out 1k TC1=0.001 TC2=1u\nD1 out 0 junction\nC1 out 0 10n\n.ac dec 5 10 1Meg';
const model = '.model junction D(IS=1e-14 N=1.2 RS=2 CJO=20p VJ=0.7 M=0.4 TT=2n EG=1.08 XTI=2.5 TNOM=35)';
const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });

// Compare every sample, including exact agreement for zero reference values.
function relativeError(actual: number, expected: number): number {
  const delta = Math.abs(actual - expected);
  return expected === 0 ? (delta === 0 ? 0 : Infinity) : delta / Math.abs(expected);
}

describe('WASM resistor/diode TEMP/TNOM transient and AC', () => {
  it.each([75, -20].flatMap(temperature => [
    { temperature, name: 'rectifier', source: rectifier },
    { temperature, name: 'biased RC', source: biasedRc },
  ]))('matches every $name sample at $temperature C', async ({ temperature, name, source }) => {
    const input = request(`${source}\n${model}\n.options TEMP=${temperature} TNOM=27`);
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const response = await engine.simulate(input, { requestId: 'temperature-dynamic' });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      if (!response.ok) throw new Error(response.error.message);
      expect(response.metadata.backend).toBe('spice-ts-wasm');
      const actual = response.data.analyses[0];
      const reference = (await simulateProtocolV1(input)).analyses[0];
      let maximum = 0;
      let samples = 0;
      if (actual?.type === 'tran' && reference?.type === 'tran') {
        expect(actual.timeS).toEqual(reference.timeS);
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(actual[field])).toEqual(Object.keys(reference[field]));
          for (const [signal, values] of Object.entries(reference[field])) {
            expect(actual[field][signal]).toHaveLength(values.length);
            values.forEach((value, i) => {
              maximum = Math.max(maximum, relativeError(actual[field][signal]![i]!, value));
              samples++;
            });
          }
        }
      } else if (actual?.type === 'ac' && reference?.type === 'ac') {
        expect(actual.frequencyHz).toEqual(reference.frequencyHz);
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          expect(Object.keys(actual[field])).toEqual(Object.keys(reference[field]));
          for (const [signal, values] of Object.entries(reference[field])) {
            expect(actual[field][signal]).toHaveLength(values.length);
            values.forEach((value, i) => {
              for (const key of ['magnitude', 'phaseDegrees'] as const) {
                maximum = Math.max(maximum, relativeError(actual[field][signal]![i]![key], value[key]));
                samples++;
              }
            });
          }
        }
      } else throw new Error('Expected matching transient or AC analyses');
      console.log(`${name} TEMP=${temperature}: samples=${samples} maxRelativeError=${maximum}`);
      expect(samples).toBeGreaterThan(0);
      expect(maximum).toBeLessThanOrEqual(1e-9);
    } finally { await engine.close(); }
  });

  it.each([
    'Q1 out in 0 device\n.model device NPN(IS=1e-15 BF=100)',
    'M1 out in 0 0 device W=10u L=1u\n.model device NMOS(LEVEL=1 VTO=0.7 KP=100u)',
    'J1 out in 0 device\n.model device NJF(VTO=-2 BETA=1m)',
  ])('keeps transistor temperature rejected for %s', async device => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const control of ['.tran 1u 10u', '.ac lin 2 1 10']) {
        const source = `V1 in 0 ${control.startsWith('.ac') ? 'DC 1 AC 1' : '1'}\nR1 out 0 1k\n${device}\n.options TEMP=75 TNOM=27\n${control}`;
        expect(await engine.simulate(request(source), { requestId: 'temperature-guard' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'circuit-temperature' } },
        });
      }
    } finally { await engine.close(); }
  });
});
