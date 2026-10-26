import { CCCS, CCVS, createTransientSim, frequencyGrid, frequencyPointCount, parseTitleless, VCCS, VCVS, type CompiledCircuit, type SparseSolver, type StampContext, type TransientStep } from '@spice-ts/core';
import type {
  JsonObject,
  SimulationRequestV1,
  SimulationResultV1,
  SpiceApiErrorV1,
} from '@spice-ts/core/protocol';
import {
  assertNumericWasmAbi,
  NUMERIC_WASM_LIMITS,
  type NumericWasmExports,
} from './numeric-abi.js';

export interface NumericValidationResultV1 {
  status: 'valid';
  nodeCount: number;
  branchCount: number;
  analysisCount: number;
}

export class NumericBackendError extends Error {
  constructor(readonly error: SpiceApiErrorV1) {
    super(error.message);
    this.name = 'NumericBackendError';
  }
}

interface PreparedNumericBase {
  compiled: CompiledCircuit;
  order: number;
}

interface PreparedLinearOp extends PreparedNumericBase {
  analysis: 'op';
}

interface SweepableSource {
  name: string;
  waveform: { type: string; [key: string]: unknown };
}

interface PreparedLinearDc extends PreparedNumericBase {
  analysis: 'dc';
  sweep: Extract<CompiledCircuit['analyses'][number], { type: 'dc' }>;
  source: SweepableSource;
  secondarySource?: SweepableSource;
  innerPointCount: number;
  pointCount: number;
}

interface PreparedPassiveAc extends PreparedNumericBase {
  analysis: 'ac';
  frequenciesHz: number[];
}

interface PreparedPassiveTran extends PreparedNumericBase {
  analysis: 'tran';
  hierarchical: boolean;
  transient: Extract<CompiledCircuit['analyses'][number], { type: 'tran' }>;
  normalizedSource: string;
}

type PreparedNumeric = PreparedLinearOp | PreparedLinearDc | PreparedPassiveAc | PreparedPassiveTran;

export function validateLinearOpWasmV1(request: SimulationRequestV1): NumericValidationResultV1 {
  const { compiled } = prepare(request);
  return {
    status: 'valid',
    nodeCount: compiled.nodeCount,
    branchCount: compiled.branchCount,
    analysisCount: compiled.analyses.length,
  };
}

export async function simulateLinearOpWasmV1(
  request: SimulationRequestV1,
  wasmBytes: Uint8Array,
  maxPoints: number = NUMERIC_WASM_LIMITS.maxResultPoints,
): Promise<SimulationResultV1> {
  const prepared = prepare(request);
  const instantiated = await WebAssembly.instantiate(wasmBytes.slice().buffer as ArrayBuffer);
  const exports = instantiated.instance.exports as NumericWasmExports;
  assertNumericWasmAbi(exports);

  if (prepared.analysis === 'op') return simulateOp(prepared, request, exports);
  if (prepared.analysis === 'dc') return simulateDc(prepared, request, exports);
  if (prepared.analysis === 'tran') {
    if (prepared.transient.startTime !== undefined || prepared.transient.maxTimestep !== undefined
      || request.options?.maxTimestep !== undefined || prepared.transient.useInitialConditions
      || prepared.hierarchical || prepared.compiled.devices.some(device => {
      const waveform = (device as unknown as Partial<SweepableSource>).waveform;
      // Switches reuse core's Newton state-memory and timestep/breakpoint driver.
      return ['D', 'Q', 'M', 'J', 'K', 'S', 'W'].includes(deviceType(device.name) ?? '')
        || (['C', 'L'].includes(deviceType(device.name) ?? '')
          && (device as { ic?: number }).ic !== undefined)
        || waveform?.type === 'sin' || waveform?.type === 'pwl'
        || waveform?.type === 'exp' || waveform?.type === 'sffm';
    })) {
      return simulateAdaptiveTransient(prepared, request, exports, maxPoints);
    }
    return simulateTransient(prepared, request, exports);
  }
  return simulateAc(prepared, request, exports);
}

function simulateDc(
  { compiled, order, sweep, source, secondarySource, innerPointCount, pointCount }: PreparedLinearDc,
  request: SimulationRequestV1,
  exports: NumericWasmExports,
): SimulationResultV1 {
  const values: number[] = [];
  const voltagesV = Object.fromEntries(compiled.nodeNames.map(name => [name, [] as number[]]));
  const currentsA = Object.fromEntries(compiled.branchNames.map(name => [name, [] as number[]]));
  const originalWaveform = source.waveform;
  const originalSecondaryWaveform = secondarySource?.waveform;
  const nonlinear = compiled.devices.some(device => ['D', 'Q', 'M', 'J', 'S', 'W'].includes(deviceType(device.name) ?? ''));
  let previous: Float64Array | undefined;
  let value = sweep.start;
  let outerValue = sweep.secondary?.start ?? 0;
  try {
    for (let point = 0; point < pointCount; point++) {
      if (point % innerPointCount === 0) {
        value = sweep.start;
        if (point > 0) outerValue += sweep.secondary!.step;
        if (secondarySource) secondarySource.waveform = { type: 'dc', value: outerValue };
      }
      values.push(value);
      source.waveform = { type: 'dc', value };
      value += sweep.step;
      if (nonlinear) {
        const solution = solveNonlinearOp(compiled, order, request, exports, previous);
        previous = solution;
        compiled.nodeNames.forEach((name, index) => voltagesV[name]!.push(solution[index]!));
        compiled.branchNames.forEach((name, index) => currentsA[name]!.push(solution[compiled.nodeCount + index]!));
        continue;
      }
      const matrix = new Float64Array(order * order);
      const rhs = new Float64Array(order);
      const zero = new Float64Array(order);
      const context: StampContext = {
        stampG(row, column, stamped) { matrix[row * order + column] += stamped; },
        stampB(row, stamped) { rhs[row] += stamped; },
        stampC() {},
        getVoltage(node) { return node < 0 ? 0 : zero[node]!; },
        getCurrent(branch) { return zero[compiled.nodeCount + branch]!; },
        time: 0,
        dt: 0,
        numNodes: compiled.nodeCount,
        sourceScale: 1,
        useDcSourceValue: true,
      };
      for (const device of compiled.devices) device.stamp(context);
      addGmin(matrix, compiled.nodeCount, order, request.options?.gmin ?? 0);
      const solution = solveReal(exports, order, matrix, rhs);
      compiled.nodeNames.forEach((name, index) => voltagesV[name]!.push(solution[index]!));
      compiled.branchNames.forEach((name, index) => currentsA[name]!.push(solution[compiled.nodeCount + index]!));
    }
  } finally {
    source.waveform = originalWaveform;
    if (secondarySource && originalSecondaryWaveform) secondarySource.waveform = originalSecondaryWaveform;
  }

  const result: SimulationResultV1 = {
    status: 'complete',
    analyses: [{
      type: 'dc', analysisIndex: 0,
      axis: { name: source.name, unit: deviceType(source.name) === 'I' ? 'A' : 'V', values },
      voltagesV, currentsA,
    }],
  };
  enforceSerializedResultLimit(result, request);
  return result;
}

