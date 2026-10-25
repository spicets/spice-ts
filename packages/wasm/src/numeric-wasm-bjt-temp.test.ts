// Original project-authored NPN/PNP bias networks and tests, MIT.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const request = (source: string) => ({
  apiVersion: '1' as const, input: { format: 'spice' as const, source },
});

function circuit(polarity: string, parameters = '', capacitances = 'CJE=2p CJC=1p'): string {
  const sign = polarity === 'NPN' ? 1 : -1;
  return `VCC supply 0 ${sign * 5}
VBE input 0 DC ${sign * 1.2}
RC supply collector 1k
RB input base 100k
RE emitter 0 100
Q1 collector base emitter transistor
.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80 RB=100 RC=10 RE=2 ${capacitances} VJE=0.8 VJC=0.7 ${parameters})`;
}

const temperatures = ['.temp 75', '.temp -25', '.options TEMP=75', '.options TEMP=-25 TNOM=50'];
const fixtures = ['NPN', 'PNP'].flatMap(polarity => temperatures.flatMap(temperature =>
  ['', 'XTI=2.5 EG=1.05 XTB=0.7'].flatMap(parameters => ['op', 'dc'].map(analysis => ({
    name: `${polarity} ${temperature} ${parameters || 'defaults'} ${analysis}`,
    source: `${circuit(polarity, parameters)}\n${temperature}\n${analysis === 'op' ? '.op'
      : `.dc VBE 0 ${polarity === 'NPN' ? 1.2 : -1.2} ${polarity === 'NPN' ? 0.05 : -0.05}`}`,
  }))),
));

describe('WASM BJT circuit TEMP/TNOM', () => {
  it.each(fixtures)('matches every core node voltage and source current: $name', async ({ source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const response = await engine.simulate(request(source), { requestId: 'bjt-temperature' });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      if (!response.ok) throw new Error(response.error.message);
      expect(response.metadata.backend).toBe('spice-ts-wasm');
      const actual = response.data.analyses[0];
      const reference = (await simulateProtocolV1(request(source))).analyses[0];
      if ((actual?.type !== 'op' && actual?.type !== 'dc')
        || (reference?.type !== 'op' && reference?.type !== 'dc')) throw new Error('Expected OP/DC');
      expect(actual.type).toBe(reference.type);
      if (actual.type === 'dc' && reference.type === 'dc') {
        expect(actual.axis.name).toBe(reference.axis.name);
        expect(actual.axis.unit).toBe(reference.axis.unit);
        expect(actual.axis.values).toHaveLength(reference.axis.values.length);
        actual.axis.values.forEach((value, index) => {
          expect(Math.abs(value - reference.axis.values[index]!)).toBeLessThanOrEqual(1e-12);
        });
      }
      let maxAbsoluteError = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
        for (const [name, signal] of Object.entries(reference[field])) {
          const expected: number[] = typeof signal === 'number' ? [signal] : signal;
          const observed = actual[field][name]!;
          const values = typeof observed === 'number' ? [observed] : observed;
          expect(values).toHaveLength(expected.length);
          expected.forEach((value, index) => {
            const delta = Math.abs(values[index]! - value);
            maxAbsoluteError = Math.max(maxAbsoluteError, delta);
            expect(delta, `${field}.${name}[${index}]`).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(value));
          });
        }
      }
      console.info(`BJT temperature parity maxAbsoluteError=${maxAbsoluteError}`);
    } finally { await engine.close(); }
  });

  const dynamicFixtures = ['NPN', 'PNP'].flatMap(polarity => temperatures.flatMap(temperature =>
    ['', 'XTI=2.5 EG=1.05 XTB=0.7'].flatMap(parameters => ['', 'CJE=2p CJC=1p TF=2n'].flatMap(capacitances =>
      ['.ac lin 2 1 10', '.tran 1u 10u'].map(control => {
        const sign = polarity === 'NPN' ? 1 : -1;
        const source = circuit(polarity, parameters, capacitances).replace(
          `VBE input 0 DC ${sign * 1.2}`,
          control.startsWith('.ac') ? `VBE input 0 DC ${sign * 1.2} AC 1`
            : `VBE input 0 SIN(${sign * 1.2} ${sign * 0.01} 1k)`,
        );
        return {
          name: `${polarity} ${temperature} ${parameters || 'defaults'} ${capacitances || 'no charge'} ${control}`,
          source: `${source}\n${temperature}\n${control}`,
        };
      })),
    ),
  ));

  it.each(dynamicFixtures)('matches every core dynamic signal: $name', async ({ name, source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const response = await engine.simulate(request(source), { requestId: 'bjt-temperature-dynamic' });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      if (!response.ok) throw new Error(response.error.message);
      expect(response.metadata.backend).toBe('spice-ts-wasm');
      // simulateProtocolV1 is the core backend ('spice-ts'), not the worker facade.
      const reference = await simulateProtocolV1(request(source));
      const actual = response.data.analyses[0];
      const expected = reference.analyses[0];
      let maxAbsoluteError = 0;
      let samples = 0;
      const compare = (observed: number[], values: number[], signal: string): void => {
        expect(observed).toHaveLength(values.length);
        values.forEach((value, index) => {
          // Phase is periodic: +180 and -180 describe the same phasor.
          const difference = Math.abs(observed[index]! - value);
          const delta = signal.endsWith('.phaseDegrees')
            ? Math.min(difference % 360, 360 - difference % 360) : difference;
          maxAbsoluteError = Math.max(maxAbsoluteError, delta);
          expect(delta, `${signal}[${index}]`).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(value));
          samples++;
        });
      };
      if (actual?.type === 'tran' && expected?.type === 'tran') {
        expect(actual.timeS).toEqual(expected.timeS);
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(expected[field]).sort());
          for (const [signal, values] of Object.entries(expected[field])) {
            compare(actual[field][signal]!, values, `${field}.${signal}`);
          }
        }
      } else if (actual?.type === 'ac' && expected?.type === 'ac') {
        expect(actual.frequencyHz).toEqual(expected.frequencyHz);
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(expected[field]).sort());
          for (const [signal, values] of Object.entries(expected[field])) {
            for (const part of ['magnitude', 'phaseDegrees'] as const) {
              compare(actual[field][signal]!.map(value => value[part]), values.map(value => value[part]), `${field}.${signal}.${part}`);
            }
          }
        }
      } else throw new Error('Expected matching AC/TRAN results');
      expect(samples).toBeGreaterThan(0);
      console.info(`BJT dynamic temperature parity ${name} samples=${samples} maxAbsoluteError=${maxAbsoluteError}`);
    } finally { await engine.close(); }
  });
});
