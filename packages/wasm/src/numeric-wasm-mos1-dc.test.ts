import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT fixtures. One tolerance policy for every circuit.
const fixtures = ['NMOS', 'PMOS'].flatMap(polarity => {
  const sign = polarity === 'NMOS' ? 1 : -1;
  const circuit = `VDD supply 0 ${sign * 5}\nVG gate 0 ${sign * 3}\nRD supply drain 1k\nRS source 0 100\nM1 drain gate source 0 channel W=10u L=1u\n.model channel ${polarity}(LEVEL=1 VTO=${sign * 0.7} KP=100u LAMBDA=0.02 GAMMA=0.4 PHI=0.6)`;
  return [
    { name: `${polarity} Id-Vgs forward`, source: `${circuit}\n.dc VG 0 ${sign * 3} ${sign * 0.1}` },
    { name: `${polarity} Id-Vgs reverse`, source: `${circuit}\n.dc VG ${sign * 3} 0 ${-sign * 0.1}` },
    { name: `${polarity} Id-Vds forward`, source: `${circuit}\n.dc VDD 0 ${sign * 5} ${sign * 0.25}` },
    { name: `${polarity} Id-Vds reverse`, source: `${circuit}\n.dc VDD ${sign * 5} 0 ${-sign * 0.25}` },
  ];
});
const inverter = 'VDD supply 0 3\nVIN gate 0 0\nMN out gate 0 0 nch W=10u L=1u\nMP out gate supply supply pch W=20u L=1u\n.model nch NMOS(LEVEL=1 VTO=0.7 KP=100u LAMBDA=0.02)\n.model pch PMOS(LEVEL=1 VTO=-0.7 KP=50u LAMBDA=0.02)';
fixtures.push(
  { name: 'CMOS VTC forward', source: `${inverter}\n.dc VIN 0 3 0.1` },
  { name: 'CMOS VTC reverse', source: `${inverter}\n.dc VIN 3 0 -0.1` },
);
const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options,
});

describe('bounded MOS1 WASM DC sweeps', () => {
  it.each(fixtures)('matches core at every point: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'mos1-dc-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const reference = await simulateProtocolV1(request(source));
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      expect(a?.type).toBe('dc');
      expect(b?.type).toBe('dc');
      if (a?.type !== 'dc' || b?.type !== 'dc') throw new Error('Expected DC results');
      expect(a.axis.values).toHaveLength(name.includes('Id-Vds') ? 21 : 31);
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
      process.stdout.write(`MOS1 DC parity ${JSON.stringify({ name, points: a.axis.values.length, samples, maxAbsoluteError, maxRelativeError })}\n`);
    } finally { await wasm.close(); }
  });

  it.each(['LEVEL=2', 'CGSO=1p', 'TOX=10n', 'RSH={10}', 'TNOM=27'])(
    'rejects unsupported DC model option %s', async parameter => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const source = fixtures[0]!.source.replace('LEVEL=1', parameter);
        expect(await wasm.simulate(request(source), { requestId: 'mos1-dc-unsupported' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'mosfet-model-parameter' } },
        });
      } finally { await wasm.close(); }
    },
  );

  it('rejects unsupported DC instance options', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const source = fixtures[0]!.source.replace('W=10u L=1u', 'W=10u L=1u M=2');
      expect(await wasm.simulate(request(source), { requestId: 'mos1-dc-instance' })).toMatchObject({
        ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'mosfet-form' } },
      });
    } finally { await wasm.close(); }
  });

  it('preserves the bounded per-point iteration budget', async () => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(fixtures[0]!.source, { maxIterations: 1 }), { requestId: 'mos1-dc-budget' })).toMatchObject({
        ok: false, error: { code: 'CONVERGENCE_FAILED', phase: 'solve' },
      });
    } finally { await wasm.close(); }
  });
});
