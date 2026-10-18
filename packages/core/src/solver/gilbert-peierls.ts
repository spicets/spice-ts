import type { CscMatrix } from './csc-matrix.js';
import type { SparseSolver } from './sparse-solver.js';
import { SingularMatrixError, type MatrixVariableIdentity } from '../errors.js';
import { amdOrdering } from './amd-ordering.js';

/** Column ordering applied once per topology by {@link GilbertPeierlsSolver.analyzePattern}. */
export type ColumnOrdering = 'amd' | 'natural';

export interface GilbertPeierlsOptions {
  /**
   * Fill-reducing ordering. `'amd'` (default) permutes columns and preferred
   * pivot rows symmetrically by an approximate minimum degree ordering of
   * A + Aᵀ; `'natural'` keeps the MNA variable order. Either way, structural
   * column singletons are pivoted first (see `columnSingletonsFirst`).
   */
  ordering?: ColumnOrdering;
}

/**
 * Gilbert-Peierls sparse LU solver.
 *
 * Implements PAQ = LU factorization with a fill-reducing column ordering Q
 * (approximate minimum degree on A + Aᵀ, computed once per topology) and
 * threshold partial pivoting that prefers the symmetrically permuted diagonal.
 * The algorithm separates symbolic analysis (sparsity structure prediction)
 * from numeric factorization, allowing the symbolic phase to run once per
 * circuit topology while numeric factorization runs every Newton-Raphson step.
 *
 * The factorization uses a left-looking column-Crout algorithm with a dense
 * workspace vector of length n (instead of an n*n dense matrix). Runs of
 * consecutive L columns with nested patterns (supernodes, the separators of
 * mesh-like circuits) are packed into row-major blocks as they are produced
 * and applied to later columns a block at a time, with the same operations
 * in the same order as column by column. The symbolic
 * phase sizes the initial factor buffers from the CSC structure. Numeric fill
 * and row pivoting can exceed that estimate, so those arrays grow on demand and
 * retain their enlarged capacity for pattern reuse.
 *
 * Storage:
 *   L is unit lower triangular (implicit 1s on diagonal), stored in CSC.
 *   U is upper triangular (including diagonal), stored in CSC.
 *   P is a row permutation vector from threshold partial pivoting.
 *   Q is the column ordering: step k factorizes original column colPerm[k].
 */
export class GilbertPeierlsSolver implements SparseSolver {
  private n = 0;
  private readonly ordering: ColumnOrdering;

  // colPerm[k] = j means original column j is factorized at step k
  private colPerm!: Int32Array;
  // rowPref[k] = i means original row i is the preferred pivot at step k
  private rowPref!: Int32Array;

  // Pre-allocated L/U structure (CSC format)
  private lColPtr!: Int32Array;
  private lRows!: Int32Array;
  private lValues!: Float64Array;
  private uColPtr!: Int32Array;
  private uRows!: Int32Array;
  private uValues!: Float64Array;

  // perm[k] = i means original row i is at elimination position k
  private perm!: Int32Array;

  // Pre-allocated work arrays (reused across factorize/solve calls)
  private workspace!: Float64Array;     // factor column / solve y, used in non-overlapping phases
  private pinv!: Int32Array;            // pinv[origRow] = column that used origRow as pivot
  private nonzeroFlag!: Int32Array;     // marker for workspace non-zero tracking
  private nonzeroList!: Int32Array;     // list of non-zero workspace positions
  private activeK!: Int32Array;         // active column indices during triangular solve
  private workspaceDirty = false;

  private analyzed = false;
  private factorized = false;
  private variables: readonly MatrixVariableIdentity[] = [];

  // Inputs of the current factors, for skipping an identical refactorization.
  private factoredValues: Float64Array | null = null;
  private factoredColPtr: Int32Array | null = null;
  private factoredRowIdx: Int32Array | null = null;
  private numericCount = 0;
  private refactorCount = 0;

  // Pivot reuse (see refactorWithPivots). Valid only for the structure arrays
  // the last full factorization ran on; cleared by analyzePattern.
  private pivotsColPtr: Int32Array | null = null;
  private pivotsRowIdx: Int32Array | null = null;
  private scatterPos = new Int32Array(0); // elimination position of each A entry's row
  private natPos!: Int32Array;            // final position of step j's preferred row
  private pivotPrefix!: Int32Array;       // L entries visited before the chosen pivot
  private zeroPtr!: Int32Array;           // CSC pointers into zeroRows per column
  private zeroRows = new Int32Array(16);  // touched positions whose value was exactly zero

  // Supernodes of L built during a full factorization (see startSupernode).
  // Indexed by the first column s0 of a supernode; valid for one factorize().
  private snStart!: Int32Array;           // first column of the supernode holding column k
  private snEnd!: Int32Array;             // last packed column of a supernode, or -1
  private snRowPtr!: Int32Array;          // offset of its rows (those of L[:,s0]) in snRows
  private snLen!: Int32Array;             // number of those rows
  private snWidth!: Int32Array;           // value slots per block row (>= members)
  private snValPtr!: Int32Array;          // offset of its row-major value block in snValues
  private snMark!: Int32Array;            // row stamps for the supernode link test
  private snPos!: Int32Array;             // row -> block row, while a block is built
  private snApplied!: Int32Array;         // members applied to the current column
  private snAppliedU!: Float64Array;      // their U values
  private snRows = new Int32Array(16);
  private snValues = new Float64Array(16);
  private snRowsUsed = 0;
  private snValuesUsed = 0;
  private supernodeCount = 0;
  // [up, nonzeroCount, activeCount] handed between factorize and applySupernode
  private readonly kernelState = new Int32Array(3);

  private readonly pivotThreshold = 0.1;

  constructor(options: GilbertPeierlsOptions = {}) {
    this.ordering = options.ordering ?? 'amd';
  }

