import { SparseMatrix } from '../solver/sparse-matrix.js';
import type { CscMatrix } from '../solver/csc-matrix.js';
import { createSparseSolver, type SparseSolver } from '../solver/sparse-solver.js';
import { DEVICE_GMIN, type StampContext } from '../devices/device.js';
import type { MatrixVariableIdentity } from '../errors.js';

export function createMatrixVariableIdentities(
  nodeNames: readonly string[],
  branchNames: readonly string[],
): MatrixVariableIdentity[] {
  return [
    ...nodeNames.map(name => ({ kind: 'node' as const, name })),
    ...branchNames.map(name => ({ kind: 'branch' as const, name })),
  ];
}

export interface MNAAssemblerOptions {
  solverFactory?: () => SparseSolver;
  variables?: readonly MatrixVariableIdentity[];
  useDcSourceValue?: boolean;
  deviceGmin?: number;
}

/**
 * ngspice-47 cktload.c conductance (and RHS factor) that pins a held node row
 * that also carries a branch-current column.
 */
export const NODE_HOLD_CONDUCTANCE = 1e10;

/** A node row forced to a voltage after every device load (see {@link MNAAssembler.applyNodeHolds}). */
export interface NodeHold {
  /** MNA node index (never ground). */
  readonly node: number;
  /** Held voltage before source scaling. */
  readonly value: number;
}

/** Value slots of one held row in the locked topology. */
interface HeldRowSlots {
  /** Slots of the row's node-voltage columns (diagonal included). */
  readonly voltage: Int32Array;
  /** The row has a structural branch-current column. */
  readonly hasCurrent: boolean;
  readonly diagonal: number;
}

/** Remembered (row, col) -> value-slot sequence of one stamp pass kind. */
interface StampTrace {
  /** Interleaved row, column, value-slot triples. */
  entries: Int32Array;
  length: number;
}

function createStampTrace(capacity: number): StampTrace {
  return {
    entries: new Int32Array(3 * capacity),
    length: 0,
  };
}

export class MNAAssembler {
  public readonly G: SparseMatrix;
  public readonly C: SparseMatrix;
  public readonly b: Float64Array;
  public readonly solution: Float64Array;
  public readonly prevSolution: Float64Array;
  public readonly systemSize: number;
  public time = 0;
  public dt = 0;
  public sourceScale = 1;
  /** Device junction gmin (ngspice CKTgmin) handed to devices through the stamp context. */
  public deviceGmin = DEVICE_GMIN;
  /** Device-local DC startup mode; undefined for ordinary/transient loads. */
  public operatingPointPhase: StampContext['operatingPointPhase'];
  /**
   * Node rows the Newton loop forces after every device load: the `.ic`
   * holds of the transient operating point (ngspice MODETRANOP without UIC).
   */
  public nodeHolds: readonly NodeHold[] = [];
  /** Temporary JCT/FIX rows, released independently of transient .ic holds. */
  public nodeSetHolds: readonly NodeHold[] = [];
  private _heldRowSlots: Map<number, HeldRowSlots> | null = null;

  // Fast-path typed-array stamping infrastructure
  private _fastPath = false;
  private _gValues: Float64Array | null = null;
  private _cValues: Float64Array | null = null;
  private _colPtr: Int32Array | null = null;
  private _rowIdx: Int32Array | null = null;
  private _diagIdx: Int32Array | null = null;
  private _stampIndex: ((row: number, col: number) => number) | null = null;
  private _cachedFastCtx: StampContext | null = null;
  private _solver: SparseSolver | null = null;
  /**
   * Stamp-sequence slot caches, one per stamp pass kind (see
   * {@link getStampContext}). Devices stamp the same (row, col) sequence on
   * every Newton iteration, so the k-th stamp of a pass usually lands on the
   * value slot it hit last time. The k-th entry remembers that position and
   * its slot; a different (row, col) at k falls back to the exact
   * {@link stampIndex} lookup and replaces the entry. The cache only selects
   * where a value is added, never how, so results are bit-identical.
   */
  private _traces: StampTrace[] = [];
  private _trace: StampTrace | null = null;
  private _traceCursor = 0;
  private _traceLimit = 0;

