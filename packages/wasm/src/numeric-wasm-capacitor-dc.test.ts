import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored fixtures, MIT like this package.
const fixtures = [
  { name: 'RC divider', source: 'V1 in 0 5\nR1 in out 1k\nR2 out 0 2k\nC1 out 0 1u' },
  { name: 'coupling capacitor', source: 'V1 in 0 5\nR1 in bias 1k\nR2 bias 0 2k\nC1 bias out 1u\nR3 out 0 10k' },
  { name: 'diode bias', source: 'V1 in 0 5\nR1 in out 1k\nD1 out 0 junction\n.model junction D(IS=1e-14 N=1)\nC1 out 0 1u' },
];
const analyses = ['.op', '.dc V1 -1 5 0.5'];
function request(source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 {
  return { apiVersion: '1', input: { format: 'spice', source }, options };
}

// Same absolute/relative bounds as the existing diode DC parity tests.
function expectParity(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
}

describe('WASM capacitors are open circuits in OP/DC', () => {
  it('advertises capacitor support for OP and DC', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(wasm.capabilities.numericWasm?.devicesByAnalysis.op).toContain('C');
      expect(wasm.capabilities.numericWasm?.devicesByAnalysis.dc).toContain('C');
    } finally { await wasm.close(); }
  });

  it.each(fixtures.flatMap(fixture => analyses.flatMap(analysis => [false, true].map(ic => ({
    ...fixture, analysis, ic,
  })))))('matches every core voltage/current: $name $analysis IC=$ic', async ({ source, analysis, ic }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    const core = await createSpiceEngine({ backend: 'spice-ts-js' });
    try {
      const input = request(`${ic ? source.replace(/^(C\S+[^\n]*)/m, '$1 IC=123') : source}\n${analysis}`);
      const reference = await core.simulate(request(`${source}\n${analysis}`), { requestId: 'capacitor-core' });
      const actual = await wasm.simulate(input, { requestId: 'capacitor-wasm' });
      expect(reference.ok).toBe(true);
      expect(actual.ok).toBe(true);
      if (!actual.ok || !reference.ok) throw new Error('Expected successful capacitor bias analyses');
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      expect(actual.data.analyses).toHaveLength(reference.data.analyses.length);
      const a = actual.data.analyses[0];
      const b = reference.data.analyses[0];
      expect(a?.type).toBe(b?.type);
      if (a?.type === 'op' && b?.type === 'op') {
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
          for (const [name, value] of Object.entries(b[field])) expectParity(a[field][name]!, value);
        }
        // IC must not turn an open capacitor into a DC voltage source.
        if (source.includes('R3')) expectParity(a.voltagesV.out!, 0);
      } else if (a?.type === 'dc' && b?.type === 'dc') {
        expect(a.axis).toEqual(b.axis);
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
          for (const [name, values] of Object.entries(b[field])) {
            expect(a[field][name]).toHaveLength(values.length);
            values.forEach((value, index) => expectParity(a[field][name]![index]!, value));
          }
        }
        if (source.includes('R3')) a.voltagesV.out!.forEach(value => expectParity(value, 0));
      } else throw new Error('Expected OP or DC results');
    } finally { await wasm.close(); await core.close(); }
  });

  it.each([
    { name: 'flat', source: 'V1 in 0 5\nC1 in floating 1u IC=123', sourcePath: '/input/source/lines/1' },
    { name: 'hierarchical', source: 'V1 in 0 5\nX1 in cell\n.subckt cell in\nC1 in floating 1u IC=123\n.ends cell', sourcePath: '/input/source/lines/1' },
  ].flatMap(fixture => analyses.flatMap(analysis => [undefined, 1e-12].map(gmin => ({ ...fixture, analysis, gmin })))))(
    'matches core structured outcome for a $name capacitor-only floating node: $analysis gmin=$gmin', async ({ source, sourcePath, analysis, gmin }) => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      const core = await createSpiceEngine({ backend: 'spice-ts-js' });
      try {
        const input = request(`${source}\n${analysis}`, gmin === undefined ? undefined : { gmin });
        const reference = await core.simulate(input, { requestId: 'floating-core' });
        const actual = await wasm.simulate(input, { requestId: 'floating-wasm' });
        expect(reference.ok).toBe(false);
        if (reference.ok) throw new Error('Expected a missing DC reference');
        expect(reference.error).toMatchObject({ code: 'INVALID_CIRCUIT', phase: 'validation' });
        expect(reference.error.details).toMatchObject({ sourcePaths: [sourcePath] });
        expect(actual.ok).toBe(false);
        if (actual.ok) throw new Error('Expected a missing DC reference');
        expect(actual.error).toEqual(reference.error);
      } finally { await wasm.close(); await core.close(); }
    },
  );
});
