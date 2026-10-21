import type { CscMatrix } from './csc-matrix.js';
import { SingularMatrixError, type MatrixVariableIdentity } from '../errors.js';
import { amdOrdering } from './amd-ordering.js';
import { columnSingletonsFirst, type PivotPreorder } from './column-singletons.js';

/** Column ordering applied once per topology by {@link ComplexSparseSolver.analyzePattern}. */
export type ComplexColumnOrdering = 'amd' | 'natural';

export interface ComplexSparseSolverOptions {
  /**
   * Fill-reducing ordering of the union pattern of G and C. `'amd'` (default)
   * permutes columns and preferred pivot rows symmetrically by an approximate
   * minimum degree ordering of A + Aᵀ; `'natural'` keeps the MNA variable
   * order. Either way, structural column singletons are pivoted first.
   */
  ordering?: ComplexColumnOrdering;
}

/**
 * Complex sparse LU solver for AC analysis.
 *
 * Directly factors the n*n complex matrix (G + jwC) instead of expanding
 * to a 2n*2n real system. This halves the matrix dimension and reduces
 * non-zeros by ~4x, giving roughly 8x faster factorization.
 *
 * The algorithm mirrors GilbertPeierlsSolver: PAQ = LU by left-looking
 * column-Crout with threshold partial pivoting, where Q is a fill-reducing
 * column order (#740: AMD on the union pattern of G and C, computed once per
 * topology, structural column singletons first) and the preferred pivot of
 * each step is the symmetrically permuted diagonal. Every scalar operation is
 * replaced with its complex equivalent, and all value arrays are doubled
 * (separate real and imaginary Float64Arrays).
 *
 * Pivot acceptance follows ngspice-47 Sparse 1.3 (`spOrderAndFactor`, used by
 * `SMPcReorder` in `NIacIter`): a candidate is acceptable when its magnitude
 * |re| + |im| (`ELEMENT_MAG`) exceeds both the absolute threshold
 * (CKTpivotAbsTol = 1e-13) and the relative threshold (CKTpivotRelTol = 1e-3)
 * times the largest magnitude in its column of the reduced matrix. The
 * preferred diagonal is kept when acceptable; otherwise the column maximum is
 * taken. Row pivoting and numeric fill are not predicted by the symbolic
 * phase, so the factor buffers grow on demand, as in GilbertPeierlsSolver.
 *
 * Usage:
 *   const solver = new ComplexSparseSolver();
 *   solver.analyzePattern(gCsc, cCsc);    // once per topology
 *   solver.factorize(gCsc, cCsc, omega);  // per frequency
 *   const [xRe, xIm] = solver.solve(bRe, bIm);
 */
export class ComplexSparseSolver {
  private n = 0;
  private readonly ordering: ComplexColumnOrdering;

  // colPerm[k] = j means original column j is factorized at step k
  private colPerm!: Int32Array;
  // rowPref[k] = i means original row i is the preferred pivot at step k
  private rowPref!: Int32Array;

  // Pre-allocated L/U structure (CSC format) with split real/imag values
  private lColPtr!: Int32Array;
  private lRows!: Int32Array;
  private lValuesRe!: Float64Array;
  private lValuesIm!: Float64Array;
  private uColPtr!: Int32Array;
  private uRows!: Int32Array;
  private uValuesRe!: Float64Array;
  private uValuesIm!: Float64Array;

  // perm[k] = i means original row i is at elimination position k
  private perm!: Int32Array;

  // Pre-allocated work arrays (reused across factorize/solve calls)
  private workspaceRe!: Float64Array;
  private workspaceIm!: Float64Array;
  private workYRe!: Float64Array;
  private workYIm!: Float64Array;
  private uDiagIdx!: Int32Array;
  private pivotOrigRow!: Int32Array;
  private pinv!: Int32Array;
  private lTempOrigRows!: Int32Array;
  private nonzeroFlag!: Int32Array;
  private nonzeroList!: Int32Array;
  private activeK!: Int32Array;
  private activeMark!: Int32Array;

  private analyzed = false;
  private factorized = false;
  private swaps = 0;
  private variables: readonly MatrixVariableIdentity[] = [];

