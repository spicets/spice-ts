import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT common-source decks; identical bytes for both backends.
// Core's #757 semantics: explicitly given RD=0 opens the prime terminal, not RSH fallback.
const cases = [
  { name: 'drain sheet', model: 'RSH=10', instance: 'NRD=2 NRS=0', internalNodes: 1 },
  { name: 'source sheet', model: 'RSH=10', instance: 'NRD=0 NRS=3', internalNodes: 1 },
  { name: 'both sheets', model: 'RSH=10', instance: 'NRD=2 NRS=3', internalNodes: 2 },
  { name: 'RD overrides sheet', model: 'RSH=10 RD=5', instance: 'NRD=2 NRS=3', internalNodes: 2 },
  { name: 'RD=0 opens drain (#757)', model: 'RSH=10 RD=0', instance: 'NRD=2 NRS=3', internalNodes: 2 },
  { name: 'default squares', model: 'RSH=10', instance: '', internalNodes: 2 },
  { name: 'zero squares', model: 'RSH=10', instance: 'NRD=0 NRS=0', internalNodes: 0 },
  { name: 'RS overrides sheet', model: 'RSH=10 RS=5', instance: 'NRD=2 NRS=3', internalNodes: 2 },
];
const fixtures = ['NMOS', 'PMOS'].flatMap(polarity => {
  const sign = polarity === 'NMOS' ? 1 : -1;
  return cases.flatMap(resistance => ['op', 'dc', 'tran', 'ac'].map(analysis => {
    const bias = analysis === 'tran'
      ? `PULSE(${sign * 2} ${sign * 2.5} 10u 1u 1u 30u 60u)`
      : `DC ${sign * 2.5}${analysis === 'ac' ? ' AC 1' : ''}`;
    const control = analysis === 'dc' ? `.dc VG ${sign * 2} ${sign * 3} ${sign * 0.1}`
      : analysis === 'tran' ? '.tran 1u 150u'
        : analysis === 'ac' ? '.ac dec 10 10 100k' : '.op';
    return {
      name: `${polarity} ${resistance.name} ${analysis}`, analysis,
      internalNodes: resistance.internalNodes,
      source: `VDD supply 0 ${sign * 5}\nVG gate 0 ${bias}\nRL supply drain 1k\nRLOAD source 0 100\n${['ac', 'tran'].includes(analysis) ? 'C1 drain 0 10n\n' : ''}M1 drain gate source 0 transistor W=10u L=1u ${resistance.instance}\n.model transistor ${polarity}(LEVEL=1 VTO=${sign} KP=100u LAMBDA=0.02 GAMMA=0.4 PHI=0.6 ${resistance.model})\n${control}`,
    };
  }));
});
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});
function compareVectors(actual: Record<string, number[]>, expected: Record<string, number[]>, relativeOnly = false): number {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  let maximum = 0;
  for (const [name, values] of Object.entries(expected)) {
    expect(actual[name]).toHaveLength(values.length);
    values.forEach((value, i) => {
      const error = Math.abs(actual[name]![i]! - value);
      maximum = Math.max(maximum, error);
      expect(error, `${name}[${i}]`).toBeLessThanOrEqual(relativeOnly
        ? 1e-9 * Math.abs(value) : Math.max(1e-12, 1e-9 * Math.abs(value)));
    });
  }
  return maximum;
}

describe('MOS1 constant sheet resistance', () => {
  it.each(fixtures)('matches every core node and source current: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'mos1-rsh' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(source))).analyses[0];
      expect(a?.type).toBe(b?.type);
      let maximum = 0;
      let pointCount = 1;
      const compare = (x: Record<string, number[]>, y: Record<string, number[]>, relativeOnly = false) => {
        maximum = Math.max(maximum, compareVectors(x, y, relativeOnly));
      };
      if (a?.type === 'op' && b?.type === 'op') {
        for (const field of ['voltagesV', 'currentsA'] as const) {
          const vectors = (record: Record<string, number>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, [value]]));
          compare(vectors(a[field]), vectors(b[field]));
        }
      } else if ((a?.type === 'dc' && b?.type === 'dc') || (a?.type === 'tran' && b?.type === 'tran')) {
        if (a.type === 'dc' && b.type === 'dc') {
          expect(a.axis.name).toBe(b.axis.name);
          expect(a.axis.unit).toBe(b.axis.unit);
          compare({ axis: a.axis.values }, { axis: b.axis.values });
          pointCount = a.axis.values.length;
        }
        if (a.type === 'tran' && b.type === 'tran') {
          expect(a.timeS).toEqual(b.timeS);
          pointCount = a.timeS.length;
        }
        for (const field of ['voltagesV', 'currentsA'] as const) compare(a[field], b[field]);
      } else if (a?.type === 'ac' && b?.type === 'ac') {
        expect(a.frequencyHz).toEqual(b.frequencyHz);
        pointCount = a.frequencyHz.length;
        for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
          expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
          for (const key of ['magnitude', 'phaseDegrees'] as const) {
            const vectors = (record: typeof a[typeof field]) => Object.fromEntries(Object.entries(record).map(([node, values]) => [node, values.map(value => value[key])]));
            compare(vectors(a[field]), vectors(b[field]), true);
          }
        }
      } else throw new Error('Expected matching analyses');
      process.stdout.write(`MOS1 RSH parity ${JSON.stringify({ name, pointCount, maxAbsoluteError: maximum })}\n`);
    } finally { await wasm.close(); }
  });

  it.each(['op', 'dc', 'tran', 'ac'].flatMap(analysis =>
    ['RSH={10}', 'RSH=1+2', 'RSH=variable', 'NRD=2', 'NRS=3'].map(parameter => ({ analysis, parameter })),
  ))('rejects model parameter $parameter in $analysis', async ({ analysis, parameter }) => {
    const fixture = fixtures.find(f => f.name === `NMOS both sheets ${analysis}`)!;
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixture.source.replace('RSH=10)', `${parameter})`)), { requestId: 'rsh-invalid-model' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
          details: { feature: 'mosfet-model-parameter' } } });
    } finally { await wasm.close(); }
  });
  it.each(['op', 'dc', 'tran', 'ac'].flatMap(analysis =>
    ['NRD={2}', 'NRS=1+2', 'NRD=variable', 'M=2', 'OFF', 'IC=1'].map(parameter => ({ analysis, parameter })),
  ))('rejects instance parameter $parameter in $analysis', async ({ analysis, parameter }) => {
    const fixture = fixtures.find(f => f.name === `NMOS both sheets ${analysis}`)!;
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixture.source.replace('NRD=2 NRS=3', parameter)), { requestId: 'rsh-invalid-instance' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
          details: { feature: 'mosfet-form' } } });
    } finally { await wasm.close(); }
  });
  it.each(fixtures.filter(f => f.name.startsWith('NMOS')).flatMap(fixture =>
    [64, 65].map(order => ({ ...fixture, order })),
  ))('counts sheet internal unknowns at order $order: $name', async ({ source, internalNodes, order }) => {
    // Four external nodes and two voltage-source branches before core's prime-node expansion.
    const padding = Array.from({ length: order - 6 - internalNodes }, (_, i) => `RP${i} pad${i} 0 1k`).join('\n');
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(`${padding}\n${source}`), { requestId: 'rsh-order' });
      if (order === 64) expect(result.ok, JSON.stringify(result)).toBe(true);
      else expect(result).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', retryable: false,
        details: { limit: 'maxSystemOrder', configured: 64, observed: 65 } } });
    } finally { await wasm.close(); }
  });
});
