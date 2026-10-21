import { describe, expect, it } from 'vitest';
import { createSpiceEngine } from './index.js';

const analyses = [
  { name: 'dc', drive: '0', directive: '.dc Vdrive -1 1 0.5' },
  { name: 'tran', drive: 'PULSE(0 1 0 100u 100u 1m 2m)', directive: '.tran 10u 100u' },
  { name: 'ac', drive: 'DC 0 AC 2 30', directive: '.ac dec 3 10 10k' },
] as const;

function deck(drive: string, directive: string): string {
  return [
    `Vdrive in 0 ${drive}`, 'Rin in 0 1k',
    'E1 e 0 in 0 -2', 'Re e 0 2k',
    'F1 f 0 vDRIVE -3', 'Rf f 0 1k',
    'G1 g 0 in 0 -1m', 'Rg g 0 2k',
    'H1 h 0 VDRIVE -2k', 'Rh h 0 1k', directive,
  ].join('\n');
}

describe('linear controlled sources in numeric WASM analyses', () => {
  it.each(analyses)('matches every JS voltage and branch current point for $name with E/F/G/H', async ({ drive, directive }) => {
    const js = await createSpiceEngine({ backend: 'spice-ts-js' });
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      // Core branch references are case-sensitive. WASM normalizes them before compile.
      const source = deck(drive, directive);
      const input = (text: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source: text } });
      const expected = await js.simulate(input(source.replace('vDRIVE', 'Vdrive').replace('VDRIVE', 'Vdrive')), { requestId: 'js' });
      const actual = await wasm.simulate(input(source), { requestId: 'wasm' });
      expect(expected.ok).toBe(true);
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!expected.ok || !actual.ok) return;
      expect(actual.metadata.backend).toBe('spice-ts-wasm');
      const a = actual.data.analyses[0]!;
      const e = expected.data.analyses[0]!;
      expect(a.type).toBe(e.type);
      if (a.type === 'ac' && e.type === 'ac') {
        expect(a.frequencyHz).toEqual(e.frequencyHz);
        for (const key of ['voltagePhasors', 'currentPhasors'] as const) {
          expect(Object.keys(a[key]).sort()).toEqual(Object.keys(e[key]).sort());
          for (const [name, values] of Object.entries(e[key])) {
            expect(a[key][name]).toHaveLength(values.length);
            values.forEach((value, index) => {
              expect(a[key][name]![index]!.magnitude).toBeCloseTo(value.magnitude, 11);
              expect(a[key][name]![index]!.phaseDegrees).toBeCloseTo(value.phaseDegrees, 10);
            });
          }
        }
      } else if ((a.type === 'dc' && e.type === 'dc') || (a.type === 'tran' && e.type === 'tran')) {
        if (a.type === 'dc' && e.type === 'dc') expect(a.axis).toEqual(e.axis);
        for (const key of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[key]).sort()).toEqual(Object.keys(e[key]).sort());
          for (const [name, values] of Object.entries(e[key])) {
            if (a.type === 'tran' && e.type === 'tran') {
              // Match the adaptive JS grid by interpolation, as in RLC parity tests.
              expect(a[key][name]).toHaveLength(a.timeS.length);
              a.timeS.forEach((time, index) => {
                const upper = e.timeS.findIndex(candidate => candidate >= time);
                expect(upper).toBeGreaterThanOrEqual(0);
                const lower = e.timeS[upper] === time ? upper : upper - 1;
                const t0 = e.timeS[lower]!;
                const t1 = e.timeS[upper]!;
                const value = t0 === t1 ? values[upper]! : values[lower]!
                  + (time - t0) / (t1 - t0) * (values[upper]! - values[lower]!);
                expect(a[key][name]![index]).toBeCloseTo(value, 12);
              });
            } else {
              expect(a[key][name]).toHaveLength(values.length);
              values.forEach((value, index) => expect(a[key][name]![index]).toBeCloseTo(value, 12));
            }
          }
        }
      } else throw new Error('Unexpected analysis type');
    } finally {
      await js.close();
      await wasm.close();
    }
  });

  it.each(analyses)('rejects nonlinear/POLY/table controlled sources in $name', async ({ drive, directive }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const card of [
        'Ebad out 0 POLY(1) in 0 0 2', 'Gbad out 0 POLY(1) in 0 0 1m',
        'Fbad out 0 POLY(1) Vdrive 0 2', 'Hbad out 0 POLY(1) Vdrive 0 2k',
        'Ebad out 0 VALUE={V(in)*V(in)}', 'Gbad out 0 VALUE={V(in)*V(in)}',
        'Ebad out 0 TABLE {V(in)} = (0,0) (1,2)', 'Gbad out 0 TABLE {V(in)} = (0,0) (1,2)',
        'Ebad out 0 in 0 {2}', 'Gbad out 0 in 0 {1m}',
      ]) {
        const result = await wasm.simulate({ apiVersion: '1', input: { format: 'spice', source: [
          `Vdrive in 0 ${drive}`, 'Rin in 0 1k', card, 'Rout out 0 1k', directive,
        ].join('\n') } }, { requestId: 'unsupported' });
        expect(result, card).toMatchObject({ ok: false, error: {
          code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { backend: 'spice-ts-wasm' },
        } });
      }
    } finally { await wasm.close(); }
  });
});