  // Pivot-reuse data of the last successful full factorization (#769), in
  // elimination positions; null pattern references mean "nothing to reuse".
  private pivotsG: CscMatrix | null = null;
  private pivotsC: CscMatrix | null = null;
  private gScatterPos: Int32Array = new Int32Array(0); // position each stored G entry scatters to
  private cScatterPos: Int32Array = new Int32Array(0); // position each stored C entry scatters to
  private natPos!: Int32Array;             // final position of step j's preferred row
  private pivotRank!: Int32Array;          // L rows of column j found before its pivot row
  private zeroPtr!: Int32Array;            // CSC pointers into zeroRows per column
  private zeroRows = new Int32Array(16);   // touched rows whose value was exactly zero
  private workspaceDirty = false;
  private numericCount = 0;
  private refactorCount = 0;

  /** ngspice-47 CKTpivotRelTol default (`cktntask.c`), Sparse RelThreshold. */
  private readonly pivotRelThreshold = 1e-3;
  /** ngspice-47 CKTpivotAbsTol default (`cktntask.c`), Sparse AbsThreshold. */
  private readonly pivotAbsThreshold = 1e-13;

  constructor(options: ComplexSparseSolverOptions = {}) {
    this.ordering = options.ordering ?? 'amd';
  }

  /**
   * Analyze the union sparsity pattern of G and C.
   * The complex matrix (G + jwC) has non-zeros wherever G or C has non-zeros.
   * The column ordering depends only on that pattern, so it is computed here
   * once per topology and reused by every factorize().
   */
  analyzePattern(
    G: CscMatrix,
    C: CscMatrix,
    variables: readonly MatrixVariableIdentity[] = [],
  ): void {
    const n = G.size;
    this.n = n;
    this.variables = variables;

    const union = unionPattern(G, C);
    const pivots = complexPivotPreorder(union, this.ordering);
    this.colPerm = pivots.colPerm;
    this.rowPref = pivots.rowPref;

    // Size the initial factors from the union's structural lower/upper parts
    // in the natural order. The ordering moves entries between L and U, and
    // fill adds more; the factor arrays grow on demand and keep their
    // enlarged capacity across frequencies.
    let lNnz = 0;
    let uNnz = 0;
    for (let j = 0; j < n; j++) {
      let hasDiagonal = false;
      for (let p = union.colPtr[j]; p < union.colPtr[j + 1]; p++) {
        const row = union.rowIdx[p];
        if (row > j) lNnz++;
        else uNnz++;
        if (row === j) hasDiagonal = true;
      }
      if (!hasDiagonal) uNnz++;
    }

    // Pre-allocate all arrays
    this.lColPtr = new Int32Array(n + 1);
    this.lRows = new Int32Array(lNnz);
    this.lValuesRe = new Float64Array(lNnz);
    this.lValuesIm = new Float64Array(lNnz);
    this.uColPtr = new Int32Array(n + 1);
    this.uRows = new Int32Array(uNnz);
    this.uValuesRe = new Float64Array(uNnz);
    this.uValuesIm = new Float64Array(uNnz);
    this.perm = new Int32Array(n);
    this.workspaceRe = new Float64Array(n);
    this.workspaceIm = new Float64Array(n);
    this.workYRe = new Float64Array(n);
    this.workYIm = new Float64Array(n);
    this.uDiagIdx = new Int32Array(n);
    this.pivotOrigRow = new Int32Array(n);
    this.pinv = new Int32Array(n);
    this.lTempOrigRows = new Int32Array(lNnz);
    this.nonzeroFlag = new Int32Array(n);
    this.nonzeroList = new Int32Array(n);
    this.activeK = new Int32Array(n);
    this.activeMark = new Int32Array(n);
    this.natPos = new Int32Array(n);
    this.pivotRank = new Int32Array(n);
    this.zeroPtr = new Int32Array(n + 1);

    this.analyzed = true;
    this.factorized = false;
    this.workspaceDirty = false;
    this.pivotsG = null;
    this.pivotsC = null;
  }

  /** Numeric factorizations performed (full or pivot reuse). Diagnostics only. */
  get numericFactorizations(): number {
    return this.numericCount;
  }

  /**
   * Numeric factorizations that reused the pivot sequence and L/U pattern of
   * the previous full factorization. Diagnostics only.
   */
  get pivotReuseFactorizations(): number {
    return this.refactorCount;
  }

  /**
   * Stored non-zeros of the last numeric factorization: strictly lower L plus
   * U including its diagonal. Diagnostics only.
   */
  factorNonzeros(): number {
    if (!this.factorized) {
      throw new Error('Must call factorize before factorNonzeros');
    }
    return this.lColPtr[this.n] + this.uColPtr[this.n];
  }