function simulateOp(
  { compiled, order }: PreparedLinearOp,
  request: SimulationRequestV1,
  exports: NumericWasmExports,
): SimulationResultV1 {
  if (compiled.devices.some(device => ['D', 'Q', 'M', 'J', 'S', 'W'].includes(deviceType(device.name) ?? ''))) {
    return opResult(compiled, solveNonlinearOp(compiled, order, request, exports), request);
  }
  const matrix = new Float64Array(order * order);
  const rhs = new Float64Array(order);
  const zero = new Float64Array(order);
  const context: StampContext = {
    stampG(row, column, value) { matrix[row * order + column] += value; },
    stampB(row, value) { rhs[row] += value; },
    stampC() {},
    getVoltage(node) { return node < 0 ? 0 : zero[node]!; },
    getCurrent(branch) { return zero[compiled.nodeCount + branch]!; },
    time: 0,
    dt: 0,
    numNodes: compiled.nodeCount,
    sourceScale: 1,
    useDcSourceValue: true,
  };
  for (const device of compiled.devices) {
    if (!(device instanceof VCCS) && !(device instanceof CCCS)
      && !(device instanceof VCVS) && !(device instanceof CCVS)) device.stamp(context);
  }
  const gmin = request.options?.gmin ?? 0;
  for (let node = 0; node < compiled.nodeCount; node++) matrix[node * order + node] += gmin;

  const heapBase = Number(exports.__heap_base.value);
  const matrixPointer = align8(heapBase);
  const rhsPointer = matrixPointer + matrix.byteLength;
  if (rhsPointer + rhs.byteLength > exports.memory.buffer.byteLength) {
    throw resourceLimit('numericWasmMemoryBytes', exports.memory.buffer.byteLength, rhsPointer + rhs.byteLength);
  }
  new Float64Array(exports.memory.buffer, matrixPointer, matrix.length).set(matrix);
  new Float64Array(exports.memory.buffer, rhsPointer, rhs.length).set(rhs);
  for (const device of compiled.devices) {
    let stampStatus: number;
    if (device instanceof VCCS) {
      const [outputPositive, outputNegative, controlPositive, controlNegative] = device.nodes;
      stampStatus = exports.stamp_vccs_f64(
        order,
        matrixPointer,
        outputPositive!,
        outputNegative!,
        controlPositive!,
        controlNegative!,
        device.gm,
      );
    } else if (device instanceof CCCS) {
      const [outputPositive, outputNegative] = device.nodes;
      stampStatus = exports.stamp_cccs_f64(
        order,
        matrixPointer,
        outputPositive!,
        outputNegative!,
        compiled.nodeCount + device.controlBranchIndex,
        device.gain,
      );
    } else if (device instanceof VCVS) {
      const [outputPositive, outputNegative, controlPositive, controlNegative] = device.nodes;
      stampStatus = exports.stamp_vcvs_f64(
        order,
        matrixPointer,
        outputPositive!,
        outputNegative!,
        controlPositive!,
        controlNegative!,
        compiled.nodeCount + device.branchIndex,
        device.gain,
      );
    } else if (device instanceof CCVS) {
      const [outputPositive, outputNegative] = device.nodes;
      stampStatus = exports.stamp_ccvs_f64(
        order,
        matrixPointer,
        outputPositive!,
        outputNegative!,
        compiled.nodeCount + device.controlBranchIndex,
        compiled.nodeCount + device.branchIndex,
        device.gain,
      );
    } else {
      continue;
    }
    if (stampStatus !== 0) {
      throw numericError('INVALID_CIRCUIT', 'The bounded WebAssembly controlled-source stamp rejected numeric data', 'solve', {
        device: device.name, order, status: stampStatus,
      });
    }
  }
  const status = exports.solve_f64(order, matrixPointer, rhsPointer);
  if (status === 1) {
    throw numericError('SINGULAR_MATRIX', 'The bounded WebAssembly matrix is singular', 'solve', { order });
  }
  if (status !== 0) {
    throw numericError('INVALID_CIRCUIT', 'The bounded WebAssembly solver rejected non-finite numeric data', 'solve', { order, status });
  }
  const solution = new Float64Array(exports.memory.buffer, rhsPointer, order).slice();
  return opResult(compiled, solution, request);
}

function solveNonlinearOp(
  compiled: CompiledCircuit, order: number, request: SimulationRequestV1, exports: NumericWasmExports,
  initial?: Float64Array,
  // OP/DC avoids leakage cancellation; AC bias keeps its established rounding.
  dcOrdering = true,
): Float64Array {
  let previous: Float64Array = initial ?? new Float64Array(order);
  const matrix = new Float64Array(order * order);
  const rhs = new Float64Array(order);
  // Core tolerances, with bounded caller-controlled work and no fallback solver.
  const maxIterations = Math.min(request.options?.maxIterations ?? 100, 1000);
  const reltol = request.options?.reltol ?? DEFAULT_RELTOL;
  const context: StampContext = {
    stampG(row, column, value) { matrix[row * order + column] += value; },
    stampB(row, value) { rhs[row] += value; },
    stampC() {},
    getVoltage(node) { return node < 0 ? 0 : previous[node]!; },
    getCurrent(branch) { return previous[compiled.nodeCount + branch]!; },
    time: 0, dt: 0, numNodes: compiled.nodeCount, sourceScale: 1, useDcSourceValue: true,
  };
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    matrix.fill(0);
    rhs.fill(0);
    // Reuse core's nonlinear companion models; the linear solve stays in WASM.
    for (const device of compiled.devices) device.stamp(context);
    addGmin(matrix, compiled.nodeCount, order, request.options?.gmin ?? 0);
    if (!matrix.every(Number.isFinite) || !rhs.every(Number.isFinite)) break;
    const solution = solveReal(exports, order, matrix, rhs, dcOrdering);
    let stepScale = 1;
    for (const device of compiled.devices) {
      stepScale = Math.min(stepScale, device.limitNewtonStep?.(previous, solution) ?? 1);
    }
    if (stepScale < 1) {
      for (let index = 0; index < order; index++) {
        solution[index] = previous[index]! + stepScale * (solution[index]! - previous[index]!);
      }
    }
    const converged = solution.every((value, index) => Math.abs(value - previous[index]!)
      <= (index < compiled.nodeCount ? request.options?.vntol ?? 1e-6 : request.options?.abstol ?? 1e-12)
        + reltol * Math.abs(value))
      && stepScale === 1 && !compiled.devices.some(device => device.limitedLastStamp?.())
      && compiled.devices.every(device => device.convergenceTest?.(solution, {
        reltol, abstol: request.options?.abstol ?? 1e-12, vntol: request.options?.vntol ?? 1e-6,
      }) ?? true);
    // Only the first point has initial/fixed-junction iterations. Later DC
    // points retain device state and may converge immediately, like core.
    if ((initial !== undefined || iteration >= 2) && converged) return solution;
    previous = solution;
  }
  const deviceKind = compiled.devices.some(device => deviceType(device.name) === 'M') ? 'MOS1'
    : compiled.devices.some(device => deviceType(device.name) === 'Q') ? 'BJT' : 'diode';
  throw numericError('CONVERGENCE_FAILED', `The bounded WebAssembly ${deviceKind} operating point did not converge`, 'solve', {
    maxIterations,
  });
}

function opResult(compiled: CompiledCircuit, solution: Float64Array, request: SimulationRequestV1): SimulationResultV1 {
  const result: SimulationResultV1 = {
    status: 'complete',
    analyses: [{
      type: 'op',
      analysisIndex: 0,
      voltagesV: Object.fromEntries(compiled.nodeNames.map((name, index) => [name, solution[index]! ])),
      currentsA: Object.fromEntries(compiled.branchNames.map((name, index) => [
        name,
        solution[compiled.nodeCount + index]!,
      ])),
    }],
  };
  enforceSerializedResultLimit(result, request);
  return result;
}

