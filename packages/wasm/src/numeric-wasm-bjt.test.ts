import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT fixtures: mirrored resistor-biased NPN/PNP stages.
const fixtures = ['NPN', 'PNP'].flatMap(polarity => [
  { region: 'forward-active', supply: 5, bias: 1.2, rb: '100k', rc: '1k' },
  { region: 'saturation', supply: 5, bias: 5, rb: '1k', rc: '10k' },
  { region: 'cutoff', supply: 5, bias: 0, rb: '100k', rc: '1k' },
  { region: 'reverse-active', supply: -2, bias: 0.4, rb: '100k', rc: '10k' },
].map(({ region, supply, bias, rb, rc }) => {
  const sign = polarity === 'NPN' ? 1 : -1;
  return {
    name: `${polarity} ${region}`,
    source: `VCC supply 0 ${sign * supply}\nVB bias 0 ${sign * bias}\nRC supply collector ${rc}\nRB bias base ${rb}\nRE emitter 0 100\nQ1 collector base emitter transistor\n.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80)\n.op`,
  };
}));
const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options,
});

let maxAbsoluteError = 0;
let maxRelativeError = 0;

describe('bounded BJT WASM operating point', () => {
  it.each(fixtures)('matches core node voltages and source branch currents: $name', async ({ source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'bjt-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) return;
      const reference = await simulateProtocolV1(request(source));
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      expect(a?.type).toBe('op');
      expect(b?.type).toBe('op');
      if (a?.type !== 'op' || b?.type !== 'op') return;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [name, value] of Object.entries(b[field])) {
          const error = Math.abs(a[field][name]! - value);
          maxAbsoluteError = Math.max(maxAbsoluteError, error);
          if (value !== 0) maxRelativeError = Math.max(maxRelativeError, error / Math.abs(value));
          expect(error, `${field}.${name}`).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(value));
        }
      }
      console.info('BJT parity running maxima', { maxAbsoluteError, maxRelativeError });
    } finally { await wasm.close(); }
  });

  it.each(['CJE=1p', 'TF=1n', 'RB=10', 'XTI=3', 'IKF=1m', 'TNOM=27'])(
    'rejects unsupported model parameter %s', async parameter => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const source = fixtures[0]!.source.replace('VAF=80)', `VAF=80 ${parameter})`);
        expect(await wasm.simulate(request(source), { requestId: 'bjt-unsupported' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'bjt-model-parameter' } },
        });
      } finally { await wasm.close(); }
    },
  );

  it.each([
    ['transistor AREA=2', '.op', 'bjt-form'],
    ['substrate transistor', '.op', 'bjt-form'],
    ['transistor AREA=2', '.ac dec 1 1 10', 'bjt-form'],
  ])('rejects unsupported instance/analysis: %s %s', async (instance, analysis, feature) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = fixtures[0]!.source.replace('emitter transistor', `emitter ${instance}`).replace('.op', analysis);
      expect(await wasm.simulate(request(source), { requestId: 'bjt-form' })).toMatchObject({
        ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature } },
      });
    } finally { await wasm.close(); }
  });

  it('returns structured non-convergence when its iteration budget is exhausted', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixtures[0]!.source, { maxIterations: 1 }), { requestId: 'bjt-budget' })).toMatchObject({
        ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' },
      });
    } finally { await wasm.close(); }
  });
});
