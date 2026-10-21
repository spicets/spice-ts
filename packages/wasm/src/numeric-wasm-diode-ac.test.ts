import { describe, expect, it } from 'vitest';
import { createSpiceEngine } from './index.js';
import { diodeAcSource } from './test-support/diode-ac.js';

const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });

describe('bounded diode WASM AC', () => {
  it.each([
    ['junction capacitance and RS', diodeAcSource],
    ['reverse-biased junction capacitance and RS', diodeAcSource.replace('DC 2', 'DC -2')],
    ['conductance only', diodeAcSource.replace(' RS=10 CJO=20p VJ=0.7 M=0.4 FC=0.5 TT=2n', '')],
    ['no series resistance', diodeAcSource.replace('RS=10 ', '')],
  ])('matches JS magnitude and phase at default options: %s', async (_name, source) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    const js = await createSpiceEngine({ backend: 'spice-ts-js' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'diode-ac-wasm' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const reference = await js.simulate(request(source), { requestId: 'diode-ac-js' });
      if (!reference.ok) throw new Error(reference.error.message);
      const a = actual.data.analyses[0];
      const b = reference.data.analyses[0];
      if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('Expected AC');
      expect(a.frequencyHz).toEqual(b.frequencyHz);
      let maxRelativeError = 0;
      for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
        expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
        for (const [name, values] of Object.entries(b[field])) {
          expect(a[field][name]).toHaveLength(values.length);
          values.forEach((value, index) => {
            for (const key of ['magnitude', 'phaseDegrees'] as const) {
              const error = Math.abs(a[field][name]![index]![key] - value[key]) / Math.max(Math.abs(value[key]), 1e-30);
              maxRelativeError = Math.max(maxRelativeError, error);
            }
          });
        }
      }
      console.log(`${_name}: max magnitude/phase relative error=${maxRelativeError}`);
      expect(maxRelativeError).toBeLessThanOrEqual(1e-9);
    } finally { await wasm.close(); await js.close(); }
  });

  it.each(['BV=10', 'CJSW=1p'])('keeps structured rejection for unsupported %s', async parameter => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await wasm.simulate(request(diodeAcSource.replace('TT=2n)', `TT=2n ${parameter})`)), { requestId: 'unsupported-diode-ac' });
      expect(result).toMatchObject({ ok: false, error: {
        code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'diode-model-parameter' },
      } });
    } finally { await wasm.close(); }
  });

  it.each(['NPN', 'NMOS'])('does not enable %s AC models', async model => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(diodeAcSource.replace(/\.model.*\n/, `.model junction ${model}\n`)), { requestId: 'unsupported-ac-model' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'nonlinear-model' } } });
    } finally { await wasm.close(); }
  });

  it('propagates structured operating-point non-convergence', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate({ ...request(diodeAcSource), options: { maxIterations: 1 } }, { requestId: 'diode-ac-nonconvergence' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } });
    } finally { await wasm.close(); }
  });
});