  constructor(
    public readonly numNodes: number,
    public readonly numBranches: number,
    private readonly options: MNAAssemblerOptions = {},
  ) {
    this.deviceGmin = options.deviceGmin ?? DEVICE_GMIN;
    this.systemSize = numNodes + numBranches;
    this.G = new SparseMatrix(this.systemSize);
    this.C = new SparseMatrix(this.systemSize);
    this.b = new Float64Array(this.systemSize);
    this.solution = new Float64Array(this.systemSize);
    this.prevSolution = new Float64Array(this.systemSize);
  }

  get isFastPath(): boolean {
    return this._fastPath;
  }

  get gValues(): Float64Array {
    if (!this._gValues) throw new Error('lockTopology() has not been called');
    return this._gValues;
  }

  get cValues(): Float64Array {
    if (!this._cValues) throw new Error('lockTopology() has not been called');
    return this._cValues;
  }

  get colPtr(): Int32Array {
    if (!this._colPtr) throw new Error('lockTopology() has not been called');
    return this._colPtr;
  }

  get rowIdx(): Int32Array {
    if (!this._rowIdx) throw new Error('lockTopology() has not been called');
    return this._rowIdx;
  }

  get diagIdx(): Int32Array {
    if (!this._diagIdx) throw new Error('lockTopology() has not been called');
    return this._diagIdx;
  }

  get topologyNnz(): number {
    if (!this._rowIdx) throw new Error('lockTopology() has not been called');
    return this._rowIdx.length;
  }

  get stampIndex(): (row: number, col: number) => number {
    if (!this._stampIndex) throw new Error('lockTopology() has not been called');
    return this._stampIndex;
  }

