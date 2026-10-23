import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT fixtures. Both engines receive identical decks
// and default timestep controls. Saturation exercises TR and forward BC charge.
const charge = 'CJE=20p VJE=0.75 MJE=0.33 CJC=10p VJC=0.8 MJC=0.4 FC=0.5 TF=1n TR=5n';
const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });
const fixtures = ['NPN', 'PNP'].flatMap(polarity => [false, true].map(saturated => {
  const sign = polarity === 'NPN' ? 1 : -1;
  const circuit = `VCC supply 0 ${sign * (saturated ? 0.2 : 5)}
VIN input 0 ${sign * 1.2}
RC supply collector 1k
RB input base ${saturated ? '1k' : '100k'}
RE emitter 0 100
Q1 collector base emitter transistor
.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80 RC=5 RE=2 ${charge})`;
  return { name: `${polarity} ${saturated ? 'saturated' : 'active'}`, circuit };
}));

function deck(circuit: string, analysis: string): string {
  const source = circuit.replace(/^VIN input 0 (.+)$/m, (_, dc: string) => analysis.startsWith('.tran')
    ? `VIN input 0 PULSE(0 ${dc} 10n 2n 2n 30n 60n)`
    : `VIN input 0 ${analysis.startsWith('.ac') ? `DC ${dc} AC 1` : dc}`);
  return `${source}\n${analysis}`;
}

type Signals = Record<string, number[]>;
function compare(actual: Signals, reference: Signals, limit: number): Record<string, number> {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(reference).sort());
  const errors: Record<string, number> = {};
  for (const [name, values] of Object.entries(reference)) {
    expect(actual[name]).toHaveLength(values.length);
    const scale = Math.max(1e-12, ...values.map(Math.abs));
    const error = Math.max(...values.map((value, index) => Math.abs(actual[name]![index]! - value) / scale));
    expect(Number.isFinite(error), name).toBe(true);
    expect(error, name).toBeLessThanOrEqual(limit);
    errors[name] = error;
  }
  return errors;
}

const cases = fixtures.flatMap(fixture => ['.op', '.dc VIN 0 1.2 0.2', '.ac dec 5 1k 1G', '.tran 1n 100n']
  .map(analysis => ({ ...fixture, analysis })));

describe('WASM BJT depletion and transit-time charge', () => {
  it.each(cases)('matches core: $name $analysis', async ({ name, circuit, analysis }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
        const source = deck(circuit, analysis);
        const result = await wasm.simulate(request(source), { requestId: name });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.metadata.backend).toBe('spice-ts-wasm');
        const a = result.data.analyses[0];
        const b = (await simulateProtocolV1(request(source))).analyses[0];
        const errors: Record<string, Record<string, number>> = {};
        if (a?.type === 'ac' && b?.type === 'ac') {
          expect(a.frequencyHz).toEqual(b.frequencyHz);
          for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
            for (const key of ['magnitude', 'phaseDegrees'] as const) {
              const extract = (signals: typeof a[typeof field]): Signals => Object.fromEntries(
                Object.entries(signals).map(([signal, values]) => [signal, values.map(value => value[key])]),
              );
              errors[`${field}.${key}`] = compare(extract(a[field]), extract(b[field]), 1e-6);
            }
          }
        } else if ((a?.type === 'tran' && b?.type === 'tran') || (a?.type === 'dc' && b?.type === 'dc')) {
          if (a.type === 'tran' && b.type === 'tran') {
            // Independent floating-point LU order can change adaptive accepted
            // steps. Compare at the WASM times, linearly sampling core's trace.
            expect(a.timeS[0]).toBe(b.timeS[0]);
            expect(a.timeS.at(-1)).toBe(b.timeS.at(-1));
            for (const field of ['voltagesV', 'currentsA'] as const) {
              const sampled: Signals = {};
              for (const [signal, values] of Object.entries(b[field])) {
                let index = 0;
                sampled[signal] = a.timeS.map(time => {
                  while (index + 1 < b.timeS.length - 1 && b.timeS[index + 1]! < time) index++;
                  const fraction = (time - b.timeS[index]!) / (b.timeS[index + 1]! - b.timeS[index]!);
                  return values[index]! + fraction * (values[index + 1]! - values[index]!);
                });
              }
              errors[field] = compare(a[field], sampled, 1e-4);
            }
            process.stdout.write(`BJT charge parity ${JSON.stringify({ name, analysis, points: [a.timeS.length, b.timeS.length], errors })}\n`);
            return;
          }
          if (a.type === 'dc' && b.type === 'dc') {
            expect(a.axis.values).toHaveLength(b.axis.values.length);
            a.axis.values.forEach((value, i) => expect(value).toBeCloseTo(b.axis.values[i]!, 14));
          }
          errors.voltagesV = compare(a.voltagesV, b.voltagesV, a.type === 'tran' ? 1e-4 : 1e-6);
          errors.currentsA = compare(a.currentsA, b.currentsA, a.type === 'tran' ? 1e-4 : 1e-6);
        } else if (a?.type === 'op' && b?.type === 'op') {
          const arrays = (signals: Record<string, number>): Signals => Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, [value]]));
          errors.voltagesV = compare(arrays(a.voltagesV), arrays(b.voltagesV), 1e-6);
          errors.currentsA = compare(arrays(a.currentsA), arrays(b.currentsA), 1e-6);
        } else throw new Error('Mismatched analyses');
        process.stdout.write(`BJT charge parity ${JSON.stringify({ name, analysis, errors })}\n`);
    } finally { await wasm.close(); }
  });

  it.each(['CJE=20p', 'CJC=10p', 'TF=1n', 'TR=5n'])(
    'does not ignore %s in AC or alter DC', async parameter => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const circuit = fixtures[1]!.circuit;
        for (const analysis of ['.op', '.ac dec 5 1k 1G']) {
          const responses = await Promise.all(['', parameter].map(params => wasm.simulate(
            request(deck(circuit.replace(charge, params), analysis)), { requestId: params || 'static' },
          )));
          const [a, b] = responses.map(result => {
            if (!result.ok) throw new Error(result.error.message);
            return result.data.analyses[0];
          });
          if (a?.type === 'op' && b?.type === 'op') {
            expect(a.voltagesV).toEqual(b.voltagesV);
            expect(a.currentsA).toEqual(b.currentsA);
          } else if (a?.type === 'ac' && b?.type === 'ac') {
            const delta = Math.max(...a.voltagePhasors.collector!.map((value, i) =>
              Math.abs(value.magnitude - b.voltagePhasors.collector![i]!.magnitude)));
            expect(delta).toBeGreaterThan(1e-3);
          } else throw new Error('Mismatched analyses');
        }
      } finally { await wasm.close(); }
    },
  );

  it.each(['.op', '.dc VIN 0 1 0.2', '.ac lin 2 1 10', '.tran 1n 10n'])(
    'retains structured rejection outside the charge subset: %s', async analysis => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        for (const parameter of ['XTF', 'VTF', 'ITF', 'PTF', 'CJS']) {
          const source = `${fixtures[0]!.circuit.replace('TR=5n)', `TR=5n ${parameter}=1)`)}\n${analysis}`;
          expect(await wasm.simulate(request(source), { requestId: parameter })).toMatchObject({
            ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'bjt-model-parameter' } },
          });
        }
      } finally { await wasm.close(); }
    },
  );
});
