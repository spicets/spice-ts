import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { fixtures } from './test-support/mos1-fixtures.js';
import { createSpiceEngine } from './index.js';

const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options,
});

describe('bounded MOS1 WASM operating point', () => {
  it('pins the ngspice-47 receipt to every fixture byte and uniform OP tolerance', () => {
    const receipt = JSON.parse(readFileSync(new URL('../../../benchmarks/wasm-mos1-op/report.json', import.meta.url), 'utf8'));
    expect(receipt.ngspiceVersion).toBe('ngspice-47');
    expect(receipt.fixtureCount).toBe(fixtures.length);
    expect(receipt.results.map((result: { name: string }) => result.name)).toEqual(fixtures.map(fixture => fixture.name));
    let samples = 0;
    for (const [index, fixture] of fixtures.entries()) {
      const result = receipt.results[index];
      expect(result.inputSha256).toBe(createHash('sha256').update(fixture.source).digest('hex'));
      for (const sample of result.samples) {
        expect(Number.isFinite(sample.wasm) && Number.isFinite(sample.ngspice)).toBe(true);
        expect(Math.abs(sample.wasm - sample.ngspice)).toBeLessThanOrEqual(1e-9 + 1e-6 * Math.abs(sample.ngspice));
        samples++;
      }
    }
    expect(receipt.sampleCount).toBe(samples);
  });

  it.each(fixtures)('matches core voltages and branch currents: $name', async ({ source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'mos1-parity' });
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
          expect(Math.abs(a[field][name]! - value), `${field}.${name}`)
            .toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(value));
        }
      }
    } finally { await wasm.close(); }
  });

  it.each(['LEVEL=2', 'LEVEL=1.1', 'LEVEL=1 LEVEL=2', 'CGSO=1p', 'TOX=10n', 'RSH=10', 'TNOM=27'])(
    'rejects unsupported model option %s', async parameter => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const source = fixtures[0]!.source.replace('LEVEL=1', parameter);
        expect(await wasm.simulate(request(source), { requestId: 'mos1-model' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'mosfet-model-parameter' } },
        });
      } finally { await wasm.close(); }
    },
  );

  it.each([
    ['W=10u L=1u M=2', '.op', 'mosfet-form'],
    ['W=10u L=1u IC=1', '.op', 'mosfet-form'],
    ['W=10u L=1u M=2', '.ac dec 1 1 10', 'mosfet-form'],
  ])('rejects unsupported instance/analysis %s %s', async (instance, analysis, feature) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = fixtures[0]!.source.replace('W=10u L=1u', instance).replace('.op', analysis);
      expect(await wasm.simulate(request(source), { requestId: 'mos1-form' })).toMatchObject({
        ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature } },
      });
    } finally { await wasm.close(); }
  });

  it('returns structured non-convergence on exhausted budget', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixtures[0]!.source, { maxIterations: 1 }), { requestId: 'mos1-budget' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } });
    } finally { await wasm.close(); }
  });
});
