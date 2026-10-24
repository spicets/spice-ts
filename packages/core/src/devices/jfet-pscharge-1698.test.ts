import { describe, expect, it } from 'vitest';
import { MNAAssembler } from '../mna/assembler.js';
import { simulate } from '../simulate.js';
import { JFET } from './jfet.js';
import type { TransientChargeState } from './charge-state.js';

// ngspice-47 psmodel.c qgg/PScharge, default XI=1000, XC=ACGAM=0.
// Static numbers evaluated from the unmodified qgg C function; waveform from
// the identical benchmarks/jfet-off-ic/compare.ts deck, ngspice-47 -b -r.
describe('LEVEL=2 PScharge (#1698 slice 1)', () => {
  for (const p of [1, -1] as const) {
    it(`initializes total gate charge and small-signal capacitances, polarity ${p}`, () => {
      const j = new JFET('J1', [0, 1, -1], { LEVEL: 2, CGS: 1e-9, CGD: 0.5e-9 }, p);
      const a = new MNAAssembler(2, 0);
      a.solution[0] = p * 2;
      a.solution[1] = p * -1;
      const ctx = a.getStampContext();
      j.acceptTransientStep(ctx);
      // PScharge initializes BOTH branch histories to Qgg, not two independent
      // depletion charges. Read through the integrator's current contract.
      const state = (j as unknown as { charges: TransientChargeState }).charges;
      state.begin({ method: 'euler', dt: 1 });
      expect(-state.current(0, 0) / p).toBeCloseTo(-2.2648488854035438e-9, 18);
      expect(-state.current(1, 0) / p).toBeCloseTo(-2.2648488854035438e-9, 18);
      const caps = new Map<string, number>();
      j.stampDynamic({ ...ctx, stampC: (r, c, v) => caps.set(`${r},${c}`, (caps.get(`${r},${c}`) ?? 0) + v) });
      expect(-caps.get('1,0')!).toBeCloseTo(5.2524304047780386e-10, 18);
      expect(caps.get('1,1')!).toBeCloseTo(1.2527940790454638e-9, 18);
    });
    it(`matches ngspice-47 UIC first waveform point, polarity ${p}`, async () => {
      const result = await simulate(`JFET initialization parity
V1 v 0 ${p * 5}
R1 v d 1k
RG g 0 10k
J1 d g 0 JM off ic=${p * 2},${p * -1}
.model JM ${p === 1 ? 'NJF' : 'PJF'} LEVEL=2 CGS=1n CGD=0.5n
.tran 0.1u 10u uic
.end`);
      expect(result.transient!.time[0]).toBe(1e-9);
      expect(Math.abs(result.transient!.voltage('d')[0] / (p * 2.009609529671364) - 1)).toBeLessThan(1e-6);
      expect(Math.abs(result.transient!.voltage('g')[0] / (p * -0.9958931897508324) - 1)).toBeLessThan(1e-6);
    });
  }
});
