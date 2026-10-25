// Original project-authored NJF/PJF bias networks, MIT. Core parity, not ngspice data.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const request = (source: string) => ({
  apiVersion: '1' as const, input: { format: 'spice' as const, source },
});
const temperatures = ['.temp 75', '.temp -25', '.options TEMP=75 TNOM=50', '.options TNOM=50'];
const models = [
  '',
  'TCV=0.002 BEX=-1.5 EG=1.05 XTI=2',
  'VTOTC=-0.003 BETATCE=-0.5 EG=1.2 XTI=4',
  'TNOM=40 TCV=0.1 VTOTC=-0.002 BEX=2 BETATCE=-0.4 EG=1.05 XTI=2',
];
function circuit(polarity: string, parameters = '', gate = -0.5): string {
  const sign = polarity === 'NJF' ? 1 : -1;
  return `VDD supply 0 ${sign * 5}
VG gate 0 ${sign * gate}
RL supply drain 1k
RE source 0 100
J1 drain gate source channel
.model channel ${polarity}(LEVEL=1 VTO=-2 BETA=100u LAMBDA=0.02 IS=1e-14 N=1.2 RD=20 RS=30 ${parameters})`;
}
const fixtures = ['NJF', 'PJF'].flatMap(polarity => temperatures.flatMap(temperature =>
  models.flatMap(parameters => ['op', 'dc'].map(analysis => ({
    name: `${polarity} ${temperature} ${parameters || 'defaults'} ${analysis}`,
    source: `${circuit(polarity, parameters)}\n${temperature}\n${analysis === 'op' ? '.op'
      : `.dc VG ${polarity === 'NJF' ? -3 : 3} ${polarity === 'NJF' ? 0.6 : -0.6} ${polarity === 'NJF' ? 0.2 : -0.2}`}`,
  }))),
));

describe('WASM JFET circuit TEMP/TNOM OP/DC', () => {
  it.each(fixtures)('matches every core node voltage and source current: $name', async ({ source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const response = await engine.simulate(request(source), { requestId: 'jfet-temperature' });
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
      process.stdout.write(`JFET temperature parity maxAbsoluteError=${maxAbsoluteError}\n`);
    } finally { await engine.close(); }
  });

  it.each(['NJF', 'PJF'].flatMap(polarity => ['.ac lin 2 1 10', '.tran 1u 10u'].map(control => ({ polarity, control }))))(
    'rejects circuit temperature for $polarity $control', async ({ polarity, control }) => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        for (const temperature of temperatures) {
          expect(await engine.simulate(request(`${circuit(polarity)}\n${temperature}\n${control}`), { requestId: 'jfet-temperature-guard' })).toMatchObject({
            ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false, details: { feature: 'circuit-temperature' } },
          });
        }
      } finally { await engine.close(); }
    },
  );
});