function simulateTransient(
  { compiled, order, transient }: PreparedPassiveTran,
  request: SimulationRequestV1,
  exports: NumericWasmExports,
): SimulationResultV1 {
  const pointCount = transientPointCount(transient.stopTime, transient.timestep);
  const pointLimit = Math.min(
    NUMERIC_WASM_LIMITS.maxResultPoints,
    request.options?.limits?.maxResultPoints ?? Infinity,
  );
  if (pointCount > pointLimit) throw resourceLimit('maxResultPoints', pointLimit, pointCount);

  for (const device of compiled.devices) device.setTransientTimestep?.(transient.timestep);
  const gmin = request.options?.gmin ?? 0;
  const initial = stampTransientSystem(compiled, order, 0, true, new Float64Array(order));
  addGmin(initial.conductance, compiled.nodeCount, order, gmin);
  let solution = solveReal(exports, order, initial.conductance, initial.rhs);
  let previousRhs = initial.rhs;
  let previousTime = 0;
  const timeS = [0];
  const voltagesV = Object.fromEntries(compiled.nodeNames.map((name, index) => [name, [solution[index]!]]));
  const currentsA = Object.fromEntries(compiled.branchNames.map((name, index) => [
    name,
    [solution[compiled.nodeCount + index]!],
  ]));

  for (let point = 1; point < pointCount; point++) {
    const time = Math.min(point * transient.timestep, transient.stopTime);
    const dt = time - previousTime;
    const stamped = stampTransientSystem(compiled, order, time, false, solution);
    addGmin(stamped.conductance, compiled.nodeCount, order, gmin);
    const matrix = new Float64Array(stamped.conductance.length);
    const rhs = new Float64Array(order);
    const dynamicScale = 2 / dt;
    for (let row = 0; row < order; row++) {
      let history = 0;
      for (let column = 0; column < order; column++) {
        const index = row * order + column;
        matrix[index] = stamped.conductance[index]! + dynamicScale * stamped.dynamic[index]!;
        history += (dynamicScale * stamped.dynamic[index]! - stamped.conductance[index]!) * solution[column]!;
      }
      rhs[row] = stamped.rhs[row]! + previousRhs[row]! + history;
    }
    solution = solveReal(exports, order, matrix, rhs);
    previousRhs = stamped.rhs;
    previousTime = time;
    timeS.push(time);
    compiled.nodeNames.forEach((name, index) => voltagesV[name]!.push(solution[index]!));
    compiled.branchNames.forEach((name, index) => currentsA[name]!.push(solution[compiled.nodeCount + index]!));
  }

  const result: SimulationResultV1 = {
    status: 'complete',
    analyses: [{ type: 'tran', analysisIndex: 0, timeS, voltagesV, currentsA }],
  };
  enforceSerializedResultLimit(result, request);
  return result;
}

/** Shared adaptive driver and device models; every DC/Newton solve stays in WASM. */
async function simulateAdaptiveTransient(
  { compiled, transient, normalizedSource }: PreparedPassiveTran,
  request: SimulationRequestV1,
  exports: NumericWasmExports,
  maxPoints: number,
): Promise<SimulationResultV1> {
  const options = request.options;
  if (request.input.format !== 'spice') unsupported('input-format', 'SPICE text is required');
  const sim = await createTransientSim(parseTitleless(normalizedSource), {
    abstol: options?.abstol, vntol: options?.vntol, reltol: options?.reltol,
    maxIterations: options?.maxIterations, maxTransientIterations: options?.maxTransientIterations,
    gmin: options?.gmin, trtol: options?.trtol, maxTimestep: options?.maxTimestep,
    solverFactory: (): SparseSolver => {
      let analyzed = false;
      let matrix = new Float64Array(0);
      let order = 0;
      return {
        analyzePattern() { analyzed = true; },
        isPatternAnalyzed() { return analyzed; },
        factorize(csc) {
          order = csc.size;
          matrix = new Float64Array(order * order);
          for (let column = 0; column < order; column++) {
            for (let i = csc.colPtr[column]!; i < csc.colPtr[column + 1]!; i++) {
              matrix[csc.rowIdx[i]! * order + column] = csc.values[i]!;
            }
          }
        },
        solve(rhs) { rhs.set(solveReal(exports, order, matrix, rhs)); return rhs; },
      };
    },
  });
  const timeS: number[] = [];
  const voltagesV = Object.fromEntries(compiled.nodeNames.map(name => [name, [] as number[]]));
  const currentsA = Object.fromEntries(compiled.branchNames.map(name => [name, [] as number[]]));
  const resultLimit = options?.limits?.maxResultPoints ?? Infinity;
  const append = (step: TransientStep): void => {
    if (step.time < (transient.startTime ?? 0)) return;
    const observed = timeS.length + 1;
    if (observed > resultLimit) throw resourceLimit('maxResultPoints', resultLimit, observed);
    if (observed > maxPoints) throw resourceLimit('maxPoints', maxPoints, observed);
    timeS.push(step.time);
    for (const [name, value] of step.voltages) voltagesV[name]!.push(value);
    for (const [name, value] of step.currents) currentsA[name]!.push(value);
  };
  try {
    // UIC's t=0 state is an IC seed, not a solved output point (#856).
    if (!transient.useInitialConditions) append(sim.peekInitialStep());
    while (!sim.isDone) append(sim.advance());
  } finally { sim.dispose(); }
  const result: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS, voltagesV, currentsA }] };
  enforceSerializedResultLimit(result, request);
  return result;
}

function transientPointCount(stopTime: number, timestep: number): number {
  const intervalCount = stopTime / timestep;
  const nearestInteger = Math.round(intervalCount);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(intervalCount)) * 2;
  return (Math.abs(intervalCount - nearestInteger) <= tolerance
    ? nearestInteger
    : Math.ceil(intervalCount)) + 1;
}

function stampTransientSystem(
  compiled: CompiledCircuit,
  order: number,
  time: number,
  useDcSourceValue: boolean,
  solution: Float64Array,
): { conductance: Float64Array; dynamic: Float64Array; rhs: Float64Array } {
  const conductance = new Float64Array(order * order);
  const dynamic = new Float64Array(order * order);
  const rhs = new Float64Array(order);
  const context: StampContext = {
    stampG(row, column, value) { conductance[row * order + column] += value; },
    stampB(row, value) { rhs[row] += value; },
    stampC(row, column, value) { dynamic[row * order + column] += value; },
    getVoltage(node) { return node < 0 ? 0 : solution[node]!; },
    getCurrent(branch) { return solution[compiled.nodeCount + branch]!; },
    time,
    dt: 0,
    numNodes: compiled.nodeCount,
    sourceScale: 1,
    useDcSourceValue,
  };
  for (const device of compiled.devices) {
    device.stamp(context);
    device.stampDynamic?.(context);
  }
  return { conductance, dynamic, rhs };
}

function solveReal(
  exports: NumericWasmExports,
  order: number,
  matrix: Float64Array,
  rhs: Float64Array,
  dcOrdering = false,
): Float64Array {
  const matrixPointer = align8(Number(exports.__heap_base.value));
  const rhsPointer = matrixPointer + matrix.byteLength;
  if (rhsPointer + rhs.byteLength > exports.memory.buffer.byteLength) {
    throw resourceLimit('numericWasmMemoryBytes', exports.memory.buffer.byteLength, rhsPointer + rhs.byteLength);
  }
  new Float64Array(exports.memory.buffer, matrixPointer, matrix.length).set(matrix);
  new Float64Array(exports.memory.buffer, rhsPointer, rhs.length).set(rhs);
  const status = dcOrdering
    ? exports.solve_dc_f64(order, matrixPointer, rhsPointer)
    : exports.solve_f64(order, matrixPointer, rhsPointer);
  if (status === 1) {
    throw numericError('SINGULAR_MATRIX', 'The bounded WebAssembly matrix is singular', 'solve', { order });
  }
  if (status !== 0) {
    throw numericError('INVALID_CIRCUIT', 'The bounded WebAssembly solver rejected non-finite numeric data', 'solve', { order, status });
  }
  return new Float64Array(exports.memory.buffer, rhsPointer, order).slice();
}

function addGmin(matrix: Float64Array, nodeCount: number, order: number, gmin: number): void {
  for (let node = 0; node < nodeCount; node++) matrix[node * order + node] += gmin;
}

