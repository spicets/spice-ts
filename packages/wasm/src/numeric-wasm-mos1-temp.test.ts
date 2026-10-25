// Original project-authored NMOS/PMOS bias networks and CMOS inverter, MIT.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const request = (source: string) => ({
  apiVersion: '1' as const, input: { format: 'spice' as const, source },
});
const temperatures = ['.temp 75', '.temp -25', '.options TEMP=75 TNOM=50'];
const resistances = [
  { model: '', instance: '' },
  { model: 'RD=10 RS=2', instance: '' },
  { model: 'RSH=10', instance: 'NRD=2 NRS=3' },
];
function circuit(polarity: string, resistance = resistances[0]!): string {
  const sign = polarity === 'NMOS' ? 1 : -1;
  return `VDD supply 0 ${sign * 5}
VG gate 0 DC ${sign * 2.5}
RL supply drain 1k
RE source 0 100
M1 drain gate source 0 channel W=10u L=1u ${resistance.instance}
.model channel ${polarity}(LEVEL=1 VTO=${sign * 0.7} KP=100u GAMMA=0.4 PHI=0.6 LAMBDA=0.02 ${resistance.model})`;
}
const inverter = `VDD supply 0 3
VIN gate 0 1.2
MN out gate 0 0 nch W=10u L=1u NRD=2 NRS=3
MP out gate supply supply pch W=20u L=1u
.model nch NMOS(LEVEL=1 VTO=0.7 KP=100u GAMMA=0.4 PHI=0.6 LAMBDA=0.02 RSH=10)
.model pch PMOS(LEVEL=1 VTO=-0.7 KP=50u GAMMA=0.4 PHI=0.6 LAMBDA=0.02 RD=10 RS=2)`;
const fixtures = ['NMOS', 'PMOS'].flatMap(polarity => temperatures.flatMap(temperature =>
  resistances.flatMap(resistance => ['op', 'dc'].map(analysis => ({
    name: `${polarity} ${temperature} ${resistance.model || 'no series resistance'} ${analysis}`,
    source: `${circuit(polarity, resistance)}\n${temperature}\n${analysis === 'op' ? '.op'
      : `.dc VG 0 ${polarity === 'NMOS' ? 3 : -3} ${polarity === 'NMOS' ? 0.1 : -0.1}`}`,
  }))),
));
fixtures.push(...temperatures.flatMap(temperature => ['.op', '.dc VIN 0 3 0.1'].map(control => ({
  name: `CMOS ${temperature} ${control}`, source: `${inverter}\n${temperature}\n${control}`,
}))));

describe('WASM MOS1 circuit TEMP/TNOM OP/DC', () => {
  it.each(fixtures)('matches every core node voltage and source current: $name', async ({ source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const response = await engine.simulate(request(source), { requestId: 'mos1-temperature' });
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
            const error = Math.abs(values[index]! - value);
            maxAbsoluteError = Math.max(maxAbsoluteError, error);
            expect(error, `${field}.${name}[${index}]`).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(value));
          });
        }
      }
      console.info(`MOS1 temperature parity maxAbsoluteError=${maxAbsoluteError}`);
    } finally { await engine.close(); }
  });

  it.each(['NMOS', 'PMOS'].flatMap(polarity => ['.ac lin 2 1 10', '.tran 1u 10u'].map(control => ({ polarity, control }))))(
    'accepts nonnominal temperature for $polarity $control', async ({ polarity, control }) => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        for (const temperature of temperatures) {
          expect(await engine.simulate(request(`${circuit(polarity)}\n${temperature}\n${control}`), { requestId: 'mos1-temperature-guard' })).toMatchObject({
            ok: true, metadata: { backend: 'spice-ts-wasm' },
          });
        }
      } finally { await engine.close(); }
    },
  );
});
