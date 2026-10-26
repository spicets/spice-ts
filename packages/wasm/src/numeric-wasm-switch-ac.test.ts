import { afterAll, describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

// Original project-authored RC fixtures. S is the only nonlinear device, so
// successful AC and the iteration-budget test require the switch OP path itself.
const circuit = (control: number, vh = 0.2, state = '', modelFirst = false,
  model = `VT=1 VH=${vh} RON=10 ROFF=1meg`) => {
  const cards = [
    'VIN in 0 DC 5 AC 1',
    `VCTRL ctrl 0 DC ${control}`,
    'R1 in out 1k',
    'C1 out 0 10n',
    `S1 out 0 ctrl 0 sw1${state ? ` ${state}` : ''}`,
  ];
  const modelCard = `.model sw1 SW(${model})`;
  if (modelFirst) cards.unshift(modelCard);
  else cards.push(modelCard);
  return `${cards.join('\n')}\n.ac dec 10 1 1meg`;
};

const fixtures = [false, true].flatMap(modelFirst => [
  { name: 'biased ON', control: 2, vh: 0.2, state: '' },
  { name: 'biased OFF', control: 0, vh: 0.2, state: '' },
  ...['', 'ON', 'OFF'].map(state => ({ name: `positive VH band ${state || 'default'}`, control: 1, vh: 0.2, state })),
  ...[0, -0.2].flatMap(vh => [0, 1, 2].map(control => ({ name: `VH=${vh} control=${control}`, control, vh, state: '' }))),
].map(({ name, control, vh, state }) => ({
  name: `${name}, model ${modelFirst ? 'before' : 'after'} instance`,
  source: circuit(control, vh, state, modelFirst),
})));

const metrics = {
  fixtures: 0, phasors: 0, zeroMagnitudeSamples: 0,
  maxRelativeMagnitudeError: 0, maxZeroAbsoluteMagnitudeError: 0,
  maxWrappedPhaseErrorRadians: 0, maxRelativeFrequencyError: 0,
};

// For a truly zero reference magnitude, allow only 1e-15 absolute (V or A),
// never a relative-error denominator floor. Phase is undefined at zero and is
// compared only for nonzero reference phasors, with a wrapped radians metric.
const zeroMagnitudeTolerance = 1e-15;

describe('voltage-controlled SW WASM AC parity', () => {
  afterAll(() => process.stdout.write(`SW AC parity ${JSON.stringify(metrics)}\n`));

  it.each(fixtures)('matches all core AC phasors and frequencies: $name', async ({ source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      // Core's acceptedState small-signal behavior is the oracle, including
      // ROFF after OP for some ON biases; do not substitute conventional RON.
      const reference = await simulateProtocolV1(request(source));
      const actual = await wasm.simulate(request(source), { requestId: 'switch-ac-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      expect(actual.data.analyses).toHaveLength(1);
      expect(reference.analyses).toHaveLength(1);
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('Expected matching AC results');
      expect(a.frequencyHz).toHaveLength(b.frequencyHz.length);
      expect(b.frequencyHz.length).toBeGreaterThan(1);
      expect(b.frequencyHz[0]).toBe(1);
      expect(b.frequencyHz.at(-1)).toBeCloseTo(1e6, 6);
      b.frequencyHz.forEach((frequency, index) => {
        const error = Math.abs(a.frequencyHz[index]! - frequency) / frequency;
        metrics.maxRelativeFrequencyError = Math.max(metrics.maxRelativeFrequencyError, error);
        expect(error, `frequency[${index}]`).toBeLessThanOrEqual(1e-9);
      });
      for (const field of ['voltagePhasors', 'currentPhasors'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        expect(Object.keys(b[field]).length).toBeGreaterThan(0);
        for (const [signal, values] of Object.entries(b[field])) {
          expect(values).toHaveLength(b.frequencyHz.length);
          expect(a[field][signal]).toHaveLength(values.length);
          values.forEach((expected, index) => {
            const value = a[field][signal]![index]!;
            const label = `${field}.${signal}[${index}]`;
            const absoluteError = Math.abs(value.magnitude - expected.magnitude);
            metrics.phasors++;
            if (expected.magnitude === 0) {
              metrics.zeroMagnitudeSamples++;
              metrics.maxZeroAbsoluteMagnitudeError = Math.max(metrics.maxZeroAbsoluteMagnitudeError, absoluteError);
              expect(absoluteError, `${label} zero magnitude`).toBeLessThanOrEqual(zeroMagnitudeTolerance);
            } else {
              const relativeError = absoluteError / Math.abs(expected.magnitude);
              const phaseDelta = (value.phaseDegrees - expected.phaseDegrees) * Math.PI / 180;
              const phaseError = Math.abs(Math.atan2(Math.sin(phaseDelta), Math.cos(phaseDelta)));
              metrics.maxRelativeMagnitudeError = Math.max(metrics.maxRelativeMagnitudeError, relativeError);
              metrics.maxWrappedPhaseErrorRadians = Math.max(metrics.maxWrappedPhaseErrorRadians, phaseError);
              expect(relativeError, `${label} magnitude`).toBeLessThanOrEqual(1e-9);
              expect(phaseError, `${label} wrapped phase radians`).toBeLessThanOrEqual(1e-9);
            }
          });
        }
      }
      metrics.fixtures++;
    } finally { await wasm.close(); }
  });

  it.each([false, true].flatMap(modelFirst =>
    ['VT={1}', 'VH=nope', 'RON={10}', 'ROFF=bogus'].map(model => ({ modelFirst, model })),
  ))('rejects nonnumeric AC SW parameter $model (model first: $modelFirst)', async ({ modelFirst, model }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(circuit(2, 0.2, '', modelFirst, model)), { requestId: 'switch-ac-model' }))
        .toMatchObject({ ok: false, error: {
          code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'switch-model-parameter' },
        } });
    } finally { await wasm.close(); }
  });

  it('propagates structured OP non-convergence for an SW-only nonlinear deck', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate({ ...request(circuit(2)), options: { maxIterations: 1 } }, { requestId: 'switch-ac-budget' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } });
    } finally { await wasm.close(); }
  });
});
