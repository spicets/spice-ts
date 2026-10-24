import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT common-source decks, identical in both backends.
const fixtures = ['NMOS', 'PMOS'].flatMap(polarity => {
  const sign = polarity === 'NMOS' ? 1 : -1;
  return ['RD=10 RS=2', 'RD=10', 'RS=2'].flatMap(resistance =>
    ['op', 'dc', 'tran', 'ac'].map(analysis => {
      const bias = analysis === 'tran'
        ? `PULSE(${sign * 2} ${sign * 2.5} 10u 1u 1u 30u 60u)`
        : `DC ${sign * 2.5}${analysis === 'ac' ? ' AC 1' : ''}`;
      const control = analysis === 'dc' ? `.dc VG ${sign * 2} ${sign * 3} ${sign * 0.1}`
        : analysis === 'tran' ? '.tran 1u 150u'
          : analysis === 'ac' ? '.ac dec 10 10 100k' : '.op';
      return {
        name: `${polarity} ${resistance} ${analysis}`,
        source: `VDD supply 0 ${sign * 5}\nVG gate 0 ${bias}\nRL supply drain 1k\nRLOAD source 0 100\n${['ac', 'tran'].includes(analysis) ? 'C1 drain 0 10n\n' : ''}M1 drain gate source 0 transistor W=10u L=1u\n.model transistor ${polarity}(LEVEL=1 VTO=${sign} KP=100u LAMBDA=0.02 GAMMA=0.4 PHI=0.6 ${resistance})\n${control}`,
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

describe('MOS1 constant drain/source series resistance', () => {
  it.each(fixtures)('matches every core node and source current: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'mos1-series' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(source))).analyses[0];
      expect(a?.type).toBe(b?.type);
      let maxAbsoluteError = 0;
      let pointCount = 1;
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
          pointCount = a.axis.values.length;
        }
        if (a.type === 'tran' && b.type === 'tran') {
          expect(a.timeS).toEqual(b.timeS);
          pointCount = a.timeS.length;
        }
        for (const field of ['voltagesV', 'currentsA'] as const) {
          maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(a[field], b[field]));
        }
      } else if (a?.type === 'ac' && b?.type === 'ac') {
        expect(a.frequencyHz).toEqual(b.frequencyHz);
        pointCount = a.frequencyHz.length;
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          for (const key of ['magnitude', 'phaseDegrees'] as const) {
            const vectors = (record: typeof a[typeof field]) => Object.fromEntries(Object.entries(record).map(([node, values]) => [node, values.map(value => value[key])]));
            maxAbsoluteError = Math.max(maxAbsoluteError, compareVectors(vectors(a[field]), vectors(b[field]), true));
          }
        }
      } else throw new Error('Expected matching analyses');
      process.stdout.write(`MOS1 series parity ${JSON.stringify({ name, pointCount, maxAbsoluteError })}\n`);
    } finally { await wasm.close(); }
  });

  it.each(['op', 'dc', 'tran', 'ac'].flatMap(analysis =>
    ['RSH={10}', 'RD={10}', 'RS={2}', 'RD=1+2', 'RS=variable', 'NRD=2', 'NRS=2'].map(parameter => ({ analysis, parameter })),
  ))('rejects nonconstant/sheet model parameter $parameter in $analysis', async ({ analysis, parameter }) => {
    const fixture = fixtures.find(f => f.name === `NMOS RD=10 RS=2 ${analysis}`)!;
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixture.source.replace('RS=2)', `RS=2 ${parameter})`)), { requestId: 'mos1-series-model' }))
        .toMatchObject({ ok: false, error: {
          code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
          details: { feature: 'mosfet-model-parameter' },
        } });
    } finally { await wasm.close(); }
  });

  it.each(['op', 'dc', 'tran', 'ac'].flatMap(analysis =>
    ['NRD={2}', 'NRS={2}'].map(parameter => ({ analysis, parameter })),
  ))('rejects nonconstant sheet instance parameter $parameter in $analysis', async ({ analysis, parameter }) => {
    const fixture = fixtures.find(f => f.name === `NMOS RD=10 RS=2 ${analysis}`)!;
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixture.source.replace('W=10u', `${parameter} W=10u`)), { requestId: 'mos1-series-instance' }))
        .toMatchObject({ ok: false, error: {
          code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
          details: { feature: 'mosfet-form' },
        } });
    } finally { await wasm.close(); }
  });

  it.each(fixtures.filter(f => f.name.startsWith('NMOS')).flatMap(fixture =>
    [64, 65].map(order => ({ ...fixture, order })),
  ))('counts internal unknowns at order $order: $name', async ({ source, name, order }) => {
    // Four external nodes + two voltage-source branches + one node per positive RD/RS.
    const internalNodes = name.includes('RD=') && name.includes('RS=') ? 2 : 1;
    const padding = Array.from({ length: order - 6 - internalNodes }, (_, i) => `RP${i} pad${i} 0 1k`).join('\n');
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(`${padding}\n${source}`), { requestId: 'mos1-series-order' });
      if (order === 64) expect(result.ok, JSON.stringify(result)).toBe(true);
      else expect(result).toMatchObject({ ok: false, error: {
        code: 'RESOURCE_LIMIT', retryable: false,
        details: { limit: 'maxSystemOrder', configured: 64, observed: 65 },
      } });
    } finally { await wasm.close(); }
  });
});
