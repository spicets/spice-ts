// Original project-authored MIT fixtures; identical decks in core and WASM.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });
const cases = [27, 60].flatMap(temperature => ['C', 'L'].map(kind => ({ temperature, kind })));

function circuit(kind: string, temperature: number, parameters: string, model = ''): string {
  return `V1 in 0 ${kind === 'C' ? 'AC 1' : 'PULSE(0 1 20u 10u 10u 200u 500u)'}
R1 in out ${kind === 'C' ? '1k' : '10'}
${kind}1 out 0 ${kind === 'C' ? '1u' : '10m'} ${parameters}
${model}
.options TEMP=${temperature} TNOM=27
${kind === 'C' ? '.ac dec 5 10 100k' : '.tran 10u 1m 0 10u'}`;
}

// Zero reference samples must match exactly; no absolute-error escape hatch.
function compare(actual: number[], expected: number[]): number {
  expect(actual).toHaveLength(expected.length);
  let maximum = 0;
  expected.forEach((value, i) => {
    const delta = Math.abs(actual[i]! - value);
    maximum = Math.max(maximum, value === 0 ? (delta === 0 ? 0 : Infinity) : delta / Math.abs(value));
  });
  expect(maximum).toBeLessThanOrEqual(1e-9);
  return maximum;
}

async function parity(source: string): Promise<void> {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const response = await engine.simulate(request(source), { requestId: 'cl-temperature' });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.metadata.backend).toBe('spice-ts-wasm');
    const actual = response.data.analyses[0];
    const expected = (await simulateProtocolV1(request(source))).analyses[0];
    let maximum = 0;
    if (actual?.type === 'tran' && expected?.type === 'tran') {
      maximum = compare(actual.timeS, expected.timeS);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(expected[field]).sort());
        for (const [name, values] of Object.entries(expected[field])) {
          maximum = Math.max(maximum, compare(actual[field][name]!, values));
        }
      }
    } else if (actual?.type === 'ac' && expected?.type === 'ac') {
      maximum = compare(actual.frequencyHz, expected.frequencyHz);
      for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
        expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(expected[field]).sort());
        for (const [name, values] of Object.entries(expected[field])) {
          expect(actual[field][name]).toHaveLength(values.length);
          for (const key of ['magnitude', 'phaseDegrees'] as const) {
            maximum = Math.max(maximum, compare(actual[field][name]!.map(value => value[key]), values.map(value => value[key])));
          }
        }
      }
    } else throw new Error('Expected matching AC or transient analyses');
    process.stdout.write(`${actual.type}: maxRelativeError=${maximum}\n`);
  } finally { await engine.close(); }
}

describe('WASM C/L circuit temperature', () => {
  it.each(cases)('matches all $kind vectors with instance TC1/TC2 at $temperature C', async ({ kind, temperature }) => {
    await parity(circuit(kind, temperature, 'TC1=0.01 TC2=1e-4'));
  });

  it.each(cases.flatMap(value => ['', 'TC1=0', 'TC2=0'].map(override => ({ ...value, override }))))(
    'matches $kind model TNOM and $override at $temperature C', async ({ kind, temperature, override }) => {
      await parity(circuit(kind, temperature, `thermal ${override}`, `.model thermal ${kind}(TC1=0.01 TC2=1e-4 TNOM=35)`));
    },
  );

  it.each(['C', 'L'].flatMap(kind => ['TC1={0.01}', 'TC2=coefficient', 'DTEMP=10', 'M=2', 'XTC1=0.01'].map(parameters => ({ kind, parameters }))))(
    'rejects unsupported $kind $parameters', async ({ kind, parameters }) => {
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await engine.simulate(request(circuit(kind, 60, parameters)), { requestId: 'cl-guard' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'passive-form' } },
        });
      } finally { await engine.close(); }
    },
  );
});
