import { afterAll, describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

// Original MIT project fixtures. Positive VCTRL gives positive VSENSE current.
// W is the only nonlinear device, so the budget test requires its OP solve.
const circuit = (control: number, state = '', modelFirst = false,
  model = 'IT=1m IH=200u RON=10 ROFF=1meg') => {
  const cards = [
    'VIN in 0 DC 5 AC 1',
    `VCTRL control 0 DC ${control}`,
    'RCTRL control sense 1k',
    'VSENSE sense 0 0',
    'R1 in out 1k',
    'C1 out 0 10n',
    `W1 out 0 VSENSE sw ${state}`,
  ];
  const modelCard = `.model sw CSW(${model})`;
  if (modelFirst) cards.unshift(modelCard);
  else cards.push(modelCard);
  return `${cards.join('\n')}\n.ac dec 10 1 1meg`;
};

const fixtures = [false, true].flatMap(modelFirst => [
  { name: 'biased ON (2mA)', control: 2, state: '' },
  { name: 'biased OFF (0mA)', control: 0, state: '' },
  ...['', 'ON', 'OFF'].map(state => ({
    name: `inside IH band (1.1mA), ${state || 'default'}`, control: 1.1, state,
  })),
].map(fixture => ({ ...fixture, modelFirst })));
const metrics = { fixtures: 0, phasors: 0, maxRelativeMagnitudeError: 0,
  maxZeroAbsoluteMagnitudeError: 0, maxWrappedPhaseErrorRadians: 0 };

describe('current-controlled CSW WASM AC parity', () => {
  afterAll(() => process.stdout.write(`CSW AC parity ${JSON.stringify(metrics)}\n`));

  it.each(fixtures)('matches core AC: $name, model first=$modelFirst', async ({ control, state, modelFirst }) => {
    const input = request(circuit(control, state, modelFirst));
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const reference = await simulateProtocolV1(input);
      const actual = await wasm.simulate(input, { requestId: 'csw-ac-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      expect(wasm.capabilities.numericWasm?.devicesByAnalysis.ac).toContain('W');
      expect(actual.data.analyses).toHaveLength(1);
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      if (a?.type !== 'ac' || b?.type !== 'ac') throw new Error('Expected matching AC results');
      expect(a.frequencyHz).toEqual(b.frequencyHz);
      expect(b.frequencyHz.length).toBeGreaterThan(1);
      expect(b.frequencyHz[0]).toBe(1);
      expect(b.frequencyHz.at(-1)).toBeCloseTo(1e6, 6);
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
            // Same contract as SW AC: strict relative error for nonzero
            // magnitudes, 1e-15 absolute at zero, wrapped phase in radians.
            if (expected.magnitude === 0) {
              metrics.maxZeroAbsoluteMagnitudeError = Math.max(metrics.maxZeroAbsoluteMagnitudeError, absoluteError);
              expect(absoluteError, label).toBeLessThanOrEqual(1e-15);
            } else {
              const relativeError = absoluteError / Math.abs(expected.magnitude);
              const delta = (value.phaseDegrees - expected.phaseDegrees) * Math.PI / 180;
              const phaseError = Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
              metrics.maxRelativeMagnitudeError = Math.max(metrics.maxRelativeMagnitudeError, relativeError);
              metrics.maxWrappedPhaseErrorRadians = Math.max(metrics.maxWrappedPhaseErrorRadians, phaseError);
              expect(relativeError, `${label} magnitude`).toBeLessThanOrEqual(1e-9);
              expect(phaseError, `${label} phase`).toBeLessThanOrEqual(1e-9);
            }
          });
        }
      }
      metrics.fixtures++;
    } finally { await wasm.close(); }
  });

  it('propagates OP non-convergence for a CSW-only nonlinear deck', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate({ ...request(circuit(2)), options: { maxIterations: 1 } }, { requestId: 'csw-ac-budget' }))
        .toMatchObject({ ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' } });
    } finally { await wasm.close(); }
  });

  it.each([false, true])('retains numeric model validation, model first=%s', async modelFirst => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(circuit(2, '', modelFirst, 'IT=nope')), { requestId: 'csw-ac-model' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'switch-model-parameter' } } });
    } finally { await wasm.close(); }
  });
});