function simulateAc(
  { compiled, order, frequenciesHz }: PreparedPassiveAc,
  request: SimulationRequestV1,
  exports: NumericWasmExports,
): SimulationResultV1 {
  const conductance = new Float64Array(order * order);
  const dynamic = new Float64Array(order * order);
  const rhsReal = new Float64Array(order);
  const rhsImaginary = new Float64Array(order);
  const operatingPoint = compiled.devices.some(device => ['D', 'Q', 'M', 'J', 'S'].includes(deviceType(device.name) ?? ''))
    ? solveNonlinearOp(compiled, order, request, exports, undefined, false)
    : new Float64Array(order);
  const context: StampContext = {
    stampG(row, column, value) { conductance[row * order + column] += value; },
    stampB() {},
    stampC(row, column, value) { dynamic[row * order + column] += value; },
    getVoltage(node) { return node < 0 ? 0 : operatingPoint[node]!; },
    getCurrent(branch) { return operatingPoint[compiled.nodeCount + branch]!; },
    time: 0,
    dt: 0,
    numNodes: compiled.nodeCount,
    sourceScale: 1,
    useDcSourceValue: true,
  };
  for (const device of compiled.devices) {
    if (device.stampSmallSignal) device.stampSmallSignal(context);
    else device.stamp(context);
  }
  for (const device of compiled.devices) device.stampDynamic?.(context);
  const gmin = request.options?.gmin ?? 0;
  for (let node = 0; node < compiled.nodeCount; node++) {
    conductance[node * order + node] += gmin;
  }
  for (const device of compiled.devices) {
    const contribution = device.getACExcitation?.();
    if (!contribution) continue;
    const phase = contribution.phase * Math.PI / 180;
    const real = contribution.magnitude * Math.cos(phase);
    const imaginary = contribution.magnitude * Math.sin(phase);
    if (contribution.kind === 'branch') {
      const row = compiled.nodeCount + contribution.branch;
      rhsReal[row] += real;
      rhsImaginary[row] += imaginary;
    } else {
      if (contribution.positiveNode >= 0) {
        rhsReal[contribution.positiveNode] -= real;
        rhsImaginary[contribution.positiveNode] -= imaginary;
      }
      if (contribution.negativeNode >= 0) {
        rhsReal[contribution.negativeNode] += real;
        rhsImaginary[contribution.negativeNode] += imaginary;
      }
    }
  }

  const heapBase = align8(Number(exports.__heap_base.value));
  const matrixRealPointer = heapBase;
  const matrixImaginaryPointer = matrixRealPointer + conductance.byteLength;
  const rhsRealPointer = matrixImaginaryPointer + dynamic.byteLength;
  const rhsImaginaryPointer = rhsRealPointer + rhsReal.byteLength;
  const requiredBytes = rhsImaginaryPointer + rhsImaginary.byteLength;
  if (requiredBytes > exports.memory.buffer.byteLength) {
    throw resourceLimit('numericWasmMemoryBytes', exports.memory.buffer.byteLength, requiredBytes);
  }

  const voltagePhasors = Object.fromEntries([...compiled.nodeNames].sort().map(name => [name, []])) as
    Record<string, Array<{ magnitude: number; phaseDegrees: number }>>;
  const currentPhasors = Object.fromEntries([...compiled.branchNames].sort().map(name => [name, []])) as
    Record<string, Array<{ magnitude: number; phaseDegrees: number }>>;
  for (const [pointIndex, frequencyHz] of frequenciesHz.entries()) {
    const matrixImaginary = new Float64Array(dynamic.length);
    const omega = 2 * Math.PI * frequencyHz;
    for (let index = 0; index < dynamic.length; index++) {
      matrixImaginary[index] = dynamic[index]! * omega;
    }
    new Float64Array(exports.memory.buffer, matrixRealPointer, conductance.length).set(conductance);
    new Float64Array(exports.memory.buffer, matrixImaginaryPointer, matrixImaginary.length).set(matrixImaginary);
    new Float64Array(exports.memory.buffer, rhsRealPointer, rhsReal.length).set(rhsReal);
    new Float64Array(exports.memory.buffer, rhsImaginaryPointer, rhsImaginary.length).set(rhsImaginary);
    const status = exports.solve_complex_f64(
      order, matrixRealPointer, matrixImaginaryPointer, rhsRealPointer, rhsImaginaryPointer,
    );
    if (status === 1) {
      throw numericError('SINGULAR_MATRIX', 'The bounded WebAssembly complex matrix is singular', 'solve', {
        order, analysis: 'ac', pointIndex, frequencyHz,
      });
    }
    if (status !== 0) {
      throw numericError('INVALID_CIRCUIT', 'The bounded WebAssembly complex solver rejected numeric data', 'solve', {
        order, analysis: 'ac', pointIndex, frequencyHz, status,
      });
    }
    const solutionReal = new Float64Array(exports.memory.buffer, rhsRealPointer, order);
    const solutionImaginary = new Float64Array(exports.memory.buffer, rhsImaginaryPointer, order);
    compiled.nodeNames.forEach((name, index) => {
      voltagePhasors[name]!.push(polar(solutionReal[index]!, solutionImaginary[index]!));
    });
    compiled.branchNames.forEach((name, index) => {
      const solutionIndex = compiled.nodeCount + index;
      currentPhasors[name]!.push(polar(solutionReal[solutionIndex]!, solutionImaginary[solutionIndex]!));
    });
  }

  const result: SimulationResultV1 = {
    status: 'complete',
    analyses: [{
      type: 'ac', analysisIndex: 0, frequencyHz: frequenciesHz,
      voltagePhasors, currentPhasors,
    }],
  };
  enforceSerializedResultLimit(result, request);
  return result;
}

function enforceSerializedResultLimit(result: SimulationResultV1, request: SimulationRequestV1): void {
  const configured = request.options?.limits?.maxSerializedResultBytes;
  if (configured === undefined) return;
  const observed = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (observed > configured) {
    throw numericError('RESOURCE_LIMIT', "Resource limit 'maxSerializedResultBytes' exceeded", 'serialize', {
      limit: 'maxSerializedResultBytes', configured, observed,
    });
  }
}

function polar(real: number, imaginary: number): { magnitude: number; phaseDegrees: number } {
  return {
    magnitude: Math.hypot(real, imaginary),
    phaseDegrees: Math.atan2(imaginary, real) * 180 / Math.PI,
  };
}

