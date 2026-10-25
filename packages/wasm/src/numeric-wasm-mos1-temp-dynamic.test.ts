// Original project-authored common-source fixtures, MIT.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';
import { mos1AcFixtures } from './test-support/mos1-ac.js';

const fixtures = mos1AcFixtures.filter(({ name }) => name.endsWith('common-source'));
const temperatures = ['', '.temp 27', '.temp 75\n.options TNOM=27', '.options TEMP=75 TNOM=27', '.options TEMP=-25 TNOM=50'];
const cases = fixtures.flatMap(fixture => temperatures.flatMap(temperature =>
  ['ac', 'tran'].map(analysis => ({ ...fixture, temperature, analysis })),
));

function relativeError(actual: number, expected: number): number {
  const delta = Math.abs(actual - expected);
  return expected === 0 ? (delta === 0 ? 0 : Infinity) : delta / Math.abs(expected);
}

describe('WASM MOS1 TEMP/TNOM dynamic parity', () => {
  it.each(cases)('$name $analysis $temperature matches core v(out)', async ({ name, source, temperature, analysis }) => {
    const sign = name.startsWith('NMOS') ? 1 : -1;
    const text = analysis === 'ac' ? source : source
      .replace(`DC ${sign * 1.5} AC 1`, `SIN(${sign * 1.5} 0.01 1Meg)`)
      .replace(' AC 0', '')
      .replace('.ac dec 10 1 1G', '.tran 1n 200n');
    const input = { apiVersion: '1' as const, input: { format: 'spice' as const, source: `${text}\n${temperature}` } };
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const response = await engine.simulate(input, { requestId: 'mos1-temperature-dynamic' });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      if (!response.ok) throw new Error(response.error.message);
      expect(response.metadata.backend).toBe('spice-ts-wasm');
      const actual = response.data.analyses[0];
      const expected = (await simulateProtocolV1(input)).analyses[0];
      let maxRelativeError = 0;
      if (analysis === 'ac' && actual?.type === 'ac' && expected?.type === 'ac') {
        expect(actual.frequencyHz).toEqual(expected.frequencyHz);
        expect(actual.voltagePhasors.out).toHaveLength(expected.frequencyHz.length);
        expected.voltagePhasors.out!.forEach((value, index) => {
          for (const field of ['magnitude', 'phaseDegrees'] as const) {
            maxRelativeError = Math.max(maxRelativeError, relativeError(actual.voltagePhasors.out![index]![field], value[field]));
          }
        });
      } else if (analysis === 'tran' && actual?.type === 'tran' && expected?.type === 'tran') {
        expect(actual.timeS).toHaveLength(expected.timeS.length);
        expect(actual.timeS.length).toBeGreaterThan(2);
        actual.timeS.forEach((time, index) => {
          expect(Math.abs(time - expected.timeS[index]!)).toBeLessThanOrEqual(1e-12 * expected.timeS.at(-1)!);
        });
        expect(actual.voltagesV.out).toHaveLength(expected.timeS.length);
        expected.voltagesV.out!.forEach((value, index) => {
          maxRelativeError = Math.max(maxRelativeError, relativeError(actual.voltagesV.out![index]!, value));
        });
        expect(Math.max(...actual.voltagesV.out!) - Math.min(...actual.voltagesV.out!)).toBeGreaterThan(0.001);
      } else {
        throw new Error(`Expected ${analysis} results`);
      }
      console.info(JSON.stringify({ name, analysis, temperature: temperature || 'default', maxRelativeError }));
      expect(maxRelativeError).toBeLessThanOrEqual(1e-9);
    } finally { await engine.close(); }
  });
});
