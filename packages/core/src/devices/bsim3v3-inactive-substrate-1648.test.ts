import { describe, expect, it, vi } from 'vitest';
import { MNAAssembler } from '../mna/assembler.js';
import { BSIM3v3 } from './bsim3v3.js';

describe('BSIM3 structurally inactive substrate current (#1648)', () => {
  it.each([1, -1])('omits inactive stamps but preserves enabled topology, polarity %s', polarity => {
    const models: Record<string, number>[] = [{}, { ALPHA0: 0.1, BETA0: 0 }, { ALPHA0: 0.1 }, { ALPHA1: 1e5 }];
    for (const params of models) {
      const device = new BSIM3v3('M1', [0, 1, 2, 3], params, {}, polarity);
      const inactive = device.size.alpha0 + device.size.alpha1 * device.size.leff <= 0 || device.size.beta0 <= 0;
      const asm = new MNAAssembler(4, 0);

      for (const temperature of [27, 70]) {
        device.setTemperature(temperature);
        for (const drain of [0.8, -0.1, 0]) {
          asm.clear();
          const ctx = asm.getStampContext();
          const stamp = vi.spyOn(ctx, 'stampG');
          asm.solution.set([polarity * drain, polarity * 1.2, 0, polarity * -0.2]);
          stamp.mockClear();
          device.stamp(ctx);
          // Seven junction entries, eight channel entries, and (only when
          // enabled by the size parameters) eight substrate entries, even
          // when the instantaneous substrate current happens to be zero.
          expect(stamp).toHaveBeenCalledTimes(inactive ? 15 : 23);
          stamp.mockRestore();
          asm.lockTopology();
        }
      }
    }
  });
});
