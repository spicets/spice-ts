import { describe, expect, it } from 'vitest';
import { createSpiceEngine } from './index.js';
import { bjtAcFixtures } from './test-support/bjt-ac.js';

const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });

describe('bounded BJT WASM AC', () => {
  it.each(bjtAcFixtures)('matches JS magnitude and phase at default options: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    const js = await createSpiceEngine({ backend: 'spice-ts-js' });
    try {
      expect(wasm.capabilities.numericWasm?.devicesByAnalysis.ac).toContain('Q');
      const actual = await wasm.simulate(request(source), { requestId: 'bjt-ac-wasm' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const reference = await js.simulate(request(source), { requestId: 'bjt-ac-js' });
      if (!reference.ok) throw new Error(reference.error.message);
      const a = actual.data.analyses[0];
      const b = reference.data.analyses[0];
      if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('Expected AC');
      expect(a.frequencyHz).toEqual(b.frequencyHz);
      expect(a.frequencyHz[0]).toBe(10);
      expect(a.frequencyHz.at(-1)).toBeCloseTo(100000, 6);
      let maxRelativeError = 0;
      for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
        expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
        for (const [signal, values] of Object.entries(b[field])) {
          expect(a[field][signal]).toHaveLength(values.length);
          values.forEach((value, index) => {
            for (const key of ['magnitude', 'phaseDegrees'] as const) {
              const error = Math.abs(a[field][signal]![index]![key] - value[key]) / Math.max(Math.abs(value[key]), 1e-30);
              maxRelativeError = Math.max(maxRelativeError, error);
            }
          });
        }
      }
      console.info(`${name}: max magnitude/phase relative error=${maxRelativeError}`);
      expect(maxRelativeError).toBeLessThanOrEqual(1e-9);
    } finally { await wasm.close(); await js.close(); }
  });

  it.each(['CJS=1p', 'VTF=2', 'XTF=1', 'PTF=10', 'RB=10', 'XTI=3', 'IKF=1m', 'TNOM=27'])(
    'keeps structured rejection for unsupported %s', async parameter => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await wasm.simulate(request(bjtAcFixtures[0]!.source.replace('VAF=80)', `VAF=80 ${parameter})`)), { requestId: 'unsupported-bjt-ac' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'bjt-model-parameter' } } });
      } finally { await wasm.close(); }
    },
  );

  it('propagates structured operating-point non-convergence', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate({ ...request(bjtAcFixtures[0]!.source), options: { maxIterations: 1 } }, { requestId: 'bjt-ac-budget' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } });
    } finally { await wasm.close(); }
  });
});
