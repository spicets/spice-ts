import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { simulate } from '../index.js';
import { GilbertPeierlsSolver } from './gilbert-peierls.js';
import type { CscMatrix } from './csc-matrix.js';

function matrix(a: number, b: number): CscMatrix {
  return { size: 3, colPtr: Int32Array.from([0, 3, 6, 9]),
    rowIdx: Int32Array.from([0, 1, 2, 0, 1, 2, 0, 1, 2]),
    values: Float64Array.from([0, a, b, 2, 4, 6, 3, 5, 9]) };
}

function fresh(A: CscMatrix): Float64Array {
  const solver = new GilbertPeierlsSolver({ ordering: 'natural' });
  solver.analyzePattern(A);
  solver.factorize(A);
  return solver.solve(Float64Array.from([1, 2, 3]));
}

describe('pivot reuse preserves first-maximum tie order (#1134)', () => {
  it('reuses tied off-preference pivots with bit-identical solutions', () => {
    const A = matrix(1, 1);
    const solver = new GilbertPeierlsSolver({ ordering: 'natural' });
    solver.analyzePattern(A);
    solver.factorize(A);
    solver.solve(Float64Array.from([1, 2, 3]));
    A.values[1] = A.values[2] = 1.1;
    solver.factorize(A);
    expect(solver.pivotReuseFactorizations).toBe(1);
    expect(solver.solve(Float64Array.from([1, 2, 3]))).toEqual(fresh(A));
  });

  it('falls back when an earlier candidate becomes tied with the old pivot', () => {
    const A = matrix(0.9, 1);
    const solver = new GilbertPeierlsSolver({ ordering: 'natural' });
    solver.analyzePattern(A);
    solver.factorize(A);
    A.values[1] = 1;
    solver.factorize(A);
    expect(solver.pivotReuseFactorizations).toBe(0);
    expect(solver.solve(Float64Array.from([1, 2, 3]))).toEqual(fresh(A));
  });

  it('reuses the classic BSIM1 sweep pivots without changing any output bits', async () => {
    const deck = readFileSync(new URL('../../../../benchmarks/corpus/classic/fixtures/spice3f5/bsim1tst.cir', import.meta.url), 'utf8');
    const original = GilbertPeierlsSolver.prototype.factorize;
    let full = 0;
    let reused = 0;
    const spy = vi.spyOn(GilbertPeierlsSolver.prototype, 'factorize').mockImplementation(function (this: GilbertPeierlsSolver, A) {
      const n = this.numericFactorizations;
      const r = this.pivotReuseFactorizations;
      original.call(this, A);
      reused += this.pivotReuseFactorizations - r;
      full += this.numericFactorizations - n - (this.pivotReuseFactorizations - r);
    });
    try {
      const optimized = (await simulate(deck)).dcSweep!;
      expect(reused / (reused + full)).toBeGreaterThan(0.95);
      // New structure identities force the unmodified full factorization path.
      spy.mockImplementation(function (this: GilbertPeierlsSolver, A) {
        original.call(this, { ...A, colPtr: A.colPtr.slice(), rowIdx: A.rowIdx.slice() });
      });
      const reference = (await simulate(deck)).dcSweep!;
      expect(optimized.sweepValues).toEqual(reference.sweepValues);
      expect(optimized.voltages).toEqual(reference.voltages);
      expect(optimized.currents).toEqual(reference.currents);
    } finally {
      spy.mockRestore();
    }
  });
});
