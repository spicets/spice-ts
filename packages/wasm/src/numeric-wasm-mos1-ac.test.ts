import { describe, expect, it } from 'vitest';
import { createSpiceEngine } from './index.js';
import { mos1AcFixtures } from './test-support/mos1-ac.js';

const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });

describe('bounded MOS1 WASM AC', () => {
  it.each(mos1AcFixtures)('matches JS magnitude and phase at default options: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    const js = await createSpiceEngine({ backend: 'spice-ts-js' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'mos1-ac-wasm' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(wasm.capabilities.numericWasm?.devicesByAnalysis.ac).toContain('M');
      const reference = await js.simulate(request(source), { requestId: 'mos1-ac-js' });
      if (!reference.ok) throw new Error(reference.error.message);
      const a = actual.data.analyses[0];
      const b = reference.data.analyses[0];
      if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('Expected AC');
      expect(a.frequencyHz).toEqual(b.frequencyHz);
      expect(a.frequencyHz).toHaveLength(91);
      expect(a.frequencyHz[0]).toBe(1);
      expect(a.frequencyHz.at(-1)).toBeCloseTo(1e9, 4);
      let maxRelativeError = 0;
      expect(a.voltagePhasors.out).toHaveLength(b.frequencyHz.length);
      for (const [index, value] of b.voltagePhasors.out!.entries()) {
        for (const key of ['magnitude', 'phaseDegrees'] as const) {
          const error = Math.abs(a.voltagePhasors.out![index]![key] - value[key]) / Math.max(Math.abs(value[key]), 1e-30);
          maxRelativeError = Math.max(maxRelativeError, error);
        }
      }
      console.info(`${name}: v(out) max magnitude/phase relative error=${maxRelativeError}`);
      expect(maxRelativeError).toBeLessThanOrEqual(1e-9);
    } finally { await wasm.close(); await js.close(); }
  });

  it.each(['LEVEL=2', 'LEVEL=3', 'LEVEL=14', 'LEVEL=2 LEVEL=1', 'RSH={10}', 'TNOM=27'])(
    'keeps structured rejection for unsupported %s', async parameter => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await wasm.simulate(request(mos1AcFixtures[0]!.source.replace('LEVEL=1', parameter)), { requestId: 'unsupported-mos1-ac' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'mosfet-model-parameter' } } });
      } finally { await wasm.close(); }
    },
  );

  it('propagates structured operating-point non-convergence', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate({ ...request(mos1AcFixtures[0]!.source), options: { maxIterations: 1 } }, { requestId: 'mos1-ac-budget' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } });
    } finally { await wasm.close(); }
  });
});