  analyzePattern(A: CscMatrix, variables: readonly MatrixVariableIdentity[] = []): void {
    const n = A.size;
    this.n = n;
    this.variables = variables;

    // The fill-reducing ordering depends only on the sparsity pattern, so it
    // is computed here once per topology and reused by every factorize().
    let order: Int32Array;
    if (this.ordering === 'amd') {
      order = amdOrdering(A);
    } else {
      order = new Int32Array(n);
      for (let j = 0; j < n; j++) order[j] = j;
    }
    const pivots = columnSingletonsFirst(A, order);
    this.colPerm = pivots.colPerm;
    this.rowPref = pivots.rowPref;

    // Size the initial factors from A's structural lower/upper parts in the
    // natural order. The column ordering moves entries between L and U, and
    // numeric fill adds more; the factor arrays grow on demand.
    // The previous fill predictor materialized one Set and multiple boxed arrays
    // per column, although numeric pivoting could still invalidate its estimate.
    // Dynamic growth already preserves correctness for fill beyond this bound.
    let lNnz = 0;
    let uNnz = 0;
    for (let j = 0; j < n; j++) {
      let hasDiagonal = false;
      for (let p = A.colPtr[j]; p < A.colPtr[j + 1]; p++) {
        const row = A.rowIdx[p];
        if (row > j) lNnz++;
        else uNnz++;
        if (row === j) hasDiagonal = true;
      }
      if (!hasDiagonal) uNnz++;
    }

    // Pre-allocate all arrays. These are reused across factorize calls.
    this.lColPtr = new Int32Array(n + 1);
    this.lRows = new Int32Array(lNnz);
    this.lValues = new Float64Array(lNnz);
    this.uColPtr = new Int32Array(n + 1);
    this.uRows = new Int32Array(uNnz);
    this.uValues = new Float64Array(uNnz);
    this.perm = new Int32Array(n);
    this.workspace = new Float64Array(n);
    this.pinv = new Int32Array(n);
    this.nonzeroFlag = new Int32Array(n);
    this.nonzeroList = new Int32Array(n);
    this.activeK = new Int32Array(n);
    this.natPos = new Int32Array(n);
    this.pivotPrefix = new Int32Array(n);
    this.zeroPtr = new Int32Array(n + 1);
    this.snStart = new Int32Array(n);
    this.snEnd = new Int32Array(n);
    this.snRowPtr = new Int32Array(n);
    this.snLen = new Int32Array(n);
    this.snWidth = new Int32Array(n);
    this.snValPtr = new Int32Array(n);
    this.snMark = new Int32Array(n);
    this.snPos = new Int32Array(n);
    this.snApplied = new Int32Array(n);
    this.snAppliedU = new Float64Array(n);
    this.workspaceDirty = false;

    this.analyzed = true;
    this.factorized = false;
    this.factoredColPtr = null;
    this.factoredRowIdx = null;
    this.pivotsColPtr = null;
    this.pivotsRowIdx = null;
  }

  /** Numeric factorizations performed, excluding skipped identical ones. Diagnostics only. */
  get numericFactorizations(): number {
    return this.numericCount;
  }

  /** Numeric factorizations that reused the previous pivot sequence. Diagnostics only. */
  get pivotReuseFactorizations(): number {
    return this.refactorCount;
  }

  /**
   * Supernodal column updates in the last full factorization: times a run of
   * two or more consecutive L columns with nested patterns was applied to a
   * later column as one block. Diagnostics only.
   */
  get supernodalUpdates(): number {
    return this.supernodeCount;
  }

  /**
   * True when A is bit-identical (signed zeros included) to the matrix the
   * current factors were computed from, on the same structure arrays.
   */
  private matchesFactoredInput(A: CscMatrix): boolean {
    const prev = this.factoredValues;
    if (!this.factorized || prev === null) return false;
    if (A.colPtr !== this.factoredColPtr || A.rowIdx !== this.factoredRowIdx) return false;
    const values = A.values;
    const nnz = A.colPtr[this.n];
    for (let p = 0; p < nnz; p++) {
      const v = values[p];
      if (v !== prev[p] || (v === 0 && 1 / v !== 1 / prev[p])) return false;
    }
    return true;
  }

  private recordFactoredInput(A: CscMatrix): void {
    const nnz = A.colPtr[this.n];
    let prev = this.factoredValues;
    if (prev === null || prev.length < nnz) prev = this.factoredValues = new Float64Array(nnz);
    prev.set(A.values.subarray(0, nnz));
    this.factoredColPtr = A.colPtr;
    this.factoredRowIdx = A.rowIdx;
  }

