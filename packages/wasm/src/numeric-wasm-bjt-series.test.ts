import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original MIT common-emitter decks; identical inputs and default options in both engines.
const fixtures = ['NPN', 'PNP'].flatMap(polarity => {
  const sign = polarity === 'NPN' ? 1 : -1;
  return ['RC=10 RE=2', 'RC=10', 'RE=2'].flatMap(resistance =>
    ['op', 'dc', 'tran', 'ac'].map(analysis => {
      const bias = analysis === 'tran'
        ? `PULSE(${sign * 0.9} ${sign * 1.2} 10u 1u 1u 30u 60u)`
        : `DC ${sign * 1.2}${analysis === 'ac' ? ' AC 1' : ''}`;
      const control = analysis === 'dc' ? `.dc VBE 0 ${sign * 1.2} ${sign * 0.05}`
        : analysis === 'tran' ? '.tran 1u 150u'
          : analysis === 'ac' ? '.ac dec 10 10 100k' : '.op';
      return {
        name: `${polarity} ${resistance} ${analysis}`,
        source: `VCC supply 0 ${sign * 5}\nVBE input 0 ${bias}\nRC supply collector 1k\nRB input base 100k\nRE emitter 0 100\n${['ac', 'tran'].includes(analysis) ? 'C1 collector 0 10n\n' : ''}Q1 collector base emitter transistor\n.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80 ${resistance})\n${control}`,
      };
    }),
  );
});
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

function compareVectors(actual: Record<string, number[]>, expected: Record<string, number[]>, relativeOnly = false): number {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  let maxAbsoluteError = 0;
  for (const [name, values] of Object.entries(expected)) {
    expect(actual[name]).toHaveLength(values.length);
    values.forEach((value, i) => {
      const error = Math.abs(actual[name]![i]! - value);
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
      expect(error, `${name}[${i}]`).toBeLessThanOrEqual(relativeOnly
        ? 1e-9 * Math.abs(value) : Math.max(1e-12, 1e-9 * Math.abs(value)));
    });
  }
  return maxAbsoluteError;
}

describe('BJT constant collector/emitter series resistance', () => {
  it.each(fixtures)('matches every core node and source current: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'bjt-series' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(source))).analyses[0];
      expect(a?.type).toBe(b?.type);
      let maxAbsoluteError = 0;
      if (a?.type === 'op' && b?.type === 'op') {
        for (const field of ['voltagesV', 'currentsA'] as const) {
          const vectors = (record: Record<string, number>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, [value]]));
          maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(vectors(a[field]), vectors(b[field])));
        }
      } else if ((a?.type === 'dc' && b?.type === 'dc') || (a?.type === 'tran' && b?.type === 'tran')) {
        if (a.type === 'dc' && b.type === 'dc') {
          expect(a.axis.name).toBe(b.axis.name);
          expect(a.axis.unit).toBe(b.axis.unit);
          compareVectors({ axis: a.axis.values }, { axis: b.axis.values });
        }
        if (a.type === 'tran' && b.type === 'tran') expect(a.timeS).toEqual(b.timeS);
        for (const field of ['voltagesV', 'currentsA'] as const) {
          maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(a[field], b[field]));
        }
      } else if (a?.type === 'ac' && b?.type === 'ac') {
        expect(a.frequencyHz).toEqual(b.frequencyHz);
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          for (const key of ['magnitude', 'phaseDegrees'] as const) {
            const vectors = (record: typeof a[typeof field]) => Object.fromEntries(Object.entries(record).map(([node, values]) => [node, values.map(value => value[key])]));
            maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(vectors(a[field]), vectors(b[field]), true));
          }
        }
      } else throw new Error('Expected matching analyses');
      process.stdout.write(`BJT series parity ${JSON.stringify({ name, maxAbsoluteError })}\n`);
    } finally { await wasm.close(); }
  });

  it.each(['IRB=1m', 'RBM=2'].flatMap(parameter =>
    ['op', 'dc', 'tran', 'ac'].map(analysis => ({ parameter, fixture: fixtures.find(f => f.name === `NPN RC=10 RE=2 ${analysis}`)! })),
  ))('rejects $parameter with RC/RE in $fixture.name', async ({ parameter, fixture }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixture.source.replace('RE=2)', `RE=2 ${parameter})`)), { requestId: 'bjt-series-unsupported' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'bjt-model-parameter' } } });
    } finally { await wasm.close(); }
  });
});