  /**
   * Row swaps in the last numeric factorization: steps whose pivot was not
   * the row currently at that elimination position (the preferred row, or
   * a row displaced there by an earlier swap), i.e. pivots forced off the
   * diagonal by the acceptance test. Diagnostics only.
   */
  rowSwaps(): number {
    if (!this.factorized) {
      throw new Error('Must call factorize before rowSwaps');
    }
    return this.swaps;
  }

  /**
   * Factor (G + jwC) using left-looking column-Crout with complex arithmetic,
   * visiting original column colPerm[j] at step j.
   *
   * A_re[i,j] = G[i,j],  A_im[i,j] = omega * C[i,j]
   */
  factorize(G: CscMatrix, C: CscMatrix, omega: number): void {
    if (!this.analyzed) {
      throw new Error('Must call analyzePattern before factorize');
    }

    // Same structure as the last full factorization (the next frequency of a
    // sweep): first try to reuse its pivot sequence and L/U pattern, as
    // ngspice NIacIter does (SMPcReorder once, then SMPcLUfac) and KLU does
    // with klu_refactor. The attempt only succeeds when this kernel would
    // have made exactly the same choices, so the result is bit-identical to
    // a full factorization.
    if (
      this.pivotsG !== null && this.pivotsC !== null
      && sameStructure(G, this.pivotsG) && sameStructure(C, this.pivotsC)
      && this.refactorWithPivots(G, C, omega)
    ) {
      this.workspaceDirty = false;
      this.factorized = true;
      this.numericCount++;
      this.refactorCount++;
      return;
    }

    const n = this.n;
    const perm = this.perm;
    const colPerm = this.colPerm;
    const wsRe = this.workspaceRe;
    const wsIm = this.workspaceIm;
    const lColPtr = this.lColPtr;
    let lRe = this.lValuesRe;
    let lIm = this.lValuesIm;
    const uColPtr = this.uColPtr;
    let uRows = this.uRows;
    let uRe = this.uValuesRe;
    let uIm = this.uValuesIm;
    const uDiagIdx = this.uDiagIdx;
    const pivotOrigRow = this.pivotOrigRow;
    const pinv = this.pinv;
    let lTempOrigRows = this.lTempOrigRows;
    const nonzeroFlag = this.nonzeroFlag;
    const nonzeroList = this.nonzeroList;
    const activeK = this.activeK;
    const activeMark = this.activeMark;
    const natPos = this.natPos;
    const pivotRank = this.pivotRank;
    const zeroPtr = this.zeroPtr;
    let zeroRows = this.zeroRows;

    // Initialize the row permutation to the preferred pivot rows: the forced
    // row of each leading column singleton, then the symmetrically permuted
    // diagonal.
    this.factorized = false;
    this.pivotsG = null;
    this.pivotsC = null;
    if (this.workspaceDirty) {
      wsRe.fill(0);
      wsIm.fill(0);
      this.workspaceDirty = false;
    }
    perm.set(this.rowPref);
    pivotOrigRow.fill(-1);
    pinv.fill(-1);
    nonzeroFlag.fill(-1);
    activeMark.fill(-1);
    let swaps = 0;

    let lp = 0;
    let up = 0;
    let zp = 0;

    for (let j = 0; j < n; j++) {
      let nonzeroCount = 0;

      lColPtr[j] = lp;
      uColPtr[j] = up;

      // === Step 1: SCATTER column colPerm[j] of (G + jwC) into workspace ===
      const col = colPerm[j];
      // Real part from G
      for (let p = G.colPtr[col]; p < G.colPtr[col + 1]; p++) {
        const origRow = G.rowIdx[p];
        wsRe[origRow] = G.values[p];
        if (nonzeroFlag[origRow] !== j) {
          nonzeroFlag[origRow] = j;
          nonzeroList[nonzeroCount++] = origRow;
        }
      }
      // Imaginary part from omega * C
      for (let p = C.colPtr[col]; p < C.colPtr[col + 1]; p++) {
        const origRow = C.rowIdx[p];
        wsIm[origRow] = omega * C.values[p];
        if (nonzeroFlag[origRow] !== j) {
          nonzeroFlag[origRow] = j;
          nonzeroList[nonzeroCount++] = origRow;
        }
      }

      // === Step 2: LEFT-LOOKING sparse triangular solve ===
      let activeCount = 0;
      for (let t = 0; t < nonzeroCount; t++) {
        const origRow = nonzeroList[t];
        const k = pinv[origRow];
        if (k >= 0 && k < j && (wsRe[origRow] !== 0 || wsIm[origRow] !== 0)) {
          activeK[activeCount++] = k;
          activeMark[k] = j;
        }
      }
      sortInt32Prefix(activeK, activeCount);

      let ki = 0;
      while (ki < activeCount) {
        const k = activeK[ki];
        ki++;

        const pr = pivotOrigRow[k];
        const ukjRe = wsRe[pr];
        const ukjIm = wsIm[pr];
        if (ukjRe === 0 && ukjIm === 0) continue;

        // Store U[k,j] (complex)
        if (up === uRe.length) {
          this.growUFactors(up + 1);
          uRows = this.uRows;
          uRe = this.uValuesRe;
          uIm = this.uValuesIm;
        }
        uRows[up] = k;
        uRe[up] = ukjRe;
        uIm[up] = ukjIm;
        up++;

        // Apply L column k: subtract L[i,k] * U[k,j] from workspace
        // (a+bi)(c+di) = (ac-bd) + (ad+bc)i
        for (let p = lColPtr[k]; p < lColPtr[k + 1]; p++) {
          const origI = lTempOrigRows[p];
          const likRe = lRe[p];
          const likIm = lIm[p];
          // product = L[i,k] * U[k,j]
          const prodRe = likRe * ukjRe - likIm * ukjIm;
          const prodIm = likRe * ukjIm + likIm * ukjRe;
          wsRe[origI] -= prodRe;
          wsIm[origI] -= prodIm;

          if (nonzeroFlag[origI] !== j) {
            nonzeroFlag[origI] = j;
            nonzeroList[nonzeroCount++] = origI;
          }

          // An explicitly stamped (structural) zero is already in nonzeroList
          // but only becomes active after this update. Track activation
          // separately from structure, as GilbertPeierlsSolver does.
          const k2 = pinv[origI];
          if (
            k2 > k && k2 < j && activeMark[k2] !== j
            && (wsRe[origI] !== 0 || wsIm[origI] !== 0)
          ) {
            activeMark[k2] = j;
            activeK[activeCount] = k2;
            activeCount++;
            for (let q = activeCount - 1; q > ki; q--) {
              if (activeK[q] < activeK[q - 1]) {
                const tmp = activeK[q];
                activeK[q] = activeK[q - 1];
                activeK[q - 1] = tmp;
              } else {
                break;
              }
            }
          }
        }
      }

      // === Step 3: THRESHOLD PIVOTING (ngspice ELEMENT_MAG = |re| + |im|) ===
      let maxMag = 0;
      let maxOrigRow = -1;
      for (let t = 0; t < nonzeroCount; t++) {
        const origRow = nonzeroList[t];
        if (pinv[origRow] < 0) {
          const mag = Math.abs(wsRe[origRow]) + Math.abs(wsIm[origRow]);
          if (mag > maxMag) {
            maxMag = mag;
            maxOrigRow = origRow;
          }
        }
      }

      if (maxMag < 1e-18) {
        // Leave the workspace clean for a later factorize() on this solver.
        for (let t = 0; t < nonzeroCount; t++) {
          wsRe[nonzeroList[t]] = 0;
          wsIm[nonzeroList[t]] = 0;
        }
        throw SingularMatrixError.atPivot(col, this.variables);
      }

      // Keep the preferred diagonal only when it passes ngspice's acceptance
      // test (Sparse `spOrderAndFactor`: Mag > AbsThreshold && Mag >
      // RelThreshold * LargestInCol). A diagonal that survives only as
      // cancellation residue (#732: ~3e-12 against O(1) column entries) must
      // not be used: it amplifies rounding error by 1/|pivot| and makes
      // results depend on card order. When no candidate passes, Sparse falls
      // back to the largest element (spSMALL_PIVOT), which is maxOrigRow here.
      const natOrigRow = perm[j];
      natPos[j] = natOrigRow;
      let chosenOrigRow = maxOrigRow;
      if (pinv[natOrigRow] < 0) {
        const natMag = Math.abs(wsRe[natOrigRow]) + Math.abs(wsIm[natOrigRow]);
        if (natMag > this.pivotAbsThreshold && natMag > this.pivotRelThreshold * maxMag) {
          chosenOrigRow = natOrigRow;
        }
      }

      const pivRe = wsRe[chosenOrigRow];
      const pivIm = wsIm[chosenOrigRow];
      // Smith division avoids squaring the pivot (overflow/underflow and
      // unnecessary rounding for nearly real small-signal admittances).
      const realDominant = Math.abs(pivRe) >= Math.abs(pivIm);
      const ratio = realDominant ? pivIm / pivRe : pivRe / pivIm;
      const denominator = realDominant ? pivRe + pivIm * ratio : pivIm + pivRe * ratio;

      // Record pivot assignment
      pivotOrigRow[j] = chosenOrigRow;
      pinv[chosenOrigRow] = j;

      // Update perm
      if (chosenOrigRow !== perm[j]) {
        swaps++;
        for (let i = j + 1; i < n; i++) {
          if (perm[i] === chosenOrigRow) {
            perm[i] = perm[j];
            perm[j] = chosenOrigRow;
            break;
          }
        }
      }

      // Store U diagonal for column j
      if (up === uRe.length) {
        this.growUFactors(up + 1);
        uRows = this.uRows;
        uRe = this.uValuesRe;
        uIm = this.uValuesIm;
      }
      uDiagIdx[j] = up;
      uRows[up] = j;
      uRe[up] = pivRe;
      uIm[up] = pivIm;
      up++;

      // === Step 4: STORE L column j ===
      // L[i,j] = workspace[origRow] / pivot using Smith's ratio form.
      // Touched rows whose final value is exactly zero (unpivoted rows that
      // stay out of L, pivoted rows whose column was never applied) are
      // recorded for the pivot-reuse check in refactorWithPivots(), and so is
      // how many L rows precede the pivot row in discovery order (the order
      // that resolves magnitude ties in the column-maximum search).
      zeroPtr[j] = zp;
      for (let t = 0; t < nonzeroCount; t++) {
        const origRow = nonzeroList[t];
        if (origRow === chosenOrigRow) {
          pivotRank[j] = lp - lColPtr[j];
          continue;
        }
        if (wsRe[origRow] === 0 && wsIm[origRow] === 0) {
          if (zp === zeroRows.length) {
            this.growZeroRows(zp + 1);
            zeroRows = this.zeroRows;
          }
          zeroRows[zp++] = origRow;
        } else if (pinv[origRow] < 0) {
          const aRe = wsRe[origRow];
          const aIm = wsIm[origRow];
          if (lp === lRe.length) {
            this.growLFactors(lp + 1);
            lRe = this.lValuesRe;
            lIm = this.lValuesIm;
            lTempOrigRows = this.lTempOrigRows;
          }
          lTempOrigRows[lp] = origRow;
          lRe[lp] = (realDominant ? aRe + aIm * ratio : aRe * ratio + aIm) / denominator;
          lIm[lp] = (realDominant ? aIm - aRe * ratio : aIm * ratio - aRe) / denominator;
          lp++;
        }
      }

      // === Step 5: CLEAR workspace (only touched positions) ===
      for (let t = 0; t < nonzeroCount; t++) {
        const idx = nonzeroList[t];
        wsRe[idx] = 0;
        wsIm[idx] = 0;
      }

    }

    lColPtr[n] = lp;
    uColPtr[n] = up;

    // === Step 6: Convert L row indices from original rows to elimination positions ===
    for (let k = 0; k < n; k++) {
      pinv[perm[k]] = k;
    }
    if (this.lRows.length < lp) this.lRows = new Int32Array(lTempOrigRows.length);
    const lRows = this.lRows;
    for (let p = 0; p < lp; p++) {
      lRows[p] = pinv[lTempOrigRows[p]];
    }

    // Pivot-reuse data, in elimination positions: zero rows, the preferred
    // row of every step, and the position each stored entry of G and C
    // scatters to.
    zeroPtr[n] = zp;
    for (let p = 0; p < zp; p++) zeroRows[p] = pinv[zeroRows[p]];
    for (let k = 0; k < n; k++) natPos[k] = pinv[natPos[k]];
    this.gScatterPos = scatterPositions(G, pinv, this.gScatterPos);
    this.cScatterPos = scatterPositions(C, pinv, this.cScatterPos);
    this.pivotsG = G;
    this.pivotsC = C;

    this.swaps = swaps;
    this.factorized = true;
    this.numericCount++;
  }