  isPatternAnalyzed(): boolean {
    return this.analyzed;
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
   * Left-looking column-Crout factorization with threshold partial pivoting.
   *
   * The workspace vector is indexed by ORIGINAL row numbers throughout.
   * During factorization, L entries are stored with original row indices in
   * the final row array, then converted in place to elimination-order indices
   * after the full factorization when the final permutation is known.
   *
   * This avoids a permutation-inconsistency where later pivots would
   * change the meaning of elimination positions stored by earlier columns.
   */
  factorize(A: CscMatrix): void {
    if (!this.analyzed) {
      throw new Error('Must call analyzePattern before factorize');
    }

    // The factorization is a deterministic function of A, so bit-identical
    // input (a linear circuit at a repeated timestep, or the final Newton
    // iterations of a converged OP) yields bit-identical factors. Keep them.
    if (this.matchesFactoredInput(A)) return;

    // Values changed on the same structure: first try to reuse the previous
    // pivot sequence and factor pattern (ngspice: spFactor / klu_refactor
    // after the first spOrderAndFactor / klu_factor). The attempt only
    // succeeds when this kernel would have made exactly the same choices, so
    // the result is bit-identical to a full factorization.
    if (
      A.colPtr === this.pivotsColPtr &&
      A.rowIdx === this.pivotsRowIdx &&
      this.refactorWithPivots(A)
    ) {
      this.workspaceDirty = false;
      this.factorized = true;
      this.numericCount++;
      this.refactorCount++;
      this.recordFactoredInput(A);
      return;
    }

    const n = this.n;
    const perm = this.perm;
    const colPerm = this.colPerm;
    const workspace = this.workspace;
    const lColPtr = this.lColPtr;
    let lRows = this.lRows;
    let lValues = this.lValues;
    const uColPtr = this.uColPtr;
    let uRows = this.uRows;
    let uValues = this.uValues;
    const pinv = this.pinv;
    const nonzeroFlag = this.nonzeroFlag;
    const nonzeroList = this.nonzeroList;
    const activeK = this.activeK;
    const natPos = this.natPos;
    const zeroPtr = this.zeroPtr;
    let zeroRows = this.zeroRows;

    // Freshly allocated and successfully factorized workspaces are already
    // zero. Only solve() or a failed numeric pass can leave values behind.
    this.factorized = false;
    this.pivotsColPtr = null;
    this.pivotsRowIdx = null;
    if (this.workspaceDirty) workspace.fill(0);
    this.workspaceDirty = true;

    // Initialize the row permutation to the preferred pivot rows: the forced
    // row of each leading column singleton, then the symmetrically permuted
    // diagonal where it is still available.
    perm.set(this.rowPref);
    pinv.fill(-1);
    nonzeroFlag.fill(-1);
    const snStart = this.snStart;
    const snEnd = this.snEnd;
    const snMark = this.snMark;
    const kernelState = this.kernelState;
    snEnd.fill(-1);
    snMark.fill(-1);
    this.snRowsUsed = 0;
    this.snValuesUsed = 0;
    this.supernodeCount = 0;

    let lp = 0;
    let up = 0;
    let zp = 0;

    for (let j = 0; j < n; j++) {
      let nonzeroCount = 0;

      lColPtr[j] = lp;
      uColPtr[j] = up;

      // Per-row state for this column, stamped so no per-column reset is needed:
      //   settled  — touched, and either not yet pivoted (an L/pivot candidate)
      //              or a pivoted row already queued as an active column;
      //   dormant  — touched pivoted row whose value is currently exactly zero,
      //              so its column is not (yet) active;
      //   anything else — not touched in this column.
      // Only the rare non-settled rows take the slow path in the update loop.
      const settled = 2 * j + 1;
      const dormant = 2 * j;

      // === Step 1: SCATTER column colPerm[j] of A into workspace (original row space) ===
      const col = colPerm[j];
      for (let p = A.colPtr[col]; p < A.colPtr[col + 1]; p++) {
        const origRow = A.rowIdx[p];
        workspace[origRow] = A.values[p];
        // Stamps only grow, so anything below `dormant` is untouched here.
        if (nonzeroFlag[origRow] < dormant) {
          nonzeroFlag[origRow] = dormant;
          nonzeroList[nonzeroCount++] = origRow;
        }
      }

      // === Step 2: LEFT-LOOKING sparse triangular solve ===
      // For each column k < j in ascending order with workspace[perm[k]] != 0,
      // record U[k,j] and subtract L[:,k] * U[k,j] from the workspace.
      //
      // The active columns are pivoted rows with a nonzero workspace value.
      // They live in a binary min-heap (activeK[0..activeCount)), so fill that
      // activates a later column is queued in O(log active) and columns are
      // still processed in strictly ascending k. That order fixes the
      // floating-point summation order of every workspace entry.
      let activeCount = 0;
      for (let t = 0; t < nonzeroCount; t++) {
        const origRow = nonzeroList[t];
        const k = pinv[origRow];
        if (k < 0) {
          nonzeroFlag[origRow] = settled;
        } else if (workspace[origRow] !== 0) {
          nonzeroFlag[origRow] = settled;
          activeK[activeCount++] = k;
        } else {
          nonzeroFlag[origRow] = dormant;
        }
      }
      // An ascending array is a valid min-heap.
      sortInt32Prefix(activeK, activeCount);

      while (activeCount > 0) {
        const k = activeK[0];
        activeCount = heapPopMin(activeK, activeCount);

        const ukj = workspace[perm[k]];
        if (ukj === 0) continue;

        // Column k starts the remaining packed members of a supernode: apply
        // them as one block (bit-identical to applying them one by one here).
        const snLast = snEnd[snStart[k]];
        if (snLast > k) {
          // Every key in (k, snLast] is a member; the block applies them.
          while (activeCount > 0 && activeK[0] <= snLast) {
            activeCount = heapPopMin(activeK, activeCount);
          }
          kernelState[0] = up;
          kernelState[1] = nonzeroCount;
          kernelState[2] = activeCount;
          this.applySupernode(k, snLast, settled, dormant);
          up = kernelState[0];
          nonzeroCount = kernelState[1];
          activeCount = kernelState[2];
          uRows = this.uRows;
          uValues = this.uValues;
          continue;
        }

        // Store U[k,j]
        if (up === uValues.length) {
          this.growUFactors(up + 1);
          uRows = this.uRows;
          uValues = this.uValues;
        }
        uRows[up] = k;
        uValues[up] = ukj;
        up++;

        // Apply L column k: subtract L[i,k] * U[k,j] from workspace. Every
        // L[:,k] row was unpivoted at step k, so a pivoted row met here has
        // its pivot column strictly between k and j.
        //
        // Only a row whose value was exactly zero before this update can need
        // a state change: untouched rows hold zero (the workspace is cleared
        // between columns), and a dormant row is by definition a touched row
        // holding zero. A nonzero value therefore belongs to a settled row,
        // so the hot loop tests the value it already loaded and reads the
        // row state only on the rare zero path.
        const pEnd = lColPtr[k + 1];
        for (let p = lColPtr[k]; p < pEnd; p++) {
          const origI = lRows[p];
          const before = workspace[origI];
          workspace[origI] = before - lValues[p] * ukj;
          if (before !== 0) continue;

          const state = nonzeroFlag[origI];
          if (state !== settled) {
            if (state !== dormant) nonzeroList[nonzeroCount++] = origI;
            const k2 = pinv[origI];
            if (k2 < 0) {
              nonzeroFlag[origI] = settled;
            } else if (workspace[origI] !== 0) {
              nonzeroFlag[origI] = settled;
              activeCount = heapPush(activeK, activeCount, k2);
            } else {
              nonzeroFlag[origI] = dormant;
            }
          }
        }
      }

      // === Step 3: THRESHOLD PIVOTING ===
      // Among original rows not yet used as pivots, find the one with largest
      // |workspace[origRow]| for threshold pivoting.
      let maxVal = 0;
      let maxOrigRow = -1;
      for (let t = 0; t < nonzeroCount; t++) {
        const origRow = nonzeroList[t];
        if (pinv[origRow] < 0) {
          const absVal = Math.abs(workspace[origRow]);
          if (absVal > maxVal) {
            maxVal = absVal;
            maxOrigRow = origRow;
          }
        }
      }

      if (maxVal < 1e-18) {
        throw SingularMatrixError.atPivot(col, this.variables);
      }

      // Prefer the natural diagonal candidate (perm[j]) if sufficiently large
      const natOrigRow = perm[j];
      natPos[j] = natOrigRow;
      let chosenOrigRow: number;
      if (pinv[natOrigRow] < 0 && Math.abs(workspace[natOrigRow]) >= this.pivotThreshold * maxVal) {
        chosenOrigRow = natOrigRow;
      } else {
        chosenOrigRow = maxOrigRow;
      }

      const pivotVal = workspace[chosenOrigRow];
      if (Math.abs(pivotVal) < 1e-18) {
        throw SingularMatrixError.atPivot(col, this.variables);
      }

      // Record pivot assignment
      pinv[chosenOrigRow] = j;

      // Update perm: swap chosenOrigRow into position j
      if (chosenOrigRow !== perm[j]) {
        for (let i = j + 1; i < n; i++) {
          if (perm[i] === chosenOrigRow) {
            perm[i] = perm[j];
            perm[j] = chosenOrigRow;
            break;
          }
        }
      }

      // Store U diagonal for column j
      if (up === uValues.length) {
        this.growUFactors(up + 1);
        uRows = this.uRows;
        uValues = this.uValues;
      }
      uRows[up] = j;
      uValues[up] = pivotVal;
      up++;

      // === Step 4: STORE L column j ===
      // For each original row not yet used as a pivot with nonzero workspace value,
      // store L[i,j] = workspace[origRow] / pivotVal.
      // Row indices remain in ORIGINAL row space until the factorization ends;
      // the triangular solve in subsequent columns reads them from lRows.
      // Touched rows whose final value is exactly zero (unpivoted rows that
      // stay out of L, pivoted rows whose column was never applied) are
      // recorded for the pivot-reuse check in refactorWithPivots().
      zeroPtr[j] = zp;
      let beforePivot = true;
      this.pivotPrefix[j] = 0;
      for (let t = 0; t < nonzeroCount; t++) {
        const origRow = nonzeroList[t];
        if (origRow === chosenOrigRow) {
          beforePivot = false;
          continue;
        }
        if (workspace[origRow] === 0) {
          if (zp === zeroRows.length) {
            this.growZeroRows(zp + 1);
            zeroRows = this.zeroRows;
          }
          zeroRows[zp++] = origRow;
        } else if (pinv[origRow] < 0) {
          if (lp === lValues.length) {
            this.growLFactors(lp + 1);
            lRows = this.lRows;
            lValues = this.lValues;
          }
          lRows[lp] = origRow;
          lValues[lp] = workspace[origRow] / pivotVal;
          lp++;
          if (beforePivot) this.pivotPrefix[j]++;
        }
      }

      // Supernode bookkeeping: column j extends the supernode of column j-1
      // when L[:,j-1] holds exactly the new pivot row plus the rows of L[:,j].
      // The supernode's block is packed as it grows, so later columns (from
      // j+1 on) can apply it whether or not it grows further.
      let linked = false;
      if (j > 0) {
        const prevStart = lColPtr[j - 1];
        const prevEnd = lColPtr[j];
        if (prevEnd - prevStart === lp - prevEnd + 1) {
          for (let p = prevStart; p < prevEnd; p++) snMark[lRows[p]] = j;
          if (snMark[chosenOrigRow] === j) {
            linked = true;
            for (let p = prevEnd; p < lp; p++) {
              if (snMark[lRows[p]] !== j) { linked = false; break; }
            }
          }
        }
      }
      if (linked) {
        const s0 = snStart[j - 1];
        snStart[j] = s0;
        if (s0 === j - 1) this.startSupernode(s0);
        this.extendSupernode(s0, j, lp);
      } else {
        snStart[j] = j;
      }

      // === Step 5: CLEAR workspace (only touched positions) ===
      for (let t = 0; t < nonzeroCount; t++) {
        workspace[nonzeroList[t]] = 0;
      }
    }

    lColPtr[n] = lp;
    uColPtr[n] = up;
    zeroPtr[n] = zp;

    // === Step 6: Convert L row indices from original rows to elimination positions ===
    // The final permutation is now fully determined. Convert L's original row
    // indices to elimination-order indices so the solve phase works correctly.
    for (let k = 0; k < n; k++) {
      pinv[perm[k]] = k;
    }
    for (let p = 0; p < lp; p++) {
      lRows[p] = pinv[lRows[p]];
    }

    // Pivot-reuse data, in elimination positions: zero rows, the preferred
    // row of every step, and the position each stored entry of A scatters to.
    for (let p = 0; p < zp; p++) zeroRows[p] = pinv[zeroRows[p]];
    for (let k = 0; k < n; k++) natPos[k] = pinv[natPos[k]];
    const nnzA = A.colPtr[n];
    if (this.scatterPos.length < nnzA) this.scatterPos = new Int32Array(nnzA);
    const scatterPos = this.scatterPos;
    for (let p = 0; p < nnzA; p++) scatterPos[p] = pinv[A.rowIdx[p]];
    this.pivotsColPtr = A.colPtr;
    this.pivotsRowIdx = A.rowIdx;

    this.workspaceDirty = false;
    this.factorized = true;
    this.numericCount++;
    this.recordFactoredInput(A);
  }

  /**
   * Start packing the supernode whose first column is s0, from L[:,s0].
   *
   * A supernode is a run of columns s0..last whose L columns are nested:
   * L[:,s0+m] is L[:,s0] without the pivot rows of columns s0+1..s0+m. Its
   * block holds the rows of L[:,s0] row-major, `snWidth[s0]` slots per row
   * (slot m = the entry in column s0+m). The rows below the supernode come
   * first, in any order; the pivot row of member m is row len - m. Slots of a
   * member row at or after its own column are never read.
   */
  private startSupernode(s0: number): void {
    const lColPtr = this.lColPtr;
    const lRows = this.lRows;
    const lValues = this.lValues;
    const pos = this.snPos;
    const len = lColPtr[s0 + 1] - lColPtr[s0];
    const width = Math.min(len + 1, 4);
    const rowPtr = this.snRowsUsed;
    const valPtr = this.snValuesUsed;
    this.reserveSupernode(rowPtr + len, valPtr + len * width);
    const snRows = this.snRows;
    const snValues = this.snValues;
    for (let i = 0, p = lColPtr[s0]; i < len; i++, p++) {
      const row = lRows[p];
      snRows[rowPtr + i] = row;
      pos[row] = i;
      snValues[valPtr + i * width] = lValues[p];
    }
    this.snEnd[s0] = s0;
    this.snRowPtr[s0] = rowPtr;
    this.snLen[s0] = len;
    this.snValPtr[s0] = valPtr;
    this.snWidth[s0] = width;
    this.snRowsUsed = rowPtr + len;
    this.snValuesUsed = valPtr + len * width;
  }

  /**
   * Append column c to supernode s0. Only the most recently started
   * supernode can grow, so its block is the tail of the pools.
   */
  private extendSupernode(s0: number, c: number, columnEnd: number): void {
    const m = c - s0;
    const len = this.snLen[s0];
    const rowPtr = this.snRowPtr[s0];
    const valPtr = this.snValPtr[s0];
    let width = this.snWidth[s0];
    if (m >= width) {
      // Widen in place, last row first, so no row overwrites an unread one.
      const wider = Math.min(len + 1, 2 * width);
      this.reserveSupernode(rowPtr + len, valPtr + len * wider);
      const values = this.snValues;
      for (let i = len - 1; i >= 0; i--) {
        for (let slot = m - 1; slot >= 0; slot--) {
          values[valPtr + i * wider + slot] = values[valPtr + i * width + slot];
        }
      }
      width = wider;
      this.snWidth[s0] = width;
      this.snValuesUsed = valPtr + len * width;
    }
    const snRows = this.snRows;
    const snValues = this.snValues;
    const pos = this.snPos;

    // Swap the new member's pivot row into its slot, the last row below.
    const pivotRow = this.perm[c];
    const from = pos[pivotRow];
    const to = len - m;
    if (from !== to) {
      const other = snRows[rowPtr + to];
      snRows[rowPtr + to] = pivotRow;
      snRows[rowPtr + from] = other;
      pos[pivotRow] = to;
      pos[other] = from;
      for (let slot = 0; slot < m; slot++) {
        const a = valPtr + from * width + slot;
        const b = valPtr + to * width + slot;
        const value = snValues[a];
        snValues[a] = snValues[b];
        snValues[b] = value;
      }
    }

    const lColPtr = this.lColPtr;
    const lRows = this.lRows;
    const lValues = this.lValues;
    for (let p = lColPtr[c]; p < columnEnd; p++) {
      snValues[valPtr + pos[lRows[p]] * width + m] = lValues[p];
    }
    this.snEnd[s0] = c;
  }

  private reserveSupernode(rows: number, values: number): void {
    if (rows > this.snRows.length) {
      const grown = new Int32Array(Math.max(rows, this.snRows.length * 2));
      grown.set(this.snRows.subarray(0, this.snRowsUsed));
      this.snRows = grown;
    }
    if (values > this.snValues.length) {
      const grown = new Float64Array(Math.max(values, this.snValues.length * 2));
      grown.set(this.snValues.subarray(0, this.snValuesUsed));
      this.snValues = grown;
    }
  }

  /**
   * Apply members first..last of a supernode to the current column of
   * factorize(), with kernelState = [up, nonzeroCount, activeCount] in and
   * out. The result is bit-identical to popping the members one at a time:
   *
   *  - Rows are first touched by column `first`, so they are appended to the
   *    touched list in its L order before any arithmetic, as there.
   *  - A member is applied iff its pivot row value is nonzero once the
   *    earlier members are applied; its U entry is that value (the
   *    triangular part, in ascending member order).
   *  - Each row below the supernode receives the same subtractions in the
   *    same ascending member order, held in a register, and runs the same
   *    activation step whenever a subtraction starts from zero. Only the
   *    order of heap insertions changes, which does not change pop order.
   *  - Member rows are not activated: their keys are consumed here, and
   *    later L columns never contain them.
   */
  private applySupernode(first: number, last: number, settled: number, dormant: number): void {
    const s0 = this.snStart[first];
    const size = last - s0 + 1;
    const workspace = this.workspace;
    const perm = this.perm;
    const pinv = this.pinv;
    const nonzeroFlag = this.nonzeroFlag;
    const nonzeroList = this.nonzeroList;
    const activeK = this.activeK;
    const lColPtr = this.lColPtr;
    const lRows = this.lRows;
    const snValues = this.snValues;
    const snRows = this.snRows;
    const applied = this.snApplied;
    const appliedU = this.snAppliedU;
    const state = this.kernelState;
    const width = this.snWidth[s0];
    const len = this.snLen[s0];
    const below = len - (size - 1);
    const valPtr = this.snValPtr[s0];
    const rowPtr = this.snRowPtr[s0];

    // First touches, in the order applying column `first` alone would make them.
    let nonzeroCount = state[1];
    for (let p = lColPtr[first]; p < lColPtr[first + 1]; p++) {
      const row = lRows[p];
      if (nonzeroFlag[row] < dormant) {
        nonzeroFlag[row] = dormant;
        nonzeroList[nonzeroCount++] = row;
      }
    }
    state[1] = nonzeroCount;

    // Triangular part: U entries of the members and their mutual updates.
    // Row-oriented: member m receives the updates of the earlier applied
    // members in ascending order (the order the column-oriented form applies
    // them in), accumulated in a register over its contiguous block row.
    let up = state[0];
    let count = 0;
    for (let m = first - s0; m < size; m++) {
      const row = perm[s0 + m];
      const base = valPtr + (len - m) * width;
      let u = workspace[row];
      for (let t = 0; t < count; t++) u -= snValues[base + applied[t]] * appliedU[t];
      workspace[row] = u;
      if (u === 0) continue;
      if (up === this.uValues.length) this.growUFactors(up + 1);
      this.uRows[up] = s0 + m;
      this.uValues[up] = u;
      up++;
      applied[count] = m;
      appliedU[count] = u;
      count++;
    }
    state[0] = up;
    this.supernodeCount++;

    // Rows below the supernode. Each row is one dependent chain of
    // subtractions, so four rows advance together to keep the FPU busy.
    //
    // The zero-activation step is a no-op for a settled row, and a settled
    // row stays settled for the rest of the column. So each group runs the
    // checked loop only until all of its rows are settled (normally after
    // the first member, which settles the rows this column touches for the
    // first time), then the same subtractions without any checks. When every
    // member is applied, their slots are consecutive and need no lookup.
    // The arithmetic and its order are unchanged.
    let activeCount = state[2];
    const firstSlot = first - s0;
    const allApplied = count === size - firstSlot;
    let r = 0;
    for (; r + 4 <= below; r += 4) {
      const row0 = snRows[rowPtr + r];
      const row1 = snRows[rowPtr + r + 1];
      const row2 = snRows[rowPtr + r + 2];
      const row3 = snRows[rowPtr + r + 3];
      const base0 = valPtr + r * width;
      const base1 = base0 + width;
      const base2 = base1 + width;
      const base3 = base2 + width;
      let v0 = workspace[row0];
      let v1 = workspace[row1];
      let v2 = workspace[row2];
      let v3 = workspace[row3];
      let t = 0;
      for (; t < count; t++) {
        if (
          nonzeroFlag[row0] === settled && nonzeroFlag[row1] === settled
          && nonzeroFlag[row2] === settled && nonzeroFlag[row3] === settled
        ) break;
        const m = applied[t];
        const u = appliedU[t];
        const n0 = v0 - snValues[base0 + m] * u;
        const n1 = v1 - snValues[base1 + m] * u;
        const n2 = v2 - snValues[base2 + m] * u;
        const n3 = v3 - snValues[base3 + m] * u;
        if (v0 === 0 || v1 === 0 || v2 === 0 || v3 === 0) {
          if (v0 === 0) activeCount = activateRow(row0, n0, settled, dormant, nonzeroFlag, pinv, activeK, activeCount);
          if (v1 === 0) activeCount = activateRow(row1, n1, settled, dormant, nonzeroFlag, pinv, activeK, activeCount);
          if (v2 === 0) activeCount = activateRow(row2, n2, settled, dormant, nonzeroFlag, pinv, activeK, activeCount);
          if (v3 === 0) activeCount = activateRow(row3, n3, settled, dormant, nonzeroFlag, pinv, activeK, activeCount);
        }
        v0 = n0;
        v1 = n1;
        v2 = n2;
        v3 = n3;
      }
      if (allApplied) {
        // Slot of member t is firstSlot + t.
        for (let s = firstSlot + t, sEnd = firstSlot + count; s < sEnd; s++, t++) {
          const u = appliedU[t];
          v0 -= snValues[base0 + s] * u;
          v1 -= snValues[base1 + s] * u;
          v2 -= snValues[base2 + s] * u;
          v3 -= snValues[base3 + s] * u;
        }
      } else {
        for (; t < count; t++) {
          const m = applied[t];
          const u = appliedU[t];
          v0 -= snValues[base0 + m] * u;
          v1 -= snValues[base1 + m] * u;
          v2 -= snValues[base2 + m] * u;
          v3 -= snValues[base3 + m] * u;
        }
      }
      workspace[row0] = v0;
      workspace[row1] = v1;
      workspace[row2] = v2;
      workspace[row3] = v3;
    }
    for (; r < below; r++) {
      const row = snRows[rowPtr + r];
      const base = valPtr + r * width;
      let value = workspace[row];
      let t = 0;
      for (; t < count && nonzeroFlag[row] !== settled; t++) {
        const before = value;
        value = before - snValues[base + applied[t]] * appliedU[t];
        if (before === 0) {
          activeCount = activateRow(row, value, settled, dormant, nonzeroFlag, pinv, activeK, activeCount);
        }
      }
      for (; t < count; t++) value -= snValues[base + applied[t]] * appliedU[t];
      workspace[row] = value;
    }
    state[2] = activeCount;
  }

  /**
   * Refactorize A on the pivot sequence and L/U pattern of the last full
   * factorization, in place — ngspice's spFactor / klu_refactor reuse of the
   * previous ordering. Unlike ngspice, which keeps a reused pivot until it
   * fails a size test, this succeeds only when the full kernel would make
   * exactly the same decisions on these values:
   *
   *  - every reused U entry is nonzero (the kernel skips zero U[k,j], which
   *    would change which L columns are applied);
   *  - every touched row recorded as zero is still exactly zero, and every L
   *    row is nonzero (same L/U patterns, hence the same touched rows in the
   *    same order for later columns);
   *  - the threshold-pivoting rule selects the same row: the preferred row
   *    still passes the threshold, or the off-preference pivot is still the
   *    first maximum in the original candidate order and the preferred row still fails.
   *
   * Under those conditions every workspace entry sees the same operations in
   * the same order as in factorize(), so the factors are bit-identical. On
   * any mismatch it returns false with the workspace dirty and partially
   * overwritten factors; the caller then runs the full factorization.
   */
  private refactorWithPivots(A: CscMatrix): boolean {
    const n = this.n;
    const colPerm = this.colPerm;
    const x = this.workspace;
    const lColPtr = this.lColPtr;
    const lRows = this.lRows;
    const lValues = this.lValues;
    const uColPtr = this.uColPtr;
    const uRows = this.uRows;
    const uValues = this.uValues;
    const natPos = this.natPos;
    const zeroPtr = this.zeroPtr;
    const zeroRows = this.zeroRows;
    const scatterPos = this.scatterPos;
    const aColPtr = A.colPtr;
    const aValues = A.values;
    const threshold = this.pivotThreshold;

    this.factorized = false;
    if (this.workspaceDirty) x.fill(0);
    this.workspaceDirty = true;

    for (let j = 0; j < n; j++) {
      // Scatter column colPerm[j] of A in elimination-position space.
      const col = colPerm[j];
      for (let p = aColPtr[col]; p < aColPtr[col + 1]; p++) {
        x[scatterPos[p]] = aValues[p];
      }

      // Apply the stored U pattern in ascending k (the U diagonal is last).
      const uStart = uColPtr[j];
      const uDiag = uColPtr[j + 1] - 1;
      for (let q = uStart; q < uDiag; q++) {
        const k = uRows[q];
        const ukj = x[k];
        if (ukj === 0) return false;
        x[k] = 0;
        uValues[q] = ukj;
        const pEnd = lColPtr[k + 1];
        for (let p = lColPtr[k]; p < pEnd; p++) {
          x[lRows[p]] -= lValues[p] * ukj;
        }
      }

      for (let z = zeroPtr[j]; z < zeroPtr[j + 1]; z++) {
        if (x[zeroRows[z]] !== 0) return false;
      }

      // Threshold pivot test over the candidates (pivot row and L rows).
      // L values are written speculatively; a failed test discards them.
      const pivotVal = x[j];
      x[j] = 0;
      const lStart = lColPtr[j];
      const lEnd = lColPtr[j + 1];
      const nat = natPos[j];
      let natAbs = 0;
      let maxL = 0;
      let maxBeforePivot = 0;
      const prefixEnd = lStart + this.pivotPrefix[j];
      for (let p = lStart; p < lEnd; p++) {
        const row = lRows[p];
        const v = x[row];
        if (v === 0) return false;
        x[row] = 0;
        lValues[p] = v / pivotVal;
        const a = Math.abs(v);
        if (a > maxL) maxL = a;
        if (p < prefixEnd && a > maxBeforePivot) maxBeforePivot = a;
        if (row === nat) natAbs = a;
      }
      const absPivot = Math.abs(pivotVal);
      if (nat === j) {
        const maxVal = absPivot > maxL ? absPivot : maxL;
        if (!(maxVal >= 1e-18) || !(absPivot >= threshold * maxVal)) return false;
      } else {
        // The preferred row is a later pivot: an L row or untouched (zero).
        // Full factorization takes the first maximum in nonzeroList order.
        // L preserves that order with the pivot removed. Later equal maxima
        // are safe; earlier ties would change the chosen row and must fall back.
        if (!(absPivot >= maxL) || !(absPivot > maxBeforePivot)
          || natAbs >= threshold * absPivot) return false;
      }
      if (!(absPivot >= 1e-18)) return false;
      uValues[uDiag] = pivotVal;

      for (let z = zeroPtr[j]; z < zeroPtr[j + 1]; z++) x[zeroRows[z]] = 0;
    }
    return true;
  }

  private growZeroRows(required: number): void {
    const capacity = Math.max(required, this.zeroRows.length * 2);
    const rows = new Int32Array(capacity);
    rows.set(this.zeroRows);
    this.zeroRows = rows;
  }

  private growLFactors(required: number): void {
    const capacity = Math.max(required, Math.max(4, this.lValues.length * 2));
    const rows = new Int32Array(capacity);
    const values = new Float64Array(capacity);
    rows.set(this.lRows);
    values.set(this.lValues);
    this.lRows = rows;
    this.lValues = values;
  }

  private growUFactors(required: number): void {
    const capacity = Math.max(required, Math.max(4, this.uValues.length * 2));
    const rows = new Int32Array(capacity);
    const values = new Float64Array(capacity);
    rows.set(this.uRows);
    values.set(this.uValues);
    this.uRows = rows;
    this.uValues = values;
  }

  solve(b: Float64Array, acceptOverflow?: (candidate: Float64Array) => boolean): Float64Array {
    if (!this.factorized) {
      throw new Error('Must call factorize before solve');
    }

    const n = this.n;
    const perm = this.perm;
    const lColPtr = this.lColPtr;
    const lRows = this.lRows;
    const lValues = this.lValues;
    const uColPtr = this.uColPtr;
    const uRows = this.uRows;
    const uValues = this.uValues;
    const colPerm = this.colPerm;
    // Factorization leaves the dense column workspace unused. Reuse it for y
    // rather than retaining a second n-element vector for the solve phase.
    // Every entry is initialized below, and factorize() clears it before reuse.
    const y = this.workspace;

    // Apply permutation: y = Pb
    let finiteRhs = true;
    for (let k = 0; k < n; k++) {
      const value = b[perm[k]];
      y[k] = value;
      if (value - value !== 0) finiteRhs = false;
    }
    this.workspaceDirty = true;

    // Forward substitution: Ly = Pb (L is unit lower triangular)
    for (let j = 0; j < n; j++) {
      const yj = y[j];
      for (let p = lColPtr[j]; p < lColPtr[j + 1]; p++) {
        y[lRows[p]] -= lValues[p] * yj;
      }
    }

    // Backward substitution: Uz = y, then x = Qz (using cached diagonal positions).
    // The RHS is caller-owned scratch at every internal call site and is no
    // longer read once y = Pb is formed. Reusing it as x avoids allocating
    // another n-element vector for every Newton solve.
    const x = b;
    let overflowColumn = -1;
    for (let j = n - 1; j >= 0; j--) {
      // Numeric factorization appends each U diagonal after every off-diagonal
      // entry in its column, so the column end already identifies the pivot.
      const zj = y[j] / uValues[uColPtr[j + 1] - 1];
      // Finite factors can still yield an overflowing solution (a long chain
      // of gain stages). Report it like a numeric zero pivot instead of
      // handing Inf/NaN to Newton, whose step tests cannot reject NaN.
      // A non-finite right-hand side is a device stamp, not an overflow:
      // ngspice-47 solves it with IEEE propagation (a B-source V(x)^-0.5
      // evaluates to +inf at the all-zero first iterate, then Newton moves
      // on from the finite entries; #891), so it passes through.
      if (finiteRhs && zj - zj !== 0) {
        if (acceptOverflow === undefined) {
          throw SingularMatrixError.atPivot(colPerm[j], this.variables);
        }
        if (overflowColumn < 0) overflowColumn = colPerm[j];
      }
      x[colPerm[j]] = zj;
      for (let p = uColPtr[j]; p < uColPtr[j + 1]; p++) {
        const i = uRows[p];
        if (i < j) {
          y[i] -= uValues[p] * zj;
        }
      }
    }

    // Complete substitution before certification so Newton can evaluate the
    // device expression at the candidate's finite controls, not at the RHS.
    if (overflowColumn >= 0 && !acceptOverflow!(x)) {
      throw SingularMatrixError.atPivot(overflowColumn, this.variables);
    }
    return x;
  }
}

/**
 * Move structural column singletons ahead of the fill-reducing order.
 *
 * A column whose stored entries all lie in already-claimed rows except one
 * can only pivot on that row. Left-looking threshold pivoting chooses a row
 * per column without looking ahead, so an earlier column whose largest entry
 * sits in that row (e.g. a 1e64 nonlinear derivative) would consume it and
 * leave the singleton column with only round-off below the singularity
 * threshold (#568). ngspice's Markowitz search avoids this by pivoting
 * singletons first (spOrderAndFactor → SearchForSingleton); this does the
 * same structurally, peeling iteratively so that columns which become
 * singletons once a row is claimed are also forced.
 *
 * Peeled columns have empty L columns, so they add no fill. The remaining
 * columns keep their relative order. Stored explicit zeros count as
 * structure, because values change between Newton iterations.
 */
function columnSingletonsFirst(
  A: CscMatrix,
  order: Int32Array,
): { colPerm: Int32Array; rowPref: Int32Array } {
  const n = A.size;
  const { colPtr, rowIdx } = A;

  // Row-wise structure (CSR of the pattern) and unclaimed entries per column.
  const rowPtr = new Int32Array(n + 1);
  const remaining = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    remaining[j] = colPtr[j + 1] - colPtr[j];
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) rowPtr[rowIdx[p] + 1]++;
  }
  for (let i = 0; i < n; i++) rowPtr[i + 1] += rowPtr[i];
  const rowCols = new Int32Array(rowPtr[n]);
  const fill = rowPtr.slice(0, n);
  for (let j = 0; j < n; j++) {
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) rowCols[fill[rowIdx[p]]++] = j;
  }

  const colPerm = new Int32Array(n);
  const rowPref = new Int32Array(n);
  const rowClaimed = new Uint8Array(n);
  const colPlaced = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let t = 0; t < n; t++) {
    if (remaining[order[t]] === 1) queue[tail++] = order[t];
  }

  let k = 0;
  while (head < tail) {
    const c = queue[head++];
    // A column can be queued once; it may since have lost its last row to
    // another singleton (structurally singular) — leave it to the main order.
    if (colPlaced[c] || remaining[c] !== 1) continue;
    let r = -1;
    for (let p = colPtr[c]; p < colPtr[c + 1]; p++) {
      if (!rowClaimed[rowIdx[p]]) { r = rowIdx[p]; break; }
    }
    colPlaced[c] = 1;
    rowClaimed[r] = 1;
    colPerm[k] = c;
    rowPref[k] = r;
    k++;
    for (let p = rowPtr[r]; p < rowPtr[r + 1]; p++) {
      const c2 = rowCols[p];
      if (!colPlaced[c2] && --remaining[c2] === 1 && tail < n) queue[tail++] = c2;
    }
  }

  // Remaining columns in their original relative order, preferring the
  // diagonal row when no singleton claimed it; fill gaps with unclaimed rows.
  const firstRest = k;
  for (let t = 0; t < n; t++) {
    const c = order[t];
    if (colPlaced[c]) continue;
    colPerm[k] = c;
    if (!rowClaimed[c]) {
      rowClaimed[c] = 1;
      rowPref[k] = c;
    } else {
      rowPref[k] = -1;
    }
    k++;
  }
  let nextRow = 0;
  for (let t = firstRest; t < n; t++) {
    if (rowPref[t] >= 0) continue;
    while (rowClaimed[nextRow]) nextRow++;
    rowClaimed[nextRow] = 1;
    rowPref[t] = nextRow;
  }
  return { colPerm, rowPref };
}

