// Original project-authored NPN/PNP bias networks and tests, MIT.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const request = (source: string) => ({
  apiVersion: '1' as const, input: { format: 'spice' as const, source },
});

function circuit(polarity: string, parameters = ''): string {
  const sign = polarity === 'NPN' ? 1 : -1;
  return `VCC supply 0 ${sign * 5}
VBE input 0 DC ${sign * 1.2}
RC supply collector 1k
RB input base 100k
RE emitter 0 100
Q1 collector base emitter transistor
.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80 RB=100 RC=10 RE=2 CJE=2p CJC=1p VJE=0.8 VJC=0.7 ${parameters})`;
}

const temperatures = ['.temp 75', '.temp -25', '.options TEMP=75', '.options TEMP=-25 TNOM=50'];
const fixtures = ['NPN', 'PNP'].flatMap(polarity => temperatures.flatMap(temperature =>
  ['', 'XTI=2.5 EG=1.05 XTB=0.7'].flatMap(parameters => ['op', 'dc'].map(analysis => ({
    name: `${polarity} ${temperature} ${parameters || 'defaults'} ${analysis}`,
    source: `${circuit(polarity, parameters)}\n${temperature}\n${analysis === 'op' ? '.op'
      : `.dc VBE 0 ${polarity === 'NPN' ? 1.2 : -1.2} ${polarity === 'NPN' ? 0.05 : -0.05}`}`,
  }))),
));

describe('WASM BJT circuit TEMP/TNOM OP/DC', () => {
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

  it.each(['NPN', 'PNP'].flatMap(polarity => ['.ac lin 2 1 10', '.tran 1u 10u'].map(control => ({ polarity, control }))))(
    'rejects nonnominal temperature for $polarity $control', async ({ polarity, control }) => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        for (const temperature of temperatures) {
          expect(await engine.simulate(request(`${circuit(polarity)}\n${temperature}\n${control}`), { requestId: 'bjt-temperature-guard' })).toMatchObject({
            ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'circuit-temperature' } },
          });
        }
      } finally { await engine.close(); }
    },
  );
});
