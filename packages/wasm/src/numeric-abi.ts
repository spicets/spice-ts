export const NUMERIC_WASM_LIMITS = Object.freeze({
  maxSourceBytes: 65_536,
  maxComponents: 256,
  maxSystemOrder: 64,
  maxAcPoints: 1_025,
  maxResultPoints: 4_096,
  memoryPages: 3,
} as const);

export interface NumericWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  abi_version(): number;
  max_order(): number;
  stamp_vccs_f64(
    order: number,
    matrixPointer: number,
    outputPositive: number,
    outputNegative: number,
    controlPositive: number,
    controlNegative: number,
    transconductance: number,
  ): number;
  stamp_cccs_f64(
    order: number,
    matrixPointer: number,
    outputPositive: number,
    outputNegative: number,
    controlBranchColumn: number,
    currentGain: number,
  ): number;
  stamp_vcvs_f64(
    order: number,
    matrixPointer: number,
    outputPositive: number,
    outputNegative: number,
    controlPositive: number,
    controlNegative: number,
    branchColumn: number,
    voltageGain: number,
  ): number;
  stamp_ccvs_f64(
    order: number,
    matrixPointer: number,
    outputPositive: number,
    outputNegative: number,
    controlBranchColumn: number,
    branchColumn: number,
    transresistance: number,
  ): number;
  solve_f64(order: number, matrixPointer: number, rhsPointer: number): number;
  solve_dc_f64(order: number, matrixPointer: number, rhsPointer: number): number;
  solve_complex_f64(
    order: number,
    matrixRealPointer: number,
    matrixImaginaryPointer: number,
    rhsRealPointer: number,
    rhsImaginaryPointer: number,
  ): number;
}

export async function validateNumericWasmModule(module: WebAssembly.Module): Promise<void> {
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error('The numeric WebAssembly module must not import host capabilities');
  }
  const exports = (await WebAssembly.instantiate(module)).exports as NumericWasmExports;
  assertNumericWasmAbi(exports);
  const memoryBytes = exports.memory.buffer.byteLength;
  let grew = false;
  try {
    exports.memory.grow(1);
    grew = true;
  } catch { /* Fixed memory rejects growth. */ }
  if (grew || exports.memory.buffer.byteLength !== memoryBytes) {
    throw new Error('The numeric WebAssembly module memory must not grow');
  }
}

export function assertNumericWasmAbi(exports: NumericWasmExports): void {
  if (!(exports.memory instanceof WebAssembly.Memory)
    || !(exports.__heap_base instanceof WebAssembly.Global)
    || exports.abi_version?.() !== 2
    || exports.max_order?.() !== NUMERIC_WASM_LIMITS.maxSystemOrder
    || typeof exports.stamp_vccs_f64 !== 'function'
    || typeof exports.stamp_cccs_f64 !== 'function'
    || typeof exports.stamp_vcvs_f64 !== 'function'
    || typeof exports.stamp_ccvs_f64 !== 'function'
    || typeof exports.solve_f64 !== 'function'
    || typeof exports.solve_dc_f64 !== 'function'
    || typeof exports.solve_complex_f64 !== 'function'
    || exports.memory.buffer.byteLength !== NUMERIC_WASM_LIMITS.memoryPages * 65_536) {
    throw new Error('The numeric WebAssembly module ABI is incompatible');
  }
  const heapBase = Number(exports.__heap_base.value);
  const workspaceBytes = 8 * (
    2 * NUMERIC_WASM_LIMITS.maxSystemOrder * NUMERIC_WASM_LIMITS.maxSystemOrder
    + 2 * NUMERIC_WASM_LIMITS.maxSystemOrder
  );
  if (!Number.isInteger(heapBase) || heapBase < 0 || heapBase % 8 !== 0
    || heapBase + workspaceBytes > exports.memory.buffer.byteLength) {
    throw new Error('The numeric WebAssembly module workspace is incompatible');
  }
}