function prepare(request: SimulationRequestV1): PreparedNumeric {
  if (request.input.format !== 'spice') unsupported('input-format', 'Only SPICE text input is supported');
  if (request.input.virtualFiles && Object.keys(request.input.virtualFiles).length > 0) {
    unsupported('virtual-files', 'Virtual files are not supported');
  }
  const source = request.input.source;
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  const sourceLimit = Math.min(NUMERIC_WASM_LIMITS.maxSourceBytes, request.options?.limits?.maxSourceBytes ?? Infinity);
  if (sourceBytes > sourceLimit) throw resourceLimit('maxSourceBytes', sourceLimit, sourceBytes);

  const cards = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('*'));
  const components = cards.filter(line => !line.startsWith('.'));
  const componentLimit = Math.min(NUMERIC_WASM_LIMITS.maxComponents, request.options?.limits?.maxComponents ?? Infinity);
  if (components.length > componentLimit) throw resourceLimit('maxComponents', componentLimit, components.length);
  const analyses = cards.filter(line => /^\.(op|dc|tran|ac)\b/i.test(line));
  const analysisLimit = Math.min(1, request.options?.limits?.maxAnalyses ?? Infinity);
  if (analyses.length > analysisLimit) throw resourceLimit('maxAnalyses', analysisLimit, analyses.length);
  if (analyses.length !== 1) unsupported('analysis', 'Exactly one .op, .dc, .tran, or .ac analysis is supported');
  const analysis = /^\.op(?:\s|$)/i.test(analyses[0]!)
    ? 'op'
    : /^\.dc(?:\s|$)/i.test(analyses[0]!)
      ? 'dc'
    : /^\.tran(?:\s|$)/i.test(analyses[0]!)
      ? 'tran'
    : /^\.ac(?:\s|$)/i.test(analyses[0]!)
      ? 'ac'
      : unsupported('analysis', 'Exactly one .op, .dc, .tran, or .ac analysis is supported');

  if (analysis === 'dc') validateDcControls(analyses[0]!);
  if (analysis === 'tran') validateTransientControls(analyses[0]!, request);
  const normalizedCards = validateHierarchyCards(cards, analysis);
  let compiled: CompiledCircuit;
  try {
    // Core owns expansion, lexical model scope and hierarchical node/branch names.
    // Only compilation is shared: numeric solves continue to use the WASM kernel.
    const circuit = parseTitleless(normalizedCards.join('\n'));
    compiled = circuit.compile();
  } catch (error) {
    if (error instanceof NumericBackendError) throw error;
    throw numericError('INVALID_CIRCUIT', error instanceof Error ? error.message : String(error), 'compile');
  }
  if (compiled.devices.length > componentLimit) {
    throw resourceLimit('maxComponents', componentLimit, compiled.devices.length);
  }
  if (compiled.steps.length > 0 || compiled.poleZeroAnalyses.length > 0
    || compiled.analyses.length !== 1 || compiled.analyses[0]?.type !== analysis) {
    unsupported('analysis', `Exactly one unstepped .${analysis} analysis is supported`);
  }
  const devices = analysis === 'op' || analysis === 'dc'
    ? ['R', 'L', 'K', 'I', 'V', 'G', 'F', 'E', 'H', 'D', 'Q', 'M', 'J', 'S', 'W']
    : ['R', 'C', 'L', 'K', 'I', 'V', 'G', 'F', 'E', 'H', 'D', 'Q', 'M', 'J', 'S', 'W'];
  if (compiled.devices.some(device => !devices.includes(deviceType(device.name) ?? ''))) {
    unsupported('device', `Only ${devices.join(', ')} devices are supported for .${analysis}`);
  }
  validateControlledSourceValues(compiled);
  validateSwitchValues(compiled);
  if (analysis !== 'op') validatePassiveValues(compiled);
  const order = compiled.nodeCount + compiled.branchCount;
  if (order < 1) throw numericError('INVALID_CIRCUIT', 'The circuit has no numeric unknowns', 'compile');
  if (order > NUMERIC_WASM_LIMITS.maxSystemOrder) {
    throw resourceLimit('maxSystemOrder', NUMERIC_WASM_LIMITS.maxSystemOrder, order);
  }
  if (analysis === 'op') return { analysis, compiled, order };

  const compiledAnalysis = compiled.analyses[0];
  if (analysis === 'dc') {
    if (compiledAnalysis?.type !== 'dc') unsupported('analysis', 'Exactly one .dc analysis is supported');
    const innerPointCount = dcPointCount(compiledAnalysis.start, compiledAnalysis.stop, compiledAnalysis.step);
    const secondary = compiledAnalysis.secondary;
    const pointCount = innerPointCount * (secondary ? dcPointCount(secondary.start, secondary.stop, secondary.step) : 1);
    const pointLimit = Math.min(
      NUMERIC_WASM_LIMITS.maxResultPoints,
      request.options?.limits?.maxResultPoints ?? Infinity,
    );
    if (pointCount > pointLimit) throw resourceLimit('maxResultPoints', pointLimit, pointCount);
    const resolveSource = (name: string): SweepableSource => {
      const normalized = name.toUpperCase();
      const sources = compiled.devices.filter(device => {
        const candidate = device as unknown as Partial<SweepableSource>;
        return candidate.name?.toUpperCase() === normalized && candidate.waveform !== undefined
          && ['V', 'I'].includes(deviceType(candidate.name) ?? '');
      }) as unknown as SweepableSource[];
      if (sources.length !== 1) {
        throw numericError('INVALID_CIRCUIT', `DC sweep source '${name}' must identify one independent source`, 'validation', {
          feature: 'dc-source', source: name, matches: sources.length,
        });
      }
      if (!['dc', 'ac'].includes(sources[0]!.waveform.type)) {
        unsupported('source-waveform', 'DC sweep sources must use a constant or DC value');
      }
      return sources[0]!;
    };
    if (secondary?.source.toUpperCase() === compiledAnalysis.source.toUpperCase()) {
      throw numericError('INVALID_CIRCUIT', 'DC sweep sources must be distinct', 'validation', { feature: 'dc-source' });
    }
    return {
      analysis, compiled, order, sweep: compiledAnalysis, source: resolveSource(compiledAnalysis.source),
      secondarySource: secondary ? resolveSource(secondary.source) : undefined, innerPointCount, pointCount,
    };
  }
  if (analysis === 'tran') {
    if (compiledAnalysis?.type !== 'tran') unsupported('analysis', 'Exactly one .tran analysis is supported');
    const { timestep, stopTime, startTime = 0, maxTimestep } = compiledAnalysis;
    const optionMaxTimestep = request.options?.maxTimestep;
    if (![timestep, stopTime, startTime].every(Number.isFinite)
      || timestep <= 0 || stopTime <= 0 || startTime < 0 || startTime >= stopTime
      || (maxTimestep !== undefined && (!Number.isFinite(maxTimestep) || maxTimestep <= 0))
      || (optionMaxTimestep !== undefined && (!Number.isFinite(optionMaxTimestep) || optionMaxTimestep <= 0))) {
      throw numericError('INVALID_CIRCUIT', 'Transient controls must be finite, with positive TSTEP/TSTOP/TMAX and 0 <= TSTART < TSTOP', 'validation', {
        backend: 'spice-ts-wasm', feature: 'tran-controls',
      });
    }
    return { analysis, compiled, order, transient: compiledAnalysis, normalizedSource: normalizedCards.join('\n'), hierarchical: cards.some(card => /^X/i.test(card)) };
  }
  if (compiledAnalysis?.type !== 'ac') unsupported('analysis', 'Exactly one .ac analysis is supported');
  const reltol = request.options?.reltol ?? DEFAULT_RELTOL;
  const pointCount = frequencyPointCount(compiledAnalysis, reltol, 'ac');
  const pointLimit = Math.min(
    NUMERIC_WASM_LIMITS.maxAcPoints,
    request.options?.limits?.maxResultPoints ?? Infinity,
  );
  // Check before materialising the grid: an oversized sweep must not allocate it first.
  if (pointCount > pointLimit) throw resourceLimit('maxResultPoints', pointLimit, pointCount);
  return { analysis, compiled, order, frequenciesHz: frequencyGrid(compiledAnalysis, reltol, 'ac') };
}

/** Validate raw device/model forms before core expands hierarchy and parameters. */
function validateHierarchyCards(cards: string[], analysis: 'op' | 'dc' | 'tran' | 'ac'): string[] {
  const normalized = [...cards];
  const scopes: number[][] = [[]];
  const stack = [scopes[0]!];
  for (const [index, card] of cards.entries()) {
    const definition = /^\.subckt\b/i.test(card);
    const instance = /^X/i.test(card);
    if (definition) {
      const scope: number[] = [];
      scopes.push(scope);
      stack.push(scope);
    } else if (/^\.ends\b/i.test(card)) {
      if (stack.length === 1) throw numericError('INVALID_CIRCUIT', 'Unmatched .ends', 'validation');
      stack.pop();
    } else if (!instance) {
      stack[stack.length - 1]!.push(index);
    }
  }
  if (stack.length !== 1) throw numericError('INVALID_CIRCUIT', 'Unclosed .subckt definition', 'validation');
  for (const indices of scopes) {
    const scopeCards = indices.map(index => cards[index]!);
    validateCards(scopeCards, analysis, cards.some(card => /^\.(?:temp|options)\b/i.test(card)));
    const scoped = normalizeAndValidateCurrentControlledSources(scopeCards);
    indices.forEach((index, offset) => { normalized[index] = scoped[offset]!; });
  }
  return normalized;
}

