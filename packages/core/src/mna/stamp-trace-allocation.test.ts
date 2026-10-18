import { expect, it, vi } from 'vitest';
import { MNAAssembler } from './assembler.js';

it('allocates one interleaved trace buffer per stamp pass, including growth', () => {
  const asm = new MNAAssembler(1, 0);
  asm.getStampContext().stampG(0, 0, 1);
  asm.lockTopology();
  const NativeInt32Array = Int32Array;
  let allocations = 0;
  vi.stubGlobal('Int32Array', new Proxy(NativeInt32Array, {
    construct(target, args) {
      allocations++;
      return Reflect.construct(target, args);
    },
  }));
  try {
    const ctx = asm.getStampContext();
    // More than the initial trace capacity, with alternating G/C stamps.
    for (let i = 0; i < 200; i++) {
      ctx.stampG(0, 0, i);
      ctx.stampC(0, 0, -i);
    }
    // Initial capacity 68, then 200 and 464. One buffer per allocation.
    expect(allocations).toBe(3);
    asm.clear();
    const replay = asm.getStampContext();
    for (let i = 0; i < 200; i++) {
      replay.stampG(0, 0, i);
      replay.stampC(0, 0, -i);
    }
    expect(allocations).toBe(3);
    expect(asm.gValues[asm.diagIdx[0]]).toBe(19900);
    expect(asm.cValues[asm.diagIdx[0]]).toBe(-19900);
  } finally {
    vi.unstubAllGlobals();
  }
});