  /**
   * Lock the sparsity pattern after the first stamp pass.
   * Builds CSC structure from the union of all G and C non-zero positions,
   * allocates typed arrays, copies current values, and enables fast-path stamping.
   */
  lockTopology(): void {
    if (this._fastPath) return;
    const n = this.systemSize;

    // Collect the G/C structural union in a typed open-addressed table. Start
    // proportional to the mandatory CSC column pointer and grow only when the
    // actual sparsity requires it; this avoids a boxed Set and one Array per
    // column while remaining general for arbitrary sparsity.
    let lookupCapacity = 4;
    while (lookupCapacity < n * 4) lookupCapacity *= 2;
    let lookupRows = new Int32Array(lookupCapacity).fill(-1);
    let lookupCols = new Int32Array(lookupCapacity);
    let lookupIndices = new Int32Array(lookupCapacity);
    let initialGValues = new Float64Array(lookupCapacity);
    let initialCValues = new Float64Array(lookupCapacity);
    let lookupMask = lookupCapacity - 1;
    let nnz = 0;
    const columnCounts = new Int32Array(n);

    const hashPosition = (row: number, col: number): number => {
      let hash = Math.imul(row, -1640531527) ^ Math.imul(col, -2048144789);
      hash ^= hash >>> 16;
      return hash & lookupMask;
    };
    const growLookup = (): void => {
      const previousRows = lookupRows;
      const previousCols = lookupCols;
      const previousGValues = initialGValues;
      const previousCValues = initialCValues;
      lookupCapacity *= 2;
      lookupRows = new Int32Array(lookupCapacity).fill(-1);
      lookupCols = new Int32Array(lookupCapacity);
      lookupIndices = new Int32Array(lookupCapacity);
      initialGValues = new Float64Array(lookupCapacity);
      initialCValues = new Float64Array(lookupCapacity);
      lookupMask = lookupCapacity - 1;
      for (let previousSlot = 0; previousSlot < previousRows.length; previousSlot++) {
        const row = previousRows[previousSlot];
        if (row === -1) continue;
        const col = previousCols[previousSlot];
        let slot = hashPosition(row, col);
        while (lookupRows[slot] !== -1) slot = (slot + 1) & lookupMask;
        lookupRows[slot] = row;
        lookupCols[slot] = col;
        initialGValues[slot] = previousGValues[previousSlot];
        initialCValues[slot] = previousCValues[previousSlot];
      }
    };
    const addPosition = (row: number, col: number, value: number, isG: boolean): void => {
      let slot = hashPosition(row, col);
      while (lookupRows[slot] !== -1) {
        if (lookupRows[slot] === row && lookupCols[slot] === col) {
          if (isG) initialGValues[slot] = value;
          else initialCValues[slot] = value;
          return;
        }
        slot = (slot + 1) & lookupMask;
      }
      if ((nnz + 1) * 2 > lookupCapacity) {
        growLookup();
        slot = hashPosition(row, col);
        while (lookupRows[slot] !== -1) slot = (slot + 1) & lookupMask;
      }
      lookupRows[slot] = row;
      lookupCols[slot] = col;
      if (isG) initialGValues[slot] = value;
      else initialCValues[slot] = value;
      columnCounts[col]++;
      nnz++;
    };
    for (let row = 0; row < n; row++) {
      for (const [col, value] of this.G.getRow(row)) addPosition(row, col, value, true);
      for (const [col, value] of this.C.getRow(row)) addPosition(row, col, value, false);
    }

    const colPtr = new Int32Array(n + 1);
    const rowIdx = new Int32Array(nnz);
    const gValues = new Float64Array(nnz);
    const cValues = new Float64Array(nnz);
    const diagIdx = new Int32Array(n).fill(-1);

    for (let col = 0; col < n; col++) colPtr[col + 1] = colPtr[col] + columnCounts[col];
    const columnOffsets = colPtr.slice(0, n);
    for (let slot = 0; slot < lookupCapacity; slot++) {
      const row = lookupRows[slot];
      if (row === -1) continue;
      const col = lookupCols[slot];
      rowIdx[columnOffsets[col]++] = row;
    }
    for (let col = 0; col < n; col++) {
      rowIdx.subarray(colPtr[col], colPtr[col + 1]).sort();
    }
    for (let col = 0; col < n; col++) {
      for (let position = colPtr[col]; position < colPtr[col + 1]; position++) {
        const row = rowIdx[position];
        let slot = hashPosition(row, col);
        while (lookupRows[slot] !== row || lookupCols[slot] !== col) {
          slot = (slot + 1) & lookupMask;
        }
        gValues[position] = initialGValues[slot];
        cValues[position] = initialCValues[slot];
        lookupIndices[slot] = position;
        if (row === col) diagIdx[row] = position;
      }
    }
    const stampIndex = (row: number, col: number): number => {
      if (row < 0 || row >= n || col < 0 || col >= n) {
        throw new Error(`Cannot stamp (${row}, ${col}) outside locked topology`);
      }
      let slot = hashPosition(row, col);
      while (lookupRows[slot] !== -1) {
        if (lookupRows[slot] === row && lookupCols[slot] === col) {
          return lookupIndices[slot];
        }
        slot = (slot + 1) & lookupMask;
      }
      throw new Error(`Cannot stamp (${row}, ${col}) outside locked topology`);
    };

    this._colPtr = colPtr;
    this._rowIdx = rowIdx;
    this._gValues = gValues;
    this._cValues = cValues;
    this._stampIndex = stampIndex;
    this._diagIdx = diagIdx;
    this._traces = [];
    this._trace = null;
    this._traceCursor = 0;
    this._heldRowSlots = null;
    // Bound each pass cache: a caller that keeps stamping through one context
    // without starting a new pass must not grow it without limit.
    this._traceLimit = 16 * nnz + 4096;
    this._fastPath = true;
  }

  /**
   * Return the solver bound to the currently locked topology.
   * Symbolic analysis runs once here; callers still factorize for every
   * changed set of numeric matrix values.
   */
  getSparseSolver(): SparseSolver {
    if (!this._fastPath) {
      throw new Error('lockTopology() must be called before requesting a sparse solver');
    }
    if (!this._solver) {
      this._solver = (this.options.solverFactory ?? createSparseSolver)();
      this._solver.analyzePattern(this.getCscMatrix(), this.options.variables);
    }
    return this._solver;
  }