function validateCards(cards: string[], analysis: 'op' | 'dc' | 'tran' | 'ac', temperatureEnabled: boolean): void {
  const allowedDevices = analysis === 'op' || analysis === 'dc'
    ? ['R', 'L', 'K', 'I', 'V', 'G', 'F', 'E', 'H', 'D', 'Q', 'M', 'J', 'S', 'W']
    : ['R', 'C', 'L', 'K', 'I', 'V', 'G', 'F', 'E', 'H', 'D', 'Q', 'M', 'J', 'S', 'W'];
  for (const card of cards) {
    if (/^\.options\b/i.test(card)) {
      const options = card.replace(/^\.options\s*/i, '');
      const option = new RegExp(`\\b(?:TEMP|TNOM)\\s*=\\s*${SPICE_NUMBER.source.slice(1, -1)}(?:\\s+|$)`, 'gi');
      if (!options || options.replace(option, '').trim()) {
        unsupported('circuit-temperature', 'Only numeric .options TEMP/TNOM are supported');
      }
      continue;
    }
    if (/^\.temp\b/i.test(card)) {
      if (!new RegExp(`^\\.temp\\s+${SPICE_NUMBER.source.slice(1, -1)}\\s*$`, 'i').test(card)) {
        unsupported('circuit-temperature', 'Only one numeric circuit temperature is supported');
      }
      continue;
    }
    if (/^\.param\b/i.test(card)) continue;
    if (new RegExp(`^\\.(?:${analysis}|end)(?:\\s|$)`, 'i').test(card)) continue;
    if (/^\.model\b/i.test(card)) {
      const model = /^\.model\s+\S+\s+(D|R|RES|C|L|NPN|PNP|NMOS|PMOS|NJF|PJF|SW|CSW)(?:\s*\((.*)\)|\s+(.*))?\s*$/i.exec(card);
      if (!model) unsupported('nonlinear-model', 'Only bounded diode, BJT, MOS1, JFET, SW and CSW models are supported');
      const mos = /MOS$/i.test(model[1]!);
      const bjt = /^(NPN|PNP)$/i.test(model[1]!);
      const jfet = /^(NJF|PJF)$/i.test(model[1]!);
      const parameters = (model[2] ?? model[3] ?? '').trim();
      if (/^(SW|CSW)$/i.test(model[1]!)) {
        if (analysis === 'ac' && /^CSW$/i.test(model[1]!)) unsupported('switch-analysis', 'CSW models are supported only for OP/DC/TRAN');
        const names = /^CSW$/i.test(model[1]!) ? 'IT|IH|RON|ROFF' : 'VT|VH|RON|ROFF';
        const parameter = new RegExp(`\\b(?:${names})\\s*=\\s*(${SPICE_NUMBER.source.slice(1, -1)})(?:\\s+|,\\s*|$)`, 'gi');
        let finite = true;
        const remaining = parameters.replace(parameter, (_match, value: string) => {
          finite &&= Number.isFinite(parseFloat(value));
          return '';
        }).trim();
        if (remaining || !finite) {
          unsupported('switch-model-parameter', `Only finite numeric ${model[1]} model parameters ${names.replaceAll('|', ', ')} are supported`);
        }
        continue;
      }
      const mosNames = 'LEVEL|VTO|KP|LAMBDA|GAMMA|PHI|RD|RS|RSH'
        + (analysis === 'tran' || analysis === 'ac' ? '|TOX|CGSO|CGDO|CGBO|CBD|CBS|CJ|CJSW|PB|MJ|MJSW|FC' : '');
      const diodeNames = 'IS|N|RS|CJO|CJ0|VJ|M|FC|TT|BV|IBV'
        + (temperatureEnabled ? '|EG|XTI|TNOM|TBV1' : '');
      // The core device supplies the charge Jacobian and accepted/rejected-step
      // history, including temperature-adjusted junction capacitances/potentials;
      // the nonlinear transient and AC paths solve it through WASM.
      const bjtNames = 'IS|BF|BR|NF|NR|VAF|RB|RC|RE|CJE|VJE|MJE|CJC|VJC|MJC|FC|TF|TR'
        + (temperatureEnabled ? '|XTI|EG|XTB' : '');
      const jfetNames = 'LEVEL|VTO|BETA|LAMBDA|IS|N|RD|RS|CGS|CGD|PB|FC'
        + (temperatureEnabled ? '|TNOM|EG|XTI|TCV|VTOTC|BEX|BETATCE' : '');
      const resistor = /^(R|RES)$/i.test(model[1]!);
      const cl = /^(C|L)$/i.test(model[1]!);
      if (cl && analysis !== 'tran' && analysis !== 'ac') unsupported('nonlinear-model', 'C/L models require transient or AC analysis');
      const names = resistor || cl ? 'TC1|TC2|TNOM' : jfet ? jfetNames : mos ? mosNames : bjt ? bjtNames : diodeNames;
      // Check every LEVEL occurrence, not just the final duplicate consumed by core.
      if (mos && [...parameters.matchAll(/\bLEVEL\s*=\s*([^\s,]+)/gi)].some(match => Number(match[1]) !== 1)) {
        unsupported('mosfet-model-parameter', 'Only MOSFET LEVEL=1 is supported');
      }
      if (jfet && [...parameters.matchAll(/\bLEVEL\s*=\s*([^\s,]+)/gi)].some(match => Number(match[1]) !== 1)) {
        unsupported('jfet-model-parameter', 'Only JFET LEVEL=1 is supported');
      }
      const parameter = new RegExp(`\\b(?:${names})\\s*=\\s*${SPICE_NUMBER.source.slice(1, -1)}(?:\\s+|,\\s*|$)`, 'gi');

      const remaining = parameters.replace(parameter, '').trim();
      if (remaining) {
        if (cl) unsupported('passive-form', 'C/L models support numeric TC1, TC2 and TNOM only');
        if (resistor) unsupported('resistor-model-parameter', 'Only resistor TC1, TC2 and TNOM are supported');
        if (jfet) unsupported('jfet-model-parameter', `Only JFET model parameters ${jfetNames.replaceAll('|', ', ')} are supported (LEVEL=1 only)`);
        if (mos) unsupported('mosfet-model-parameter', `Only MOS1 model parameters ${mosNames.replaceAll('|', ', ')} are supported (LEVEL=1 only)`);
        if (bjt) unsupported('bjt-model-parameter', `Only BJT model parameters ${bjtNames.replaceAll('|', ', ')} are supported`);
        const name = /^[a-z][a-z0-9_]*/i.exec(remaining)?.[0]?.toUpperCase();
        unsupported(name ? `diode-model-parameter:${name}` : 'diode-model-parameter',
          `Only diode model parameters ${diodeNames.replaceAll('|', ', ')} are supported`);
      }
      continue;
    }
    const tokens = card.split(/\s+/);
    const type = tokens[0]?.[0]?.toUpperCase() ?? '';
    if (type === 'K') {
      if (tokens.length !== 4 || !SPICE_NUMBER.test(tokens[3]!)) {
        unsupported('inductor-coupling', 'Couplings must use name inductor1 inductor2 constant-k');
      }
      continue;
    }
    if (!allowedDevices.includes(type)) {
      unsupported('device-or-directive', `Unsupported linear .${analysis} card '${tokens[0] ?? ''}'`);
    }
    if (type === 'S' || type === 'W') {
      if (analysis === 'ac' && type === 'W') unsupported('switch-analysis', 'CSW models are supported only for OP/DC/TRAN');
      const length = type === 'S' ? 6 : 5;
      if ((tokens.length !== length && tokens.length !== length + 1)
        || (tokens.length === length + 1 && !/^(ON|OFF)$/i.test(tokens[length]!))) {
        unsupported('switch-form', type === 'S'
          ? 'Switches must use name positive negative control-positive control-negative model with optional ON/OFF'
          : 'Current switches must use name positive negative controlling-voltage-source model with optional ON/OFF');

      }
    } else if (type === 'J') {
      const area = tokens[5];
      if ((tokens.length !== 5 && tokens.length !== 6)
        || (area !== undefined && (!SPICE_NUMBER.test(area) || !Number.isFinite(parseFloat(area)) || parseFloat(area) <= 0))) {
        unsupported('jfet-form', 'JFETs must use name drain gate source model with optional positive numeric positional area');
      }
    } else if (type === 'D') {
      if (tokens.length !== 4) unsupported('diode-form', 'Diodes must use name anode cathode model');
    } else if (type === 'Q') {
      if (tokens.length !== 5) unsupported('bjt-form', 'BJTs must use name collector base emitter model');
    } else if (type === 'M') {
      const instance = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+(.*)$/.exec(card);
      const instanceNames = 'W|L|NRD|NRS'
        + (analysis === 'tran' || analysis === 'ac' ? '|AD|AS|PD|PS' : '');
      const dimensions = new RegExp(`(?:${instanceNames})\\s*=\\s*${SPICE_NUMBER.source.slice(1, -1)}(?:\\s+|$)`, 'gi');
      if (!instance || instance[1]!.trim().replace(dimensions, '').trim()) {
        unsupported('mosfet-form', `MOSFETs must use name drain gate source bulk model with optional numeric ${instanceNames.replaceAll('|', ', ')} only`);
      }
    } else if (type === 'L' && analysis !== 'tran' && analysis !== 'ac') {
      const withoutIC = card.replace(new RegExp(`\\s+IC\\s*=\\s*${SPICE_NUMBER.source.slice(1, -1)}\\s*$`, 'i'), '').split(/\s+/);
      if (withoutIC.length !== 4 || !SPICE_NUMBER.test(withoutIC[3]!)) {
        unsupported('inductor-form', 'Inductors must use name positive negative constant-inductance');
      }
    } else if (type === 'R') {
      // Preserve the existing four-token expression/parameter form unchanged.
      if (tokens.length === 4) continue;
      const instance = /^\S+\s+\S+\s+\S+\s+(\S+)(?:\s+([^=\s]+))?(.*)$/.exec(card);
      const number = SPICE_NUMBER.source.slice(1, -1);
      const parameters = new RegExp(`\\b(?:TC1|TC2|TNOM)\\s*=\\s*${number}(?:\\s+|$)`, 'gi');
      // A model may precede an explicit resistance, as in core's resistor parser.
      const tail = card.split(/\s+/).slice(4).join(' ');
      const numericValue = SPICE_NUMBER.test(tokens[3] ?? '');
      const remainder = numericValue ? tail : tail.replace(new RegExp(`^${number}(?:\\s+|$)`, 'i'), '');
      if (!instance || (!numericValue && !SPICE_NUMBER.test(tokens[4] ?? ''))
        || remainder.replace(parameters, '').trim()) {
        unsupported('passive-form', 'Resistors require a resistance, optional model, and numeric TC1/TC2/TNOM only');
      }
    } else if (type === 'C' || type === 'L') {
      const number = SPICE_NUMBER.source.slice(1, -1);
      const parameters = new RegExp(`\\b(?:TC1|TC2|IC)\\s*=\\s*${number}(?:\\s+|$)`, 'gi');
      let tail = tokens.slice(4).join(' ');
      // Optional model follows the explicit value; core resolves lexical scope.
      if (tokens[4] && !tokens[4].includes('=') && !/^(?:TC1|TC2|IC)$/i.test(tokens[4])) {
        tail = tokens.slice(5).join(' ');
      }
      const remainder = tail.replace(parameters, '').trim();
      if (type === 'L' && !SPICE_NUMBER.test(tokens[3] ?? '')) {
        unsupported('inductor-form', 'Inductors must use name positive negative constant-inductance');
      }
      // Core compilation applies the temperature law once; WASM stamps those values.
      if (tokens.length < 4 || remainder) {
        unsupported('passive-form', 'C/L devices require a value, optional model, and numeric TC1/TC2/IC only');
      }
    } else if (type === 'G') {
      if (tokens.length !== 6 || !SPICE_NUMBER.test(tokens[5]!)) {
        unsupported('vccs-form', 'VCCS devices must use name out+ out- control+ control- transconductance');
      }
    } else if (type === 'F') {
      if (tokens.length !== 5 || !SPICE_NUMBER.test(tokens[4]!)) {
        unsupported('cccs-form', 'CCCS devices must use name out+ out- controlling-voltage-source current-gain');
      }
    } else if (type === 'E') {
      const behavioral = /^\S+\s+\S+\s+\S+\s+VALUE\s*=/i.test(card);
      if (tokens.length !== 6 || behavioral || !SPICE_NUMBER.test(tokens[5]!)) {
        unsupported('vcvs-form', 'VCVS devices must use name out+ out- control+ control- voltage-gain');
      }
    } else if (type === 'H') {
      if (tokens.length !== 5 || !SPICE_NUMBER.test(tokens[4]!)) {
        unsupported('ccvs-form', 'CCVS devices must use name out+ out- controlling-voltage-source transresistance');
      }
    } else if (analysis === 'op' || analysis === 'dc') {
      const dc = tokens.length === 5 && tokens[3]?.toUpperCase() === 'DC';
      if (tokens.length !== 4 && !dc) {
        unsupported('source-waveform', `${analysis.toUpperCase()} sources must use a constant or DC value`);
      }
    } else if (analysis === 'tran') {
      const dc = tokens.length === 5 && tokens[3]?.toUpperCase() === 'DC';
      const pulse = /^\S+\s+\S+\s+\S+\s+PULSE\s*\([^)]*\)\s*$/i.test(card);
      const sin = /^\S+\s+\S+\s+\S+\s+SIN\s*\([^)]*\)\s*$/i.test(card);
      const pwl = /^\S+\s+\S+\s+\S+\s+PWL\s*\([^)]*\)\s*$/i.test(card);
      const exp = /^\S+\s+\S+\s+\S+\s+EXP\s*\([^)]*\)\s*$/i.test(card);
      const sffm = /^\S+\s+\S+\s+\S+\s+SFFM\s*\([^)]*\)\s*$/i.test(card);
      if (tokens.length !== 4 && !dc && !pulse && !sin && !pwl && !exp && !sffm) {
        unsupported('source-waveform', 'Transient sources must use a constant, DC, PULSE, SIN, PWL, EXP, or SFFM value');
      }
    } else if (!validAcSourceTokens(tokens)) {
      unsupported('source-waveform', 'AC sources must use constant, DC, AC, or DC plus AC values');
    }
  }
}

