import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original, project-authored operating-point fixtures (MIT, like this package).
const fixtures = [
  'V1 in 0 5\nR1 in out 1k\nD1 out 0 junction\n.model junction D(IS=1e-14 N=1)\n.op',
  'V1 in 0 5\nR1 in out 1k\nD1 out mid junction\nD2 mid 0 junction\n.model junction D(IS=1e-14 N=1)\n.op',
  'V1 in 0 5\nR1 in out 1k\nD1 out 0 junction\n.model junction D(IS=1e-14 N=1.5 RS=10)\n.op',
];
// ngspice-47, identical netlists at default tolerances, `set numdgt=17; op;
// wrdata ... v(in) v(out) [v(mid)] i(v1)`. One relative bound for all fixtures.
const ngspiceOp = [
  { voltagesV: { in: 5, out: 0.6928909752303611 }, currentsA: { V1: -0.0043071090247696385 } },
  { voltagesV: { in: 5, out: 1.376830161180259, mid: 0.6884150805901295 }, currentsA: { V1: -0.003623169838819741 } },
  { voltagesV: { in: 5, out: 1.0749776745071413 }, currentsA: { V1: -0.003925022325492859 } },
];
function request(source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 {
  return { apiVersion: '1', input: { format: 'spice', source }, options };
}

describe('bounded diode WASM operating point', () => {
  it.each([
    ['forward', '.dc V1 -1 1 0.05'],
    ['reverse', '.dc V1 1 -1 -0.05'],
  ])('matches core at every diode DC sweep point: %s', async (_direction, sweep) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const fixture of fixtures) {
        const source = fixture.replace('.op', sweep!);
        const actual = await wasm.simulate(request(source), { requestId: 'diode-dc-parity' });
        expect(actual.ok).toBe(true);
        if (!actual.ok) throw new Error(actual.error.message);
        expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
        const reference = await simulateProtocolV1(request(source));
        const a = actual.data.analyses[0];
        const b = reference.analyses[0];
        expect(a?.type).toBe('dc');
        expect(b?.type).toBe('dc');
        if (a?.type !== 'dc' || b?.type !== 'dc') throw new Error('Expected DC results');
        expect(a.axis.values).toHaveLength(41);
        expect(a.axis.name).toBe(b.axis.name);
        expect(a.axis.unit).toBe(b.axis.unit);
        expect(a.axis.values).toHaveLength(b.axis.values.length);
        a.axis.values.forEach((value, index) => expect(Math.abs(value - b.axis.values[index]!)).toBeLessThanOrEqual(1e-12));
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[field])).toEqual(Object.keys(b[field]));
          for (const [name, values] of Object.entries(b[field])) {
            expect(a[field][name]).toHaveLength(values.length);
            values.forEach((value, index) => {
              expect(Math.abs(a[field][name]![index]! - value)).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(value)));
            });
          }
        }
      }
    } finally { await wasm.close(); }
  });

  it.each([
    [fixtures[0]!.replace('N=1)', 'N=1 BV=10)'), undefined, 'UNSUPPORTED_FEATURE', 'Only diode model parameters IS, N, and RS are supported'],
    [fixtures[0]!.replace('IS=1e-14', 'IS=1e-300'), { maxIterations: 1 }, 'CONVERGENCE_FAILED', 'The bounded WebAssembly diode operating point did not converge'],
  ] as const)('preserves structured diode errors in DC sweeps', async (fixture, options, code, message) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixture.replace('.op', '.dc V1 -1 1 0.05'), options), { requestId: 'diode-dc-error' }))
        .toMatchObject({ ok: false, error: { code, message } });
    } finally { await wasm.close(); }
  });

  it.each(fixtures.map((source, index) => ({ source, index })))('matches core and ngspice voltages and branch currents: $index', async ({ source, index }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'diode-parity' });
      expect(actual.ok).toBe(true);
      if (!actual.ok) return;
      const reference = await simulateProtocolV1(request(source));
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      expect(a?.type).toBe('op');
      expect(b?.type).toBe('op');
      if (a?.type !== 'op' || b?.type !== 'op') return;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        for (const [name, value] of Object.entries(b[field])) {
          expect(Math.abs(a[field][name]! - value)).toBeLessThanOrEqual(1e-9 * Math.abs(value));
        }
        for (const [name, value] of Object.entries(ngspiceOp[index]![field])) {
          expect(Math.abs(a[field][name]! - value)).toBeLessThanOrEqual(1e-5 * Math.abs(value));
        }
      }
    } finally { await wasm.close(); }
  });

  it.each([
    [fixtures[0]!.replace('N=1)', 'N=1 BV=10)'), 'Only diode model parameters IS, N, and RS are supported'],
    [fixtures[0]!.replace('N=1)', 'N=1 CJO=1p)'), 'Only diode model parameters IS, N, and RS are supported'],
    [fixtures[0]!.replace('D1 out 0 junction', 'D1 out 0 junction AREA=2'), 'Diodes must use name anode cathode model'],
  ])('rejects unsupported diode features without fallback', async (source, message) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(source), { requestId: 'diode-unsupported' })).toMatchObject({
        ok: false, error: { code: 'UNSUPPORTED_FEATURE', message },
      });
    } finally { await wasm.close(); }
  });

  it.each(['.model junction D', '.model junction D IS=1e-14 N=1', '.model junction D(IS=1e-14,N=1)'])(
    'accepts bounded model syntax: %s', async model => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const source = fixtures[0]!.replace('.model junction D(IS=1e-14 N=1)', model);
        expect(await wasm.simulate(request(source), { requestId: 'diode-model' })).toMatchObject({ ok: true });
      } finally { await wasm.close(); }
    },
  );

  it('returns structured non-convergence for a pathological saturation current', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = fixtures[0]!.replace('IS=1e-14', 'IS=1e-300');
      expect(await wasm.simulate(request(source, { maxIterations: 1 }), { requestId: 'diode-nonconvergence' })).toMatchObject({
        ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve', message: 'The bounded WebAssembly diode operating point did not converge' },
      });
    } finally { await wasm.close(); }
  });
});