  /**
   * Discard locked structural storage and its symbolic analysis before a
   * caller re-stamps a different topology. Solution vectors are retained so
   * they may be used as an initial guess after the topology change.
   */
  invalidateTopology(): void {
    this._fastPath = false;
    this._gValues = null;
    this._cValues = null;
    this._colPtr = null;
    this._rowIdx = null;
    this._diagIdx = null;
    this._stampIndex = null;
    this._cachedFastCtx = null;
    this._traces = [];
    this._trace = null;
    this._solver = null;
    this._heldRowSlots = null;
    this.G.clear();
    this.C.clear();
    this.b.fill(0);
  }

  /**
   * Returns a CscMatrix view backed by the current gValues.
   * Only available after lockTopology().
   */
  getCscMatrix(): CscMatrix {
    return {
      size: this.systemSize,
      colPtr: this.colPtr,
      rowIdx: this.rowIdx,
      values: this.gValues,
    };
  }

  /**
   * Context for one stamp pass. On the locked fast path every call starts a
   * new pass of kind `pass` for the stamp-sequence slot cache: passes that
   * stamp a different device sequence (for example the trapezoidal history
   * restamp versus the companion build) should use distinct kinds so they do
   * not evict each other. The kind only affects speed, never values.
   */
  getStampContext(pass = 0): StampContext {
    if (this._fastPath) {
      let trace = this._traces[pass];
      if (trace === undefined) {
        trace = createStampTrace(Math.min(this._traceLimit, 4 * this.topologyNnz + 64));
        this._traces[pass] = trace;
      }
      this._trace = trace;
      this._traceCursor = 0;
      if (!this._cachedFastCtx) {
        const gValues = this._gValues!;
        const cValues = this._cValues!;
        this._cachedFastCtx = {
          stampG: (row, col, value) => {
            gValues[this.slotOf(row, col)] += value;
          },
          stampB: (row, value) => { this.b[row] += value; },
          stampC: (row, col, value) => {
            cValues[this.slotOf(row, col)] += value;
          },
          getVoltage: (node) => this.solution[node],
          getCurrent: (branch) => this.solution[this.numNodes + branch],
          time: 0,
          dt: 0,
          numNodes: this.numNodes,
          sourceScale: 1,
          useDcSourceValue: this.options.useDcSourceValue ?? false,
          gmin: DEVICE_GMIN,
        };
      }
      this._cachedFastCtx.time = this.time;
      this._cachedFastCtx.dt = this.dt;
      this._cachedFastCtx.sourceScale = this.sourceScale;
      this._cachedFastCtx.gmin = this.deviceGmin;
      this._cachedFastCtx.operatingPointPhase = this.operatingPointPhase;
      return this._cachedFastCtx;
    }

    return {
      stampG: (row, col, value) => {
        this.G.add(row, col, value);
        // Always register position so lockTopology() captures the full pattern
        if (value === 0) this.G.touch(row, col);
      },
      stampB: (row, value) => { this.b[row] += value; },
      stampC: (row, col, value) => {
        this.C.add(row, col, value);
        if (value === 0) this.C.touch(row, col);
      },
      getVoltage: (node) => this.solution[node],
      getCurrent: (branch) => this.solution[this.numNodes + branch],
      time: this.time,
      dt: this.dt,
      numNodes: this.numNodes,
      sourceScale: this.sourceScale,
      useDcSourceValue: this.options.useDcSourceValue ?? false,
      gmin: this.deviceGmin,
      operatingPointPhase: this.operatingPointPhase,
    };
  }

  /** Value slot of (row, col) for the next stamp of the current pass. */
  private slotOf(row: number, col: number): number {
    const k = this._traceCursor++;
    const trace = this._trace!;
    const entries = trace.entries;
    const p = 3 * k;
    if (k < trace.length && entries[p] === row && entries[p + 1] === col) {
      return entries[p + 2];
    }
    return this.recordSlot(trace, k, row, col);
  }

  private recordSlot(trace: StampTrace, k: number, row: number, col: number): number {
    const slot = this._stampIndex!(row, col);
    const p = 3 * k;
    if (k < trace.length) {
      trace.entries[p] = row;
      trace.entries[p + 1] = col;
      trace.entries[p + 2] = slot;
    } else if (k === trace.length && k < this._traceLimit) {
      if (p === trace.entries.length) {
        const capacity = Math.min(this._traceLimit, 2 * k + 64);
        const entries = new Int32Array(3 * capacity);
        entries.set(trace.entries);
        trace.entries = entries;
      }
      trace.entries[p] = row;
      trace.entries[p + 1] = col;
      trace.entries[p + 2] = slot;
      trace.length = k + 1;
    }
    return slot;
  }