/** Default protocol reltol, matching the resolved options reported by the facade (index.ts). */
const DEFAULT_RELTOL = 1e-3;
const SPICE_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z]*$/i;

function normalizeAndValidateCurrentControlledSources(cards: string[]): string[] {
  const normalizedCards = [...cards];
  const devices = cards
    .map((card, cardIndex) => ({ card, cardIndex }))
    .filter(({ card }) => !card.startsWith('.'))
    .map(({ card, cardIndex }) => {
      const tokens = card.split(/\s+/);
      return {
        cardIndex,
        name: tokens[0]!,
        normalizedName: tokens[0]!.toUpperCase(),
        type: tokens[0]![0]!.toUpperCase(),
        controlSource: tokens[3],
        normalizedControlSource: tokens[3]?.toUpperCase(),
        tokens,
      };
    });

  for (const device of devices) {
    if (device.type === 'K') {
      const references = device.tokens.slice(1, 3).map(name => devices.filter(candidate =>
        candidate.normalizedName === name.toUpperCase() && candidate.type === 'L'));
      if (references.some(matches => matches.length !== 1 || matches[0]!.cardIndex >= device.cardIndex)
        || device.tokens[1]!.toUpperCase() === device.tokens[2]!.toUpperCase()) {
        throw numericError('INVALID_CIRCUIT', 'Couplings require two distinct previously declared inductors', 'validation', { feature: 'inductor-coupling' });
      }
      device.tokens[1] = references[0]![0]!.name;
      device.tokens[2] = references[1]![0]!.name;
      normalizedCards[device.cardIndex] = device.tokens.join(' ');
      continue;
    }
    if (device.type !== 'F' && device.type !== 'H') continue;
    const controllingVoltageSource = devices.find(candidate =>
      candidate.normalizedName === device.normalizedControlSource && candidate.type === 'V');
    const referencedDevice = devices.find(candidate =>
      candidate.normalizedName === device.normalizedControlSource);
    const reason = controllingVoltageSource && controllingVoltageSource.cardIndex > device.cardIndex
      ? 'forward-reference'
      : referencedDevice
        ? 'branchless'
        : 'missing';
    if (controllingVoltageSource && controllingVoltageSource.cardIndex < device.cardIndex) {
      device.tokens[3] = controllingVoltageSource.name;
      normalizedCards[device.cardIndex] = device.tokens.join(' ');
      continue;
    }
    const label = device.type === 'F' ? 'CCCS' : 'CCVS';
    const feature = device.type === 'F' ? 'cccs-control-source' : 'ccvs-control-source';
    throw numericError(
      'INVALID_CIRCUIT',
      `${label} device '${device.name}' must reference a preceding voltage-source branch`,
      'validation',
      {
        backend: 'spice-ts-wasm',
        feature,
        device: device.name,
        controlSource: device.controlSource!,
        reason,
      },
    );
  }
  return normalizedCards;
}

