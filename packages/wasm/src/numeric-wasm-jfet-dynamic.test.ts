import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});
// Original project-authored MIT fixtures. Resistive gate drive exposes both
// junction charges; the source resistor and RD/RS exercise internal OP nodes.
const circuit = (polarity: string, analysis: 'tran' | 'ac', gate = -0.5) => {
  const sign = polarity === 'NJF' ? 1 : -1;
  const drive = analysis === 'tran'
    ? `PULSE(${sign * gate} ${sign * (gate + 0.15)} 1u 100n 100n 2u 4u)`
    : `DC ${sign * gate} AC 1`;
  return `VDD supply 0 ${sign * 5}
VG input 0 ${drive}
RG input gate 10k
RL supply out 1k
RS source 0 100
J1 out gate source channel 2
.model channel ${polarity}(LEVEL=1 VTO=-2 BETA=100u LAMBDA=0.02 IS=1e-14 N=1 RD=20 RS=30 CGS=100p CGD=50p PB=0.8 FC=0.4)
${analysis === 'tran' ? '.tran 100n 8u' : '.ac dec 10 1 1e9'}`;
};

const fixtures = ['NJF', 'PJF'].flatMap(polarity => [
  { polarity: `${polarity} reverse gate`, source: circuit(polarity, 'tran') },
  { polarity: `${polarity} forward gate above FC*PB`, source: circuit(polarity, 'tran', 0.6) },
]);

describe('bounded JFET WASM dynamics', () => {
  it('advertises JFET support for all four numeric analyses', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const analysis of ['op', 'dc', 'tran', 'ac'] as const) {
        expect(engine.capabilities.numericWasm?.devicesByAnalysis[analysis]).toContain('J');
      }
    } finally { await engine.close(); }
  });

  it.each(['tran', 'ac'] as const)('rejects unsupported JFET model parameters in %s', async analysis => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const parameter of ['LEVEL=2', 'LEVEL=2 LEVEL=1', 'TNOM=27', 'B=1', 'CGS={1}']) {
        const source = circuit('NJF', analysis).replace('LEVEL=1', parameter);
        expect(await engine.simulate(request(source), { requestId: 'unsupported-jfet' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'jfet-model-parameter' } } });
      }
    } finally { await engine.close(); }
  });

  it('returns structured AC operating-point non-convergence', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate({ ...request(circuit('NJF', 'ac')), options: { maxIterations: 1 } }, { requestId: 'jfet-ac-budget' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } });
    } finally { await engine.close(); }
  });
  it.each(['NJF', 'PJF'])('matches core AC linearised at the WASM OP: %s', async polarity => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const input = request(circuit(polarity, 'ac'));
      const actual = await engine.simulate(input, { requestId: 'jfet-ac' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('Expected AC');
      expect(a.frequencyHz).toEqual(b.frequencyHz);
      expect(a.frequencyHz).toHaveLength(91);
      // Nonzero low-frequency gain and high-frequency rolloff rule out a
      // zero-bias linearisation or a missing dynamic stamp.
      expect(a.voltagePhasors.out![0]!.magnitude).toBeGreaterThan(0.1);
      expect(a.voltagePhasors.out!.at(-1)!.magnitude).toBeLessThan(a.voltagePhasors.out![0]!.magnitude / 10);
      let maxRelativeError = 0;
      for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [name, values] of Object.entries(b[field])) {
          expect(a[field][name]).toHaveLength(values.length);
          values.forEach((value, i) => {
            for (const key of ['magnitude', 'phaseDegrees'] as const) {
              const error = Math.abs(a[field][name]![i]![key] - value[key]) / Math.max(Math.abs(value[key]), 1e-30);
              maxRelativeError = Math.max(maxRelativeError, error);
            }
          });
        }
      }
      process.stdout.write(`JFET AC ${JSON.stringify({ polarity, points: a.frequencyHz.length, maxRelativeError })}\n`);
      expect(maxRelativeError).toBeLessThanOrEqual(1e-9);
    } finally { await engine.close(); }
  });
  it.each(fixtures)('matches core transient junction charge: $polarity', async ({ polarity, source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await engine.simulate(request(source), { requestId: 'jfet-tran' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(request(source))).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(a.timeS).toHaveLength(b.timeS.length);
      expect(a.timeS[0]).toBe(0);
      expect(a.timeS.at(-1)).toBe(b.timeS.at(-1));
      let maxRelativeError = 0;
      const maxTimeDelta = Math.max(...a.timeS.map((time, i) => Math.abs(time - b.timeS[i]!)));
      expect(maxTimeDelta).toBeLessThanOrEqual(1e-12 * b.timeS.at(-1)!);
      expect(Math.max(...a.voltagesV.out!) - Math.min(...a.voltagesV.out!)).toBeGreaterThan(0.01);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [name, values] of Object.entries(b[field])) {
          expect(a[field][name]).toHaveLength(values.length);
          const peak = Math.max(...values.map(Math.abs));
          values.forEach((value, i) => {
            const error = Math.abs(a[field][name]![i]! - value) / Math.max(peak, 1e-30);
            maxRelativeError = Math.max(maxRelativeError, error);
          });
        }
      }
      process.stdout.write(`JFET transient ${JSON.stringify({ polarity, points: a.timeS.length, maxTimeDelta, maxRelativeError })}\n`);
      expect(maxRelativeError).toBeLessThanOrEqual(1e-9);
    } finally { await engine.close(); }
  });
});