  /**
   * Refactorize G + jwC on the pivot sequence and L/U pattern of the last
   * full factorization, in place: ngspice's SMPcLUfac / klu_refactor reuse of
   * the previous ordering between AC frequency points. Unlike ngspice, which
   * keeps a reused pivot until it is singular, this succeeds only when the
   * full kernel would make exactly the same decisions on these values:
   *
   *  - every reused U entry is nonzero (the kernel skips a zero U[k,j], which
   *    would change which L columns are applied);
   *  - every touched row recorded as zero is still exactly zero, and every L
   *    row is nonzero (same L/U patterns, hence the same touched rows for
   *    later columns);
   *  - the ngspice-47 acceptance test selects the same row: the preferred row
   *    still passes it, or the off-preference pivot is still the first
   *    column maximum in discovery order and the preferred row still fails.
   *
   * Under those conditions every workspace entry sees the same operations in
   * the same order as in factorize(), so the factors are bit-identical (the
   * same argument as GilbertPeierlsSolver.refactorWithPivots, #486). On any
   * mismatch it returns false with the workspace dirty and partially
   * overwritten factors; the caller then runs the full factorization.
   */
  private refactorWithPivots(G: CscMatrix, C: CscMatrix, omega: number): boolean {
    const n = this.n;
    const colPerm = this.colPerm;
    const xRe = this.workspaceRe;
    const xIm = this.workspaceIm;
    const lColPtr = this.lColPtr;
    const lRows = this.lRows;
    const lRe = this.lValuesRe;
    const lIm = this.lValuesIm;
    const uColPtr = this.uColPtr;
    const uRows = this.uRows;
    const uRe = this.uValuesRe;
    const uIm = this.uValuesIm;
    const natPos = this.natPos;
    const pivotRank = this.pivotRank;
    const zeroPtr = this.zeroPtr;
    const zeroRows = this.zeroRows;
    const gScatterPos = this.gScatterPos;
    const cScatterPos = this.cScatterPos;
    const gColPtr = G.colPtr;
    const gValues = G.values;
    const cColPtr = C.colPtr;
    const cValues = C.values;
    const absThreshold = this.pivotAbsThreshold;
    const relThreshold = this.pivotRelThreshold;

    this.factorized = false;
    if (this.workspaceDirty) {
      xRe.fill(0);
      xIm.fill(0);
    }
    this.workspaceDirty = true;

    for (let j = 0; j < n; j++) {
      // Scatter column colPerm[j] of G + jwC in elimination-position space.
      const col = colPerm[j];
      for (let p = gColPtr[col]; p < gColPtr[col + 1]; p++) {
        xRe[gScatterPos[p]] = gValues[p];
      }
      for (let p = cColPtr[col]; p < cColPtr[col + 1]; p++) {
        xIm[cScatterPos[p]] = omega * cValues[p];
      }

      // Apply the stored U pattern in ascending k (the U diagonal is last).
      const uDiag = uColPtr[j + 1] - 1;
      for (let q = uColPtr[j]; q < uDiag; q++) {
        const k = uRows[q];
        const ukjRe = xRe[k];
        const ukjIm = xIm[k];
        if (ukjRe === 0 && ukjIm === 0) return false;
        xRe[k] = 0;
        xIm[k] = 0;
        uRe[q] = ukjRe;
        uIm[q] = ukjIm;
        const pEnd = lColPtr[k + 1];
        for (let p = lColPtr[k]; p < pEnd; p++) {
          const i = lRows[p];
          const likRe = lRe[p];
          const likIm = lIm[p];
          xRe[i] -= likRe * ukjRe - likIm * ukjIm;
          xIm[i] -= likRe * ukjIm + likIm * ukjRe;
        }
      }

      for (let z = zeroPtr[j]; z < zeroPtr[j + 1]; z++) {
        if (xRe[zeroRows[z]] !== 0 || xIm[zeroRows[z]] !== 0) return false;
      }

      // Pivot acceptance over the candidates (pivot row and L rows). L values
      // are written speculatively; a failed test discards them.
      const pivRe = xRe[j];
      const pivIm = xIm[j];
      xRe[j] = 0;
      xIm[j] = 0;
      // Smith division avoids squaring the pivot (overflow/underflow and
      // unnecessary rounding for nearly real small-signal admittances).
      const realDominant = Math.abs(pivRe) >= Math.abs(pivIm);
      const ratio = realDominant ? pivIm / pivRe : pivRe / pivIm;
      const denominator = realDominant ? pivRe + pivIm * ratio : pivIm + pivRe * ratio;
      const nat = natPos[j];
      const lStart = lColPtr[j];
      const rankEnd = lStart + pivotRank[j];
      let natMag = 0;
      let maxBefore = 0; // largest L candidate found before the pivot row
      let maxL = 0;
      for (let p = lStart; p < lColPtr[j + 1]; p++) {
        const row = lRows[p];
        const aRe = xRe[row];
        const aIm = xIm[row];
        if (aRe === 0 && aIm === 0) return false;
        xRe[row] = 0;
        xIm[row] = 0;
        lRe[p] = (realDominant ? aRe + aIm * ratio : aRe * ratio + aIm) / denominator;
        lIm[p] = (realDominant ? aIm - aRe * ratio : aIm * ratio - aRe) / denominator;
        const mag = Math.abs(aRe) + Math.abs(aIm);
        if (mag > maxL) maxL = mag;
        if (p < rankEnd && mag > maxBefore) maxBefore = mag;
        if (row === nat) natMag = mag;
      }
      const pivMag = Math.abs(pivRe) + Math.abs(pivIm);
      if (nat === j) {
        // The preferred row was accepted: it must still pass.
        const maxMag = pivMag > maxL ? pivMag : maxL;
        if (!(maxMag >= 1e-18) || !(pivMag > absThreshold && pivMag > relThreshold * maxMag)) return false;
      } else {
        // The column maximum was taken: it must still be the first maximum
        // in discovery order (L rows keep that order, and the pivot row came
        // after pivotRank[j] of them), and the preferred row, an L row or
        // untouched (zero), must still fail the test.
        if (!(pivMag >= maxL) || !(pivMag > maxBefore) || !(pivMag >= 1e-18)) return false;
        if (natMag > absThreshold && natMag > relThreshold * pivMag) return false;
      }
      uRe[uDiag] = pivRe;
      uIm[uDiag] = pivIm;

      for (let z = zeroPtr[j]; z < zeroPtr[j + 1]; z++) {
        xRe[zeroRows[z]] = 0;
        xIm[zeroRows[z]] = 0;
      }
    }
    return true;
  }