function validateDcControls(card: string): void {
  const tokens = card.trim().split(/\s+/);
  if (tokens.length > 5 && (tokens.length !== 9 || !/^[VI]/i.test(tokens[5]!)
    || tokens.slice(6).some(token => !SPICE_NUMBER.test(token)))) {
    unsupported('dc-nested-sweep', 'Only two independent-source linear DC sweeps are supported');
  }
  if (tokens.length !== 5 && tokens.length !== 9) {
    throw numericError('INVALID_CIRCUIT', 'DC sweep must use .dc source start stop step', 'validation', {
      feature: 'dc-grid',
    });
  }
}

function dcPointCount(start: number, stop: number, step: number): number {
  if (![start, stop, step].every(Number.isFinite) || step === 0
    || (stop > start && step < 0) || (stop < start && step > 0)) {
    throw numericError('INVALID_CIRCUIT', 'DC sweep grid must be finite with a nonzero step toward stop', 'validation', {
      feature: 'dc-grid', start, stop, step,
    });
  }
  // Mirror core/ngspice's accumulated DC grid, including its absolute endpoint
  // tolerance. Stop counting once rejection is inevitable; never allocate a grid.
  let count = 0;
  for (let value = start; Math.sign(step) * (value - stop) <= Number.EPSILON * 1e3;) {
    count++;
    if (count > NUMERIC_WASM_LIMITS.maxResultPoints) return count;
    const next = value + step;
    if (next === value) break;
    value = next;
  }
  return count;
}

function validateTransientControls(card: string, request: SimulationRequestV1): void {
  const tokens = card.trim().split(/\s+/).slice(1);
  if (tokens.at(-1)?.toUpperCase() === 'UIC') tokens.pop();
  if (tokens.length > 4 || (tokens.length === 4 && !SPICE_NUMBER.test(tokens[3]!))) {
    unsupported('tran-max-timestep', 'Transient maximum timestep is not supported');
  }
  if (tokens.length >= 3 && !SPICE_NUMBER.test(tokens[2]!)) {
    unsupported('tran-start-time', 'Transient start time is not supported');
  }

  if (request.options?.integrationMethod && request.options.integrationMethod !== 'trapezoidal') {
    unsupported('integration-method', 'Only trapezoidal transient integration is supported');
  }

  if (request.options?.trtol !== undefined) {
    unsupported('trtol', 'Transient LTE controls are not supported');
  }
}

function validAcSourceTokens(tokens: string[]): boolean {
  const first = tokens[3]?.toUpperCase();
  if (tokens.length === 4) return true;
  if (first === 'DC') {
    return tokens.length === 5
      || ((tokens.length === 7 || tokens.length === 8) && tokens[5]?.toUpperCase() === 'AC');
  }
  return first === 'AC' && (tokens.length === 5 || tokens.length === 6);
}

function validateSwitchValues(compiled: CompiledCircuit): void {
  for (const device of compiled.devices) {
    if (!['S', 'W'].includes(deviceType(device.name) ?? '')) continue;
    // Validate core-resolved values, including SPICE suffix scaling and defaults.
    // Both states must be stampable, regardless of the initial control voltage.
    const { model } = device as unknown as {
      model: { onConductance: number; offConductance: number };
    };
    if ([model.onConductance, model.offConductance].some(conductance =>
      conductance === 0 || !Number.isFinite(conductance) || !Number.isFinite(1 / conductance))) {
      unsupported('switch-model-parameter', 'SW and CSW model RON and ROFF must resolve to nonzero finite resistances and conductances');
    }
  }
}

function validateControlledSourceValues(compiled: CompiledCircuit): void {
  for (const device of compiled.devices) {
    if (device instanceof VCCS && !Number.isFinite(device.gm)) {
      throw numericError('INVALID_CIRCUIT', `VCCS device '${device.name}' must have a finite transconductance`, 'compile');
    }
    if (device instanceof CCCS && !Number.isFinite(device.gain)) {
      throw numericError('INVALID_CIRCUIT', `CCCS device '${device.name}' must have a finite current gain`, 'compile');
    }
    if (device instanceof VCVS && !Number.isFinite(device.gain)) {
      throw numericError('INVALID_CIRCUIT', `VCVS device '${device.name}' must have a finite voltage gain`, 'compile');
    }
    if (device instanceof CCVS && !Number.isFinite(device.gain)) {
      throw numericError('INVALID_CIRCUIT', `CCVS device '${device.name}' must have a finite transresistance`, 'compile');
    }
  }
}

// Core prefixes expanded device names with their X-instance path.
function deviceType(name: string): string | undefined {
  return name.replace(/^(?:X[^.]*\.)+/i, '')[0]?.toUpperCase();
}

function validatePassiveValues(compiled: CompiledCircuit): void {
  for (const device of compiled.devices) {
    const type = deviceType(device.name);
    const passive = device as unknown as {
      resistance?: number;
      capacitance?: number;
      inductance?: number;
    };
    const value = type === 'R' ? passive.resistance
      : type === 'C' ? passive.capacitance
        : type === 'L' ? passive.inductance
          : undefined;
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw numericError('INVALID_CIRCUIT', `Passive device '${device.name}' must have a positive finite value`, 'compile');
    }
  }
}

function align8(value: number): number {
  return (value + 7) & ~7;
}

function unsupported(feature: string, message: string): never {
  throw numericError('UNSUPPORTED_FEATURE', message, 'validation', { backend: 'spice-ts-wasm', feature });
}

function resourceLimit(limit: string, configured: number, observed: number): NumericBackendError {
  return numericError('RESOURCE_LIMIT', `Resource limit '${limit}' exceeded`, 'validation', {
    limit, configured, observed,
  });
}

function numericError(
  code: SpiceApiErrorV1['code'],
  message: string,
  phase: SpiceApiErrorV1['phase'],
  details: JsonObject = {},
): NumericBackendError {
  return new NumericBackendError({ code, message, retryable: false, phase, details });
}
