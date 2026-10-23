import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT common-emitter fixtures. Mirror both polarities
// and sweep directions without changing solver tolerances between circuits.
const fixtures = ['NPN', 'PNP'].flatMap(polarity => {
  const sign = polarity === 'NPN' ? 1 : -1;
  const circuit = `VCE supply 0 ${sign * 5}\nVBE bias 0 ${sign * 1.2}\nRC supply collector 1k\nRB bias base 100k\nQ1 collector base 0 transistor\n.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80)`;
  return [
    { name: `${polarity} VBE forward`, source: `${circuit}\n.dc VBE 0 ${sign * 1.2} ${sign * 0.05}` },
    { name: `${polarity} VBE reverse`, source: `${circuit}\n.dc VBE ${sign * 1.2} 0 ${-sign * 0.05}` },
    { name: `${polarity} VCE forward`, source: `${circuit}\n.dc VCE 0 ${sign * 5} ${sign * 0.25}` },
    { name: `${polarity} VCE reverse`, source: `${circuit}\n.dc VCE ${sign * 5} 0 ${-sign * 0.25}` },
  ];
});
const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options,
});

describe('bounded BJT WASM DC sweeps', () => {
  it.each(fixtures)('matches core at every point: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'bjt-dc-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const reference = await simulateProtocolV1(request(source));
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      expect(a?.type).toBe('dc');
      expect(b?.type).toBe('dc');
      if (a?.type !== 'dc' || b?.type !== 'dc') throw new Error('Expected DC results');
      expect(a.axis.values.length).toBeGreaterThanOrEqual(21);
      expect(a.axis.name).toBe(b.axis.name);
      expect(a.axis.unit).toBe(b.axis.unit);
      expect(a.axis.values).toHaveLength(b.axis.values.length);
      a.axis.values.forEach((value, index) => expect(Math.abs(value - b.axis.values[index]!)).toBeLessThanOrEqual(1e-12));
      let samples = 0;
      let maxAbsoluteError = 0;
      let maxRelativeError = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [vector, values] of Object.entries(b[field])) {
          expect(a[field][vector]).toHaveLength(values.length);
          values.forEach((value, index) => {
            const error = Math.abs(a[field][vector]![index]! - value);
            samples++;
            maxAbsoluteError = Math.max(maxAbsoluteError, error);
            if (value !== 0) maxRelativeError = Math.max(maxRelativeError, error / Math.abs(value));
            expect(error, `${field}.${vector}[${index}]`).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(value)));
          });
        }
      }
      process.stdout.write(`BJT DC parity ${JSON.stringify({ name, points: a.axis.values.length, samples, maxAbsoluteError, maxRelativeError })}\n`);
    } finally { await wasm.close(); }
  });

  it.each(['CJS=1p', 'XTF=1', 'RB=10', 'XTI=3', 'IKF=1m', 'TNOM=27'])(
    'rejects out-of-subset DC model parameter %s', async parameter => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const source = fixtures[0]!.source.replace('VAF=80)', `VAF=80 ${parameter})`);
        expect(await wasm.simulate(request(source), { requestId: 'bjt-dc-unsupported' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'bjt-model-parameter' } },
        });
      } finally { await wasm.close(); }
    },
  );

  it.each([
    ['AREA=2', 'bjt-form'],
    ['\n.step VBE 0 1 0.1', 'device-or-directive'],
    ['\n.dc VCE 0 5 0.25', 'maxAnalyses'],
  ])('rejects unsupported sweep extensions: %s', async (extension, feature) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = extension === 'AREA=2'
        ? fixtures[0]!.source.replace('0 transistor', '0 transistor AREA=2')
        : fixtures[0]!.source + extension;
      expect(await wasm.simulate(request(source), { requestId: 'bjt-dc-extension' })).toMatchObject({
        ok: false, error: { details: extension.startsWith('\n.dc') ? { limit: feature } : { feature } },
      });
    } finally { await wasm.close(); }
  });

  it('preserves the bounded per-point iteration budget', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixtures[0]!.source, { maxIterations: 1 }), { requestId: 'bjt-dc-budget' })).toMatchObject({
        ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' },
      });
    } finally { await wasm.close(); }
  });
});