  private growZeroRows(required: number): void {
    const capacity = Math.max(required, this.zeroRows.length * 2);
    const rows = new Int32Array(capacity);
    rows.set(this.zeroRows);
    this.zeroRows = rows;
  }

  /**
   * Solve (G + jwC)x = b using forward/backward substitution with complex arithmetic.
   * Returns [xReal, xImag] in the original variable order.
   */
  solve(bReal: Float64Array, bImag: Float64Array): [Float64Array, Float64Array] {
    if (!this.factorized) {
      throw new Error('Must call factorize before solve');
    }

    const n = this.n;
    const perm = this.perm;
    const colPerm = this.colPerm;
    const lColPtr = this.lColPtr;
    const lRows = this.lRows;
    const lRe = this.lValuesRe;
    const lIm = this.lValuesIm;
    const uColPtr = this.uColPtr;
    const uRows = this.uRows;
    const uRe = this.uValuesRe;
    const uIm = this.uValuesIm;
    const uDiagIdx = this.uDiagIdx;
    const yRe = this.workYRe;
    const yIm = this.workYIm;

    // Apply permutation: y = Pb
    for (let k = 0; k < n; k++) {
      yRe[k] = bReal[perm[k]];
      yIm[k] = bImag[perm[k]];
    }

    // Forward substitution: Ly = Pb (L is unit lower triangular)
    // y[i] -= L[i,j] * y[j]  (complex multiply)
    for (let j = 0; j < n; j++) {
      const yjRe = yRe[j];
      const yjIm = yIm[j];
      for (let p = lColPtr[j]; p < lColPtr[j + 1]; p++) {
        const i = lRows[p];
        const lijRe = lRe[p];
        const lijIm = lIm[p];
        yRe[i] -= lijRe * yjRe - lijIm * yjIm;
        yIm[i] -= lijRe * yjIm + lijIm * yjRe;
      }
    }

    // Backward substitution: Uz = y, then x = Qz (z[j] is variable colPerm[j]).
    // z[j] = y[j] / U[j,j]  (complex division)
    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    for (let j = n - 1; j >= 0; j--) {
      // Complex divide: y[j] / U[j,j]
      const dRe = uRe[uDiagIdx[j]];
      const dIm = uIm[uDiagIdx[j]];
      const realDominant = Math.abs(dRe) >= Math.abs(dIm);
      const ratio = realDominant ? dIm / dRe : dRe / dIm;
      const denominator = realDominant ? dRe + dIm * ratio : dIm + dRe * ratio;
      const zRe = (realDominant ? yRe[j] + yIm[j] * ratio : yRe[j] * ratio + yIm[j]) / denominator;
      const zIm = (realDominant ? yIm[j] - yRe[j] * ratio : yIm[j] * ratio - yRe[j]) / denominator;
      xRe[colPerm[j]] = zRe;
      xIm[colPerm[j]] = zIm;

      // Update y: y[i] -= U[i,j] * z[j]
      for (let p = uColPtr[j]; p < uColPtr[j + 1]; p++) {
        const i = uRows[p];
        if (i < j) {
          const uijRe = uRe[p];
          const uijIm = uIm[p];
          yRe[i] -= uijRe * zRe - uijIm * zIm;
          yIm[i] -= uijRe * zIm + uijIm * zRe;
        }
      }
    }

    return [xRe, xIm];
  }