  /**
   * Force every {@link nodeHolds} row after the device load, as ngspice-47
   * cktload.c does for `.ic` in MODETRANOP without MODEUIC. `ZeroNoncurRow`
   * zeroes every node-voltage column of the row and reports whether the row
   * has a branch-current column; then
   * - with a current column: diag += 1e10 and rhs = 1e10 * ic * srcFact;
   * - without: diag = 1 and rhs = ic * srcFact, pinning v = ic exactly.
   * The node's own KCL conductances and currents are discarded either way.
   * Call before the diagonal gmin, which ngspice adds at factorisation.
   * `additive=false` uses cktload.c's nodeset assignment of the diagonal;
   * `.ic` uses addition when both holds apply to a branch-current row.
   */
  applyNodeHolds(holds: readonly NodeHold[] = this.nodeHolds, additive = true): void {
    if (holds.length === 0) return;
    const scale = this.sourceScale;
    if (this._fastPath) {
      const values = this._gValues!;
      for (const hold of holds) {
        const row = this.heldRowSlots(hold.node);
        for (let k = 0; k < row.voltage.length; k++) values[row.voltage[k]] = 0;
        if (row.hasCurrent) {
          if (additive) values[row.diagonal] += NODE_HOLD_CONDUCTANCE;
          else values[row.diagonal] = NODE_HOLD_CONDUCTANCE;
          this.b[hold.node] = NODE_HOLD_CONDUCTANCE * hold.value * scale;
        } else {
          values[row.diagonal] = 1;
          this.b[hold.node] = hold.value * scale;
        }
      }
      return;
    }
    for (const hold of holds) {
      const node = hold.node;
      let hasCurrent = false;
      // Zero the stored row map in place so the positions stay structural.
      const rowMap = this.G.getRow(node);
      for (const col of rowMap.keys()) {
        if (col >= this.numNodes) hasCurrent = true;
        else rowMap.set(col, 0);
      }
      for (const col of this.C.getRow(node).keys()) {
        if (col >= this.numNodes) hasCurrent = true;
      }
      if (hasCurrent) {
        this.G.touch(node, node);
        if (additive) this.G.add(node, node, NODE_HOLD_CONDUCTANCE);
        else this.G.set(node, node, NODE_HOLD_CONDUCTANCE);
        this.b[node] = NODE_HOLD_CONDUCTANCE * hold.value * scale;
      } else {
        this.G.set(node, node, 1);
        this.b[node] = hold.value * scale;
      }
    }
  }

  /** Locked-topology value slots of held row `node`, resolved once per topology. */
  private heldRowSlots(node: number): HeldRowSlots {
    this._heldRowSlots ??= new Map();
    const cached = this._heldRowSlots.get(node);
    if (cached) return cached;
    const colPtr = this._colPtr!;
    const rowIdx = this._rowIdx!;
    const voltage: number[] = [];
    let hasCurrent = false;
    for (let col = 0; col < this.systemSize; col++) {
      for (let position = colPtr[col]; position < colPtr[col + 1]; position++) {
        if (rowIdx[position] !== node) continue;
        if (col >= this.numNodes) hasCurrent = true;
        else voltage.push(position);
        break;
      }
    }
    const diagonal = this._diagIdx![node];
    if (diagonal < 0) throw new Error(`Held node row ${node} has no diagonal in the locked topology`);
    const slots: HeldRowSlots = { voltage: Int32Array.from(voltage), hasCurrent, diagonal };
    this._heldRowSlots.set(node, slots);
    return slots;
  }

  clear(): void {
    if (this._fastPath) {
      this._gValues!.fill(0);
      this._cValues!.fill(0);
      this.b.fill(0);
      return;
    }
    this.G.clear();
    this.C.clear();
    this.b.fill(0);
  }

  saveSolution(): void {
    this.prevSolution.set(this.solution);
  }

  setTime(time: number, dt: number): void {
    this.time = time;
    this.dt = dt;
  }
}