/**
 * factorize()'s activation step for a touched row whose value was exactly
 * zero before the subtraction that produced `value`: an unpivoted row
 * becomes a settled L/pivot candidate; a pivoted row becomes an active column
 * (heap insert) if `value` is nonzero, else stays dormant. Returns the new
 * heap count.
 */
function activateRow(
  row: number,
  value: number,
  settled: number,
  dormant: number,
  nonzeroFlag: Int32Array,
  pinv: Int32Array,
  activeK: Int32Array,
  activeCount: number,
): number {
  if (nonzeroFlag[row] === settled) return activeCount;
  const k = pinv[row];
  if (k < 0) {
    nonzeroFlag[row] = settled;
  } else if (value !== 0) {
    nonzeroFlag[row] = settled;
    return heapPush(activeK, activeCount, k);
  } else {
    nonzeroFlag[row] = dormant;
  }
  return activeCount;
}

/** Insert `value` into the binary min-heap heap[0..count); returns the new count. */
function heapPush(heap: Int32Array, count: number, value: number): number {
  let i = count;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const pv = heap[parent];
    if (pv <= value) break;
    heap[i] = pv;
    i = parent;
  }
  heap[i] = value;
  return count + 1;
}

/** Remove the minimum heap[0] from the binary min-heap heap[0..count); returns the new count. */
function heapPopMin(heap: Int32Array, count: number): number {
  const last = count - 1;
  if (last === 0) return 0;
  const value = heap[last];
  let i = 0;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= last) break;
    if (child + 1 < last && heap[child + 1] < heap[child]) child++;
    const cv = heap[child];
    if (cv >= value) break;
    heap[i] = cv;
    i = child;
  }
  heap[i] = value;
  return last;
}

/**
 * Sort the first `count` elements of an Int32Array in ascending order.
 * Insertion sort for the typical short column; typed-array sort once a dense
 * row (e.g. a supply rail ordered last) makes the active set large and,
 * under a fill-reducing ordering, unsorted.
 */
function sortInt32Prefix(arr: Int32Array, count: number): void {
  if (count > 32) {
    arr.subarray(0, count).sort();
    return;
  }
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