  private growLFactors(required: number): void {
    const capacity = Math.max(required, Math.max(4, this.lValuesRe.length * 2));
    const re = new Float64Array(capacity);
    const im = new Float64Array(capacity);
    const rows = new Int32Array(capacity);
    re.set(this.lValuesRe);
    im.set(this.lValuesIm);
    rows.set(this.lTempOrigRows);
    this.lValuesRe = re;
    this.lValuesIm = im;
    this.lTempOrigRows = rows;
  }

  private growUFactors(required: number): void {
    const capacity = Math.max(required, Math.max(4, this.uValuesRe.length * 2));
    const re = new Float64Array(capacity);
    const im = new Float64Array(capacity);
    const rows = new Int32Array(capacity);
    re.set(this.uValuesRe);
    im.set(this.uValuesIm);
    rows.set(this.uRows);
    this.uValuesRe = re;
    this.uValuesIm = im;
    this.uRows = rows;
  }
}

/**
 * Column order and preferred pivot rows for the union pattern of G and C:
 * AMD (or the natural MNA order), then structural column singletons first.
 */
export function complexPivotPreorder(
  union: CscMatrix,
  ordering: ComplexColumnOrdering = 'amd',
): PivotPreorder {
  let order: Int32Array;
  if (ordering === 'amd') {
    order = amdOrdering(union);
  } else {
    order = new Int32Array(union.size);
    for (let j = 0; j < union.size; j++) order[j] = j;
  }
  return columnSingletonsFirst(union, order);
}

