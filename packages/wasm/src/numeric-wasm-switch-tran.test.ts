import { afterAll, describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

const metrics = { fixtures: 0, samples: 0, maxAbsoluteErrorV: 0 };

describe('WASM SW transient parity', () => {
  afterAll(() => process.stdout.write(`SW transient parity ${JSON.stringify(metrics)}\n`));

  it.each([0.2, 0, -0.2])('matches every core timepoint through both transitions with VH=%s', async vh => {
    // Original project-authored RC fixture. Slow edges exercise VT +/- VH;
    // the capacitor forces history-dependent integration after each transition.
    const request: SimulationRequestV1 = {
      apiVersion: '1', input: { format: 'spice', source: `VDD supply 0 5
VCTRL control 0 PULSE(0 2 1u 2u 2u 4u 12u)
S1 supply out control 0 sw
R1 out 0 1k
C1 out 0 1n
.model sw SW(VT=1 VH=${vh} RON=10 ROFF=1e9)
.tran 100n 24u` },
    };
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request, { requestId: 'switch-tran-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const reference = await simulateProtocolV1(request);
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      expect(a?.type).toBe('tran');
      expect(b?.type).toBe('tran');
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient results');
      expect(a.timeS).toEqual(b.timeS);
      expect(Object.keys(a.voltagesV).sort()).toEqual(Object.keys(b.voltagesV).sort());
      for (const [node, values] of Object.entries(b.voltagesV)) {
        expect(a.voltagesV[node]).toHaveLength(values.length);
        for (let i = 0; i < values.length; i++) {
          const error = Math.abs(a.voltagesV[node]![i]! - values[i]!);
          metrics.samples++;
          metrics.maxAbsoluteErrorV = Math.max(metrics.maxAbsoluteErrorV, error);
          expect(error, `${node} at ${b.timeS[i]}s`).toBeLessThanOrEqual(1e-9);
        }
      }
      const output = b.voltagesV.out!;
      expect(output[0]).toBeLessThan(0.01);
      expect(output.some((v, i) => v > 4 && b.timeS[i]! < 7e-6)).toBe(true);
      expect(output.some((v, i) => v < 0.1 && b.timeS[i]! > 11e-6 && b.timeS[i]! < 13e-6)).toBe(true);
      if (vh > 0) {
        // Same voltage inside the hysteresis band, opposite accepted states:
        // rising holds OFF; falling holds ON until control falls below VT-VH.
        const control = b.voltagesV.control!;
        const inBand = (i: number) => control[i]! > 0.9 && control[i]! < 1.1;
        const rising = b.timeS.map((_, i) => i).filter(i => inBand(i) && b.timeS[i]! < 3e-6);
        const falling = b.timeS.map((_, i) => i).filter(i => inBand(i) && b.timeS[i]! > 7e-6 && b.timeS[i]! < 9e-6);
        expect(rising.length).toBeGreaterThan(0);
        expect(falling.length).toBeGreaterThan(0);
        expect(rising.every(i => output[i]! < 0.01)).toBe(true);
        expect(falling.every(i => output[i]! > 4)).toBe(true);
      }
      metrics.fixtures++;
    } finally { await wasm.close(); }
  });
});
