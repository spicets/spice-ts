import { describe, it, expect } from 'vitest';
import { SparseMatrix } from './sparse-matrix.js';
import { toCsc } from './csc-matrix.js';
import { ComplexSparseSolver } from './complex-sparse-solver.js';
import { SingularMatrixError } from '../errors.js';

describe('ComplexSparseSolver', () => {
  it.each([[2, 1], [1, 2]])('divides large finite pivots without squaring: %s + j%s', (real, imaginary) => {
    const g = new SparseMatrix(2);
    const c = new SparseMatrix(2);
    const coefficients = [[2, 1], [1, 3]];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        g.add(row, col, coefficients[row][col] * real * 1e200);
        c.add(row, col, coefficients[row][col] * imaginary * 1e200);
      }
    }
    const gc = toCsc(g).csc, cc = toCsc(c).csc;
    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gc, cc);
    // Second factorization exercises the pivot-reuse division as well.
    for (const omega of [1, 2]) {
      solver.factorize(gc, cc, omega);
      const expectedRe = [1, 2], expectedIm = [1, -1];
      const br = new Float64Array(2), bi = new Float64Array(2);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          const a = coefficients[row][col] * 1e200;
          br[row] += a * (real * expectedRe[col] - omega * imaginary * expectedIm[col]);
          bi[row] += a * (real * expectedIm[col] + omega * imaginary * expectedRe[col]);
        }
      }
      const [xr, xi] = solver.solve(br, bi);
      for (let i = 0; i < 2; i++) {
        expect(xr[i]).toBeCloseTo(expectedRe[i], 13);
        expect(xi[i]).toBeCloseTo(expectedIm[i], 13);
      }
    }
  });

  it('throws a typed error with structural branch identity on a singular pivot', () => {
    const G = new SparseMatrix(2);
    G.add(0, 0, 1);
    const C = new SparseMatrix(2);
    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;
    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc, [
      { kind: 'node', name: 'out' },
      { kind: 'branch', name: 'Vdrive' },
    ]);

    let thrown: unknown;
    try {
      solver.factorize(gCsc, cCsc, 1);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SingularMatrixError);
    expect(thrown).toMatchObject({
      involvedNodes: [],
      involvedBranches: ['Vdrive'],
      pivotIndex: 1,
    });
  });

  it('applies updates to explicitly stamped zeros that fill in during elimination', () => {
    // Column 2 holds an explicit structural zero at row 1. Eliminating column 0
    // turns it into -0.5, so U[1,2] must still be formed (mirrors the real
    // Gilbert-Peierls solver's fill-activation tracking).
    const G = new SparseMatrix(3);
    G.add(0, 0, 2); G.add(0, 2, 1);
    G.add(1, 0, 1); G.add(1, 1, 2); G.touch(1, 2);
    G.add(2, 1, 1); G.add(2, 2, 3);
    const C = new SparseMatrix(3);
    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;

    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc);
    solver.factorize(gCsc, cCsc, 1);
    const [xRe, xIm] = solver.solve(new Float64Array([1, 0, 0]), new Float64Array(3));

    const dense = [[2, 0, 1], [1, 2, 0], [0, 1, 3]];
    const b = [1, 0, 0];
    for (let row = 0; row < 3; row++) {
      const residual = dense[row].reduce((sum, value, column) => sum + value * xRe[column], 0) - b[row];
      expect(Math.abs(residual)).toBeLessThan(1e-14);
      expect(Math.abs(xIm[row])).toBeLessThan(1e-14);
    }
  });

  it('solves a 2x2 complex system', () => {
    // (G + jωC)x = b where G = [[2, 1], [1, 3]], C = [[1, 0], [0, 1]], ω = 1
    // So A = [[2+j, 1], [1, 3+j]]
    const G = new SparseMatrix(2);
    G.add(0, 0, 2); G.add(0, 1, 1);
    G.add(1, 0, 1); G.add(1, 1, 3);
    const C = new SparseMatrix(2);
    C.add(0, 0, 1); C.add(1, 1, 1);

    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;

    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc);
    solver.factorize(gCsc, cCsc, 1.0); // omega = 1

    // b = [1+0j, 0+0j]
    const [xRe, xIm] = solver.solve(
      new Float64Array([1, 0]),
      new Float64Array([0, 0]),
    );

    // Verify: A * x = b (multiply back)
    // A = [[2+j, 1], [1, 3+j]]
    // b0 = (2+j)*x0 + 1*x1 should = 1+0j
    // b1 = 1*x0 + (3+j)*x1 should = 0+0j
    const b0re = 2 * xRe[0] - 1 * xIm[0] + xRe[1];
    const b0im = 1 * xRe[0] + 2 * xIm[0] + xIm[1];
    const b1re = xRe[0] + 3 * xRe[1] - 1 * xIm[1];
    const b1im = xIm[0] + 1 * xRe[1] + 3 * xIm[1];

    expect(b0re).toBeCloseTo(1, 10);
    expect(b0im).toBeCloseTo(0, 10);
    expect(b1re).toBeCloseTo(0, 10);
    expect(b1im).toBeCloseTo(0, 10);
  });

  it('reuses pattern across different omega values', () => {
    const G = new SparseMatrix(2);
    G.add(0, 0, 2); G.add(0, 1, 1);
    G.add(1, 0, 1); G.add(1, 1, 3);
    const C = new SparseMatrix(2);
    C.add(0, 0, 1); C.add(1, 1, 1);

    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;

    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc);

    // Solve at omega=1
    solver.factorize(gCsc, cCsc, 1.0);
    const [x1Re] = solver.solve(new Float64Array([1, 0]), new Float64Array([0, 0]));

    // Solve at omega=10 (reuse pattern)
    solver.factorize(gCsc, cCsc, 10.0);
    const [x2Re] = solver.solve(new Float64Array([1, 0]), new Float64Array([0, 0]));

    // Solutions should be different
    expect(x1Re[0]).not.toBeCloseTo(x2Re[0], 5);
  });

  it('solves a purely imaginary system (G=0)', () => {
    // A = j*omega*C with C = [[1, 0], [0, 2]], omega = 1
    // A = [[j, 0], [0, 2j]]
    // Ax = b => x = A^{-1} b
    // b = [1+0j, 0+2j]
    // x0 = 1/j = -j, x1 = 2j/(2j) = 1
    const G = new SparseMatrix(2);
    // G is all zero but we need diagonal structure for non-singularity check
    // Actually G has no entries - the pattern comes from C only
    const C = new SparseMatrix(2);
    C.add(0, 0, 1); C.add(1, 1, 2);

    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;

    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc);
    solver.factorize(gCsc, cCsc, 1.0);

    const [xRe, xIm] = solver.solve(
      new Float64Array([1, 0]),
      new Float64Array([0, 2]),
    );

    // x0 = 1/j = -j => (0, -1)
    expect(xRe[0]).toBeCloseTo(0, 10);
    expect(xIm[0]).toBeCloseTo(-1, 10);
    // x1 = 2j/(2j) = 1 => (1, 0)
    expect(xRe[1]).toBeCloseTo(1, 10);
    expect(xIm[1]).toBeCloseTo(0, 10);
  });

  it('solves a 3x3 complex system', () => {
    // G = [[4, -1, 0], [-1, 4, -1], [0, -1, 4]]  (tridiagonal)
    // C = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]       (identity)
    // omega = 2
    // A = G + j*2*C = [[4+2j, -1, 0], [-1, 4+2j, -1], [0, -1, 4+2j]]
    const G = new SparseMatrix(3);
    G.add(0, 0, 4); G.add(0, 1, -1);
    G.add(1, 0, -1); G.add(1, 1, 4); G.add(1, 2, -1);
    G.add(2, 1, -1); G.add(2, 2, 4);
    const C = new SparseMatrix(3);
    C.add(0, 0, 1); C.add(1, 1, 1); C.add(2, 2, 1);

    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;

    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc);
    solver.factorize(gCsc, cCsc, 2.0);

    const bRe = new Float64Array([1, 0, 0]);
    const bIm = new Float64Array([0, 0, 0]);
    const [xRe, xIm] = solver.solve(bRe, bIm);

    // Verify by multiplying A*x and checking it equals b
    // Row 0: (4+2j)*x0 + (-1)*x1
    const r0re = 4 * xRe[0] - 2 * xIm[0] - xRe[1];
    const r0im = 4 * xIm[0] + 2 * xRe[0] - xIm[1];
    // Row 1: (-1)*x0 + (4+2j)*x1 + (-1)*x2
    const r1re = -xRe[0] + 4 * xRe[1] - 2 * xIm[1] - xRe[2];
    const r1im = -xIm[0] + 4 * xIm[1] + 2 * xRe[1] - xIm[2];
    // Row 2: (-1)*x1 + (4+2j)*x2
    const r2re = -xRe[1] + 4 * xRe[2] - 2 * xIm[2];
    const r2im = -xIm[1] + 4 * xIm[2] + 2 * xRe[2];

    expect(r0re).toBeCloseTo(1, 10);
    expect(r0im).toBeCloseTo(0, 10);
    expect(r1re).toBeCloseTo(0, 10);
    expect(r1im).toBeCloseTo(0, 10);
    expect(r2re).toBeCloseTo(0, 10);
    expect(r2im).toBeCloseTo(0, 10);
  });

  it('handles complex RHS', () => {
    const G = new SparseMatrix(2);
    G.add(0, 0, 1); G.add(1, 1, 1);
    const C = new SparseMatrix(2);
    C.add(0, 0, 1); C.add(1, 1, 1);

    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;

    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc);
    solver.factorize(gCsc, cCsc, 1.0);

    // A = [[1+j, 0], [0, 1+j]], b = [1+j, 2+2j]
    // x = b/A => x0 = (1+j)/(1+j) = 1, x1 = (2+2j)/(1+j) = 2
    const [xRe, xIm] = solver.solve(
      new Float64Array([1, 2]),
      new Float64Array([1, 2]),
    );

    expect(xRe[0]).toBeCloseTo(1, 10);
    expect(xIm[0]).toBeCloseTo(0, 10);
    expect(xRe[1]).toBeCloseTo(2, 10);
    expect(xIm[1]).toBeCloseTo(0, 10);
  });

  it('rejects a diagonal that collapses by cancellation (#732 threshold pivoting)', () => {
    // Column 1 of the reduced matrix after eliminating column 0 is
    // [1 + 1e-14 - 1, 1] = [~1e-14, 1]: the natural diagonal survives the old
    // ">= 1e-18" test but is 1e-14 of the column maximum.
    const G = new SparseMatrix(3);
    G.add(0, 0, 1); G.add(0, 1, 1);
    G.add(1, 0, 1); G.add(1, 1, 1 + 1e-14); G.add(1, 2, 1);
    G.add(2, 1, 1); G.add(2, 2, 1);
    const C = new SparseMatrix(3);
    const gCsc = toCsc(G).csc;
    const cCsc = toCsc(C).csc;
    const solver = new ComplexSparseSolver();
    solver.analyzePattern(gCsc, cCsc);
    solver.factorize(gCsc, cCsc, 1);
    const b = [0.3, 0.7, 1.9];
    const [xRe, xIm] = solver.solve(new Float64Array(b), new Float64Array(3));
    // Exact, with e = (1 + 1e-14) - 1: x1 = (b1 - b0 - b2) / (e - 1), x0 = b0 - x1, x2 = b2 - x1.
    // Keeping the 1e-14 pivot gives x1 = 1.49444 (error 5.6e-3).
    const e = (1 + 1e-14) - 1;
    const x1 = (b[1] - b[0] - b[2]) / (e - 1);
    const exact = [b[0] - x1, x1, b[2] - x1];
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(xRe[i] - exact[i]), `x${i}`).toBeLessThan(1e-12);
      expect(xIm[i]).toBe(0);
    }
  });

  it('matches a dense pivoted solve on random sparse systems with weak diagonals', () => {
    // Off-pattern pivots create fill the symbolic phase did not predict; the
    // factor buffers must grow instead of silently dropping entries.
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 120; trial++) {
      const n = 4 + Math.floor(rand() * 12);
      const G = new SparseMatrix(n);
      const C = new SparseMatrix(n);
      const dense: Array<Array<[number, number]>> =
        Array.from({ length: n }, () => Array.from({ length: n }, (): [number, number] => [0, 0]));
      const omega = 10 ** (rand() * 8);
      const put = (i: number, j: number, g: number, c: number): void => {
        G.add(i, j, g); C.add(i, j, c);
        dense[i][j][0] += g; dense[i][j][1] += omega * c;
      };
      // A random permutation guarantees structural non-singularity.
      const p = Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5);
      for (let i = 0; i < n; i++) put(i, p[i], 1 + rand(), rand() < 0.5 ? rand() * 1e-6 : 0);
      for (let i = 0; i < n; i++) put(i, i, rand() < 0.5 ? 1e-15 : 0, rand() < 0.5 ? 1e-12 * rand() : 0);
      for (let e = 0; e < (1 + (trial % 4)) * n; e++) {
        put(Math.floor(rand() * n), Math.floor(rand() * n), rand() - 0.5, rand() < 0.3 ? rand() * 1e-6 : 0);
      }
      const gCsc = toCsc(G).csc;
      const cCsc = toCsc(C).csc;
      const solver = new ComplexSparseSolver();
      solver.analyzePattern(gCsc, cCsc);
      const bRe = Float64Array.from({ length: n }, () => rand() - 0.5);
      const bIm = Float64Array.from({ length: n }, () => rand() - 0.5);
      try {
        solver.factorize(gCsc, cCsc, omega);
      } catch (error) {
        expect(error).toBeInstanceOf(SingularMatrixError);
        continue;
      }
      const [xRe, xIm] = solver.solve(bRe, bIm);
      let xNorm = 0;
      for (let i = 0; i < n; i++) xNorm = Math.max(xNorm, Math.hypot(xRe[i], xIm[i]));
      for (let i = 0; i < n; i++) {
        let rRe = -bRe[i], rIm = -bIm[i], rowNorm = 0;
        for (let j = 0; j < n; j++) {
          const [aRe, aIm] = dense[i][j];
          rRe += aRe * xRe[j] - aIm * xIm[j];
          rIm += aRe * xIm[j] + aIm * xRe[j];
          rowNorm += Math.hypot(aRe, aIm);
        }
        expect(Math.hypot(rRe, rIm), `trial ${trial} row ${i}`).toBeLessThan(1e-9 * (rowNorm * xNorm + 1));
      }
    }
  });
});