/**
 * True when two CSC matrices have the same size and the same stored
 * structure (column pointers and row indices). Shared arrays short-circuit;
 * a rebuilt CSC (AC with frequency-dependent devices) is compared entry by
 * entry, which costs O(nnz), far less than a factorization.
 */
function sameStructure(a: CscMatrix, b: CscMatrix): boolean {
  if (a.size !== b.size) return false;
  if (a.colPtr !== b.colPtr) {
    if (a.colPtr.length !== b.colPtr.length) return false;
    for (let j = 0; j <= a.size; j++) if (a.colPtr[j] !== b.colPtr[j]) return false;
  }
  if (a.rowIdx !== b.rowIdx) {
    const nnz = a.colPtr[a.size];
    for (let p = 0; p < nnz; p++) if (a.rowIdx[p] !== b.rowIdx[p]) return false;
  }
  return true;
}

/** Elimination position of every stored entry's row, into a reused buffer. */
function scatterPositions(m: CscMatrix, pinv: Int32Array, buffer: Int32Array): Int32Array {
  const nnz = m.colPtr[m.size];
  const out = buffer.length < nnz ? new Int32Array(nnz) : buffer;
  for (let p = 0; p < nnz; p++) out[p] = pinv[m.rowIdx[p]];
  return out;
}

/**
 * Sort the first `count` elements of an Int32Array in ascending order (insertion sort).
 */
function sortInt32Prefix(arr: Int32Array, count: number): void {
  for (let i = 1; i < count; i++) {
    const val = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > val) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = val;
  }
}

/**
 * Union sparsity pattern of two CSC matrices of the same size, rows ascending
 * per column. Values are 1 (pattern only); stored explicit zeros of G or C
 * count as structure.
 */
export function unionPattern(G: CscMatrix, C: CscMatrix): CscMatrix {
  const n = G.size;
  const colPtr = new Int32Array(n + 1);
  const rowIdx = new Int32Array(G.colPtr[n] + C.colPtr[n]);
  let nnz = 0;
  for (let j = 0; j < n; j++) {
    let p = G.colPtr[j];
    let q = C.colPtr[j];
    const pEnd = G.colPtr[j + 1];
    const qEnd = C.colPtr[j + 1];
    // Both inputs come from toCsc(), so rows are ascending: merge.
    while (p < pEnd || q < qEnd) {
      const gi = p < pEnd ? G.rowIdx[p] : n;
      const ci = q < qEnd ? C.rowIdx[q] : n;
      if (gi <= ci) {
        rowIdx[nnz++] = gi;
        p++;
        if (gi === ci) q++;
      } else {
        rowIdx[nnz++] = ci;
        q++;
      }
    }
    colPtr[j + 1] = nnz;
  }
  return { size: n, colPtr, rowIdx: rowIdx.slice(0, nnz), values: new Float64Array(nnz).fill(1) };
}
