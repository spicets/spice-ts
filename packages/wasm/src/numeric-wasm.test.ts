import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sha256, type SimulationRequestV1 } from '@spice-ts/core/protocol';
import {
  createSpiceEngine,
  SpiceEngineError,
  type SpiceEngine,
  type SpiceWorkerManifestV1,
  type WorkerLike,
} from './index.js';
import { NUMERIC_WASM_LIMITS, validateNumericWasmModule, type NumericWasmExports } from './numeric-abi.js';

const circuits = [
  'V1 in 0 5\nR1 in 0 1k\n.op',
  'I1 0 out 2m\nR1 out 0 2k\n.op',
  'V1 in 0 12\nR1 in out 2k\nR2 out 0 1k\n.op',
  'V1 a 0 10\nR1 a b 1k\nI1 b 0 1m\nR2 b 0 2k\n.op',
] as const;

const acCircuits = [
  'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 3 10 10k',
  'V1 in 0 AC 2 30\nR1 in out 100\nL1 out 0 10m\n.ac dec 4 100 1k',
  'I1 0 out AC 1m -45\nR1 out 0 1k\nC1 out 0 100n\n.ac oct 2 100 1600',
] as const;

const linCircuits = [
  { points: 1, source: 'V1 in 0 AC 1\nR1 in 0 1k\n.ac lin 1 100 1k', expectedGrid: [100] },
  { points: 4, source: 'V1 in 0 AC 1\nR1 in 0 1k\n.ac lin 4 100 1k', expectedGrid: [100, 400, 700, 1000] },
] as const;

// ngspice-47 `.ac` grids for `V1 in 0 AC 1 / R1 in out 1k / C1 out 0 1u / .ac <sweep>`, printed
// with `wrdata frequency` (count, second point, last point).
const ngspiceAcGrids = [
  ['lin 10 1 1k', 10, 112, 1000],
  ['dec 10 1 5', 7, 1.25892541, 3.98107171],
  ['dec 1 1 1k', 4, 10, 1000],
  ['oct 4 1 5', 10, 1.18920712, 4.75682846],
  ['oct 3 1 10', 10, 1.25992105, 8],
  ['dec 10 1 5k', 37, 1.26691993, 5000],
  ['dec 7 3 47k', 30, 4.1857725, 47000],
  ['dec 10 1 50', 17, 1.2769845, 50],
  ['dec 10 1 99.99', 20, 1.27426828, 99.99],
  ['dec 10 1 9.999', 11, 1.25892541, 10],
  ['oct 4 1 50', 23, 1.18920712, 45.254834],
] as const;

const transientCircuit = [
  'V1 in 0 PULSE(0 1 0 100u 100u 10m 20m)',
  'R1 in out 1k',
  'C1 out 0 1u',
  '.tran 100u 1m',
  '.end',
].join('\n');

const dcSweepCircuit = [
  'Vdrive in 0 0',
  'R1 in out 1k',
  'R2 out 0 1k',
  '.dc Vdrive -1 1 0.5',
  '.end',
].join('\n');

async function engine(backend: 'spice-ts-js' | 'spice-ts-wasm'): Promise<SpiceEngine> {
  return createSpiceEngine({ backend });
}

function request(source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 {
  return { apiVersion: '1', input: { format: 'spice', source }, ...(options ? { options } : {}) };
}

describe('bounded numeric WebAssembly backend', () => {
  it('runs one bounded passive voltage or current source DC sweep without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const voltage = await wasm.simulate(request(dcSweepCircuit), { requestId: 'dc-voltage' });
      expect(voltage.ok).toBe(true);
      if (!voltage.ok) return;
      expect(voltage.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      expect(voltage.data.analyses[0]).toMatchObject({
        type: 'dc', analysisIndex: 0,
        axis: { name: 'Vdrive', unit: 'V', values: [-1, -0.5, 0, 0.5, 1] },
        voltagesV: { in: [-1, -0.5, 0, 0.5, 1], out: [-0.5, -0.25, 0, 0.25, 0.5] },
      });

      const current = await wasm.simulate(request([
        'Isweep 0 out 0', 'R1 out 0 1k', '.dc Isweep 2m 0 -1m',
      ].join('\n')), { requestId: 'dc-current-descending' });
      expect(current.ok).toBe(true);
      if (!current.ok) return;
      expect(current.data.analyses[0]).toMatchObject({
        type: 'dc', axis: { name: 'Isweep', unit: 'A', values: [0.002, 0.001, 0] },
        voltagesV: { out: [2, 1, 0] },
      });

      const reads = [];
      for await (const read of wasm.simulateStream(request(dcSweepCircuit), {
        requestId: 'dc-stream', chunkPoints: 2,
      })) reads.push(read);
      expect(reads.map(read => read.status)).toEqual(['running', 'running', 'complete']);
      expect(reads.flatMap(read => read.events).map(event => event.type)).toEqual([
        'analysis-start', 'point', 'point', 'point', 'point', 'point', 'analysis-end',
      ]);
    } finally {
      await wasm.close();
    }
  });

  it('rejects invalid, nested, nonlinear, and over-limit DC sweeps before fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, code, details] of [
        ['zero-step', 'V1 in 0 0\nR1 in 0 1k\n.dc V1 0 1 0', 'INVALID_CIRCUIT', { feature: 'dc-grid' }],
        ['wrong-direction', 'V1 in 0 0\nR1 in 0 1k\n.dc V1 0 1 -1', 'INVALID_CIRCUIT', { feature: 'dc-grid' }],
        ['three-source', 'V1 in 0 0\nR1 in 0 1k\n.dc V1 0 1 1 V2 0 1 1 V3 0 1 1', 'UNSUPPORTED_FEATURE', { feature: 'dc-nested-sweep' }],
        ['nonlinear-source', 'V1 in 0 PULSE(0 1 0 1n 1n 1m 2m)\nR1 in 0 1k\n.dc V1 0 1 1', 'UNSUPPORTED_FEATURE', { feature: 'source-waveform' }],
        ['unsupported-mos-level', 'V1 in 0 0\nM1 in in 0 0 mos\n.model mos NMOS(LEVEL=2)\n.dc V1 0 1 1', 'UNSUPPORTED_FEATURE', { feature: 'mosfet-model-parameter' }],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `dc-${name}` });
        expect(result).toMatchObject({
          ok: false, error: { code, phase: 'validation', retryable: false, details },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }

      const limited = await wasm.simulate(request(dcSweepCircuit, {
        limits: { maxResultPoints: 4 },
      }), { requestId: 'dc-point-limit' });
      expect(limited).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', phase: 'validation', details: {
          limit: 'maxResultPoints', configured: 4, observed: 5,
        } },
      });

      const serialized = await wasm.simulate(request(dcSweepCircuit, {
        limits: { maxSerializedResultBytes: 1 },
      }), { requestId: 'dc-serialized-limit' });
      expect(serialized).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', phase: 'serialize', details: {
          limit: 'maxSerializedResultBytes', configured: 1, observed: expect.any(Number),
        } },
      });
    } finally {
      await wasm.close();
    }
  });

  it('advertises the exact bounded slice and artifact identity', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      expect(wasm.capabilities).toMatchObject({
        backends: ['spice-ts-wasm'],
        analyses: ['op', 'dc', 'tran', 'ac'],
        nativeSchemaVersions: [],
        engineBuildId: expect.stringMatching(/^spice-ts-wasm-[0-9a-f]{16}$/),
        numericWasm: {
          kernel: 'dense-gaussian-complex-f64-v2',
          abiVersion: 2,
          artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          artifactBytes: expect.any(Number),
          inputFormats: ['spice'],
          analyses: ['op', 'dc', 'tran', 'ac'],
          devicesByAnalysis: {
            op: ['R', 'I', 'V', 'G', 'F', 'E', 'H', 'D', 'Q', 'M', 'J'],
            dc: ['R', 'I', 'V', 'D', 'J'],
            tran: ['R', 'C', 'L', 'I', 'V', 'J'],
            ac: ['R', 'C', 'L', 'I', 'V', 'D', 'Q', 'M', 'J'],
          },
          fallback: 'reject',
          limits: { maxSystemOrder: 64, maxAcPoints: 1025, maxResultPoints: 4096, memoryPages: 3 },
        },
      });
    } finally {
      await wasm.close();
    }
  });

  it('loads an import-free ABI-v2 complex kernel with fixed memory', async () => {
    const bytes = await readFile(new URL('../native/dense-solver.wasm', import.meta.url));
    const module = await WebAssembly.compile(bytes);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module).map(entry => entry.name)).toEqual(expect.arrayContaining([
      'memory', '__heap_base', 'abi_version', 'max_order', 'stamp_vccs_f64', 'stamp_cccs_f64', 'stamp_vcvs_f64',
      'stamp_ccvs_f64', 'solve_f64', 'solve_dc_f64', 'solve_complex_f64',
    ]));
    await expect(validateNumericWasmModule(module)).resolves.toBeUndefined();
    const instance = await WebAssembly.instantiate(module);
    const exports = instance.exports as unknown as NumericWasmExports;
    const memory = exports.memory;
    expect(memory.buffer.byteLength).toBe(NUMERIC_WASM_LIMITS.memoryPages * 65_536);
    const matrixPointer = Number(exports.__heap_base.value);
    const matrix = new Float64Array(memory.buffer, matrixPointer, 16);
    expect(exports.stamp_vccs_f64(4, matrixPointer, 0, 1, 2, 3, 0.01)).toBe(0);
    expect(Array.from(matrix)).toEqual([
      0, 0, 0.01, -0.01,
      0, 0, -0.01, 0.01,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    matrix.fill(0);
    expect(exports.stamp_cccs_f64(4, matrixPointer, 0, 1, 3, 2)).toBe(0);
    expect(Array.from(matrix)).toEqual([
      0, 0, 0, 2,
      0, 0, 0, -2,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    matrix.fill(0);
    expect(exports.stamp_vcvs_f64(4, matrixPointer, 0, -1, 2, 3, 1, 5)).toBe(0);
    expect(Array.from(matrix)).toEqual([
      0, 1, 0, 0,
      1, 0, -5, 5,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(exports.stamp_vcvs_f64(4, matrixPointer, 0, -1, 2, 3, 4, 5)).toBe(3);
    expect(exports.stamp_vcvs_f64(4, matrixPointer, 0, -1, 2, 3, 1, Number.POSITIVE_INFINITY)).toBe(2);
    matrix.fill(0);
    expect(exports.stamp_ccvs_f64(4, matrixPointer, 0, -1, 2, 3, 5)).toBe(0);
    expect(Array.from(matrix)).toEqual([
      0, 0, 0, 1,
      0, 0, 0, 0,
      0, 0, 0, 0,
      1, 0, -5, 0,
    ]);
    expect(exports.stamp_ccvs_f64(4, matrixPointer, 0, -1, 2, 4, 5)).toBe(3);
    expect(exports.stamp_ccvs_f64(4, matrixPointer, 0, -1, 2, 3, Number.POSITIVE_INFINITY)).toBe(2);
    expect(() => memory.grow(1)).toThrow();
  });

  it('matches the TypeScript backend on a fixed linear OP circuit suite', async () => {
    const js = await engine('spice-ts-js');
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [index, source] of circuits.entries()) {
        const input = request(source);
        const [expected, actual] = await Promise.all([
          js.simulate(input, { requestId: `js-${index}` }),
          wasm.simulate(input, { requestId: `wasm-${index}` }),
        ]);
        expect(expected.ok).toBe(true);
        expect(actual.ok).toBe(true);
        if (!expected.ok || !actual.ok) continue;
        expect(actual.metadata).toMatchObject({
          backend: 'spice-ts-wasm',
          resolvedOptions: { backend: 'spice-ts-wasm' },
        });
        const expectedOp = expected.data.analyses[0];
        const actualOp = actual.data.analyses[0];
        expect(expectedOp?.type).toBe('op');
        expect(actualOp?.type).toBe('op');
        if (expectedOp?.type !== 'op' || actualOp?.type !== 'op') continue;
        expect(Object.keys(actualOp.voltagesV)).toEqual(Object.keys(expectedOp.voltagesV));
        for (const [name, value] of Object.entries(expectedOp.voltagesV)) {
          expect(actualOp.voltagesV[name]).toBeCloseTo(value, 12);
        }
        expect(Object.keys(actualOp.currentsA)).toEqual(Object.keys(expectedOp.currentsA));
        for (const [name, value] of Object.entries(expectedOp.currentsA)) {
          expect(actualOp.currentsA[name]).toBeCloseTo(value, 12);
        }
      }
    } finally {
      await Promise.all([js.close(), wasm.close()]);
    }
  });

  it('solves the bounded linear VCCS OP slice through the WASM backend', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const source = [
        'VCTRL control 0 2',
        'G1 out 0 control 0 2m',
        'R1 out 0 1k',
        '.op',
      ].join('\n');
      const result = await wasm.simulate(request(source), { requestId: 'wasm-vccs-op' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const op = result.data.analyses[0];
      expect(op?.type).toBe('op');
      if (op?.type !== 'op') return;
      expect(op.voltagesV).toMatchObject({ control: 2, out: -4 });
      expect(op.currentsA.VCTRL).toBeCloseTo(0, 15);
      expect(result.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
    } finally {
      await wasm.close();
    }
  });

  it('enforces the serialized-result ceiling for bounded VCCS OP', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 2',
        'G1 out 0 control 0 2m',
        'R1 out 0 1k',
        '.op',
      ].join('\n'), {
        limits: { maxSerializedResultBytes: 1 },
      }), { requestId: 'wasm-vccs-op-serialized-limit' });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT',
          phase: 'serialize',
          retryable: false,
          details: {
            limit: 'maxSerializedResultBytes',
            configured: 1,
            observed: expect.any(Number),
          },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('rejects VCCS forms outside the bounded linear OP slice without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, feature] of [
        ['polynomial', 'V1 control 0 1\nG1 out 0 POLY(1) control 0 1m\nR1 out 0 1k\n.op', 'vccs-form'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `wasm-vccs-reject-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'UNSUPPORTED_FEATURE',
            phase: 'validation',
            retryable: false,
            details: { backend: 'spice-ts-wasm', feature },
          },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('returns a structured singular-topology error for an unreferenced VCCS output', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 1',
        'G1 out 0 control 0 1m',
        '.op',
      ].join('\n')), { requestId: 'wasm-vccs-singular' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'SINGULAR_MATRIX', phase: 'solve', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('rejects non-finite VCCS transconductance before stamping', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 1',
        'G1 out 0 control 0 1e999',
        'R1 out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-vccs-non-finite' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INVALID_CIRCUIT', phase: 'compile', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('solves bounded VCVS OP with branch ordering and differential control polarity in WASM', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VBIAS bias 0 1',
        'VCTRL control 0 3',
        'VREF ref 0 -1',
        'E1 out ref control bias 2',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-vcvs-op' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const op = result.data.analyses[0];
      expect(op?.type).toBe('op');
      if (op?.type !== 'op') return;
      expect(op.voltagesV).toMatchObject({ bias: 1, control: 3, ref: -1, out: 3 });
      expect(op.currentsA.E1).toBeCloseTo(-0.003, 15);
      expect(result.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
    } finally {
      await wasm.close();
    }
  });

  it('preserves VCVS output and control polarity for negative gain', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VP plus 0 4',
        'VN minus 0 1',
        'E1 0 out minus plus -2',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-vcvs-polarity' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const op = result.data.analyses[0];
      expect(op?.type).toBe('op');
      if (op?.type !== 'op') return;
      expect(op.voltagesV.out).toBeCloseTo(-6, 15);
    } finally {
      await wasm.close();
    }
  });

  it('rejects VCVS forms outside bounded linear OP without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, feature] of [
        ['polynomial', 'V1 control 0 1\nE1 out 0 POLY(1) control 0 2\nR1 out 0 1k\n.op', 'vcvs-form'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `wasm-vcvs-reject-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
            details: { backend: 'spice-ts-wasm', feature },
          },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('rejects behavioral VCVS VALUE forms as unsupported without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, card] of [
        ['spaced', 'E1 out 0 VALUE = {V(in)*2}'],
        ['compact', 'E1 out 0 VALUE={V(in)*2}'],
        ['mixed-case', 'e1 out 0 VaLuE= {V(in)*2}'],
      ] as const) {
        const result = await wasm.simulate(request([
          'V1 in 0 1',
          card,
          'R1 out 0 1k',
          '.op',
        ].join('\n')), { requestId: `wasm-vcvs-reject-behavioral-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
            details: { backend: 'spice-ts-wasm', feature: 'vcvs-form' },
          },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('returns structured VCVS singular, finite-gain, and resource errors', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const singular = await wasm.simulate(request([
        'VCTRL control 0 1',
        'E1 out floating control 0 2',
        '.op',
      ].join('\n')), { requestId: 'wasm-vcvs-singular' });
      expect(singular).toMatchObject({
        ok: false,
        error: { code: 'SINGULAR_MATRIX', phase: 'solve', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });

      const nonFinite = await wasm.simulate(request([
        'VCTRL control 0 1',
        'E1 out 0 control 0 1e999',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-vcvs-non-finite' });
      expect(nonFinite).toMatchObject({
        ok: false,
        error: { code: 'INVALID_CIRCUIT', phase: 'compile', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });

      const serialized = await wasm.simulate(request([
        'VCTRL control 0 1',
        'E1 out 0 control 0 2',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n'), { limits: { maxSerializedResultBytes: 1 } }), { requestId: 'wasm-vcvs-serialized-limit' });
      expect(serialized).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT', phase: 'serialize', retryable: false,
          details: { limit: 'maxSerializedResultBytes', configured: 1, observed: expect.any(Number) },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });

      const oversized = [
        ...Array.from({ length: 31 }, (_, index) => `V${index + 1} n${index + 1} 0 ${index + 1}`),
        'E1 eplus eminus n1 0 1',
        '.op',
      ].join('\n');
      const bounded = await wasm.simulate(request(oversized), { requestId: 'wasm-vcvs-order-limit' });
      expect(bounded).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT', phase: 'validation', retryable: false,
          details: { limit: 'maxSystemOrder', configured: 64, observed: 65 },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('solves bounded CCVS OP with control-branch polarity and deterministic result ordering', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 2',
        'RCTRL control 0 1k',
        'VREF ref 0 1',
        'H1 out ref VCTRL -2k',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-ccvs-op' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const op = result.data.analyses[0];
      expect(op?.type).toBe('op');
      if (op?.type !== 'op') return;
      expect(Object.keys(op.voltagesV)).toEqual(['control', 'out', 'ref']);
      expect(op.voltagesV).toMatchObject({ control: 2, ref: 1, out: 5 });
      expect(Object.keys(op.currentsA)).toEqual(['VCTRL', 'VREF', 'H1']);
      expect(op.currentsA.VCTRL).toBeCloseTo(-0.002, 15);
      expect(op.currentsA.H1).toBeCloseTo(-0.005, 15);
      expect(result.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
    } finally {
      await wasm.close();
    }
  });

  it('resolves a mixed-case CCVS controlling voltage source like SPICE', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 1',
        'RCTRL control 0 1k',
        'H1 out 0 vctrl 2k',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-ccvs-mixed-case-control' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const op = result.data.analyses[0];
      expect(op?.type).toBe('op');
      if (op?.type !== 'op') return;
      expect(op.voltagesV.out).toBeCloseTo(-2, 15);
      expect(op.currentsA.VCTRL).toBeCloseTo(-0.001, 15);
      expect(op.currentsA.H1).toBeCloseTo(0.002, 15);
    } finally {
      await wasm.close();
    }
  });

  it('rejects CCVS forms outside bounded linear OP without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, feature] of [
        ['polynomial', 'V1 control 0 1\nH1 out 0 POLY(1) V1 2k\nR1 out 0 1k\n.op', 'ccvs-form'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `wasm-ccvs-reject-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
            details: { backend: 'spice-ts-wasm', feature },
          },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('rejects unresolved CCVS controlling sources with deterministic validation errors', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, controlSource, reason] of [
        ['missing', 'H1 out 0 VNOPE 2k\nRLOAD out 0 1k\n.op', 'VNOPE', 'missing'],
        ['branchless', 'RCTRL control 0 1k\nH1 out 0 RCTRL 2k\nRLOAD out 0 1k\n.op', 'RCTRL', 'branchless'],
        ['forward', 'H1 out 0 VCTRL 2k\nVCTRL control 0 1\nRLOAD out 0 1k\n.op', 'VCTRL', 'forward-reference'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `wasm-ccvs-control-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'INVALID_CIRCUIT', phase: 'validation', retryable: false,
            details: {
              backend: 'spice-ts-wasm', feature: 'ccvs-control-source',
              device: 'H1', controlSource, reason,
            },
          },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('returns structured CCVS singular, finite-gain, and resource errors', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const singular = await wasm.simulate(request([
        'VCTRL control 0 1',
        'H1 out floating VCTRL 2k',
        '.op',
      ].join('\n')), { requestId: 'wasm-ccvs-singular' });
      expect(singular).toMatchObject({
        ok: false,
        error: { code: 'SINGULAR_MATRIX', phase: 'solve', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });

      const nonFinite = await wasm.simulate(request([
        'VCTRL control 0 1',
        'H1 out 0 VCTRL 1e999',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-ccvs-non-finite' });
      expect(nonFinite).toMatchObject({
        ok: false,
        error: { code: 'INVALID_CIRCUIT', phase: 'compile', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });

      const serialized = await wasm.simulate(request([
        'VCTRL control 0 1',
        'H1 out 0 VCTRL 2k',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n'), { limits: { maxSerializedResultBytes: 1 } }), { requestId: 'wasm-ccvs-serialized-limit' });
      expect(serialized).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT', phase: 'serialize', retryable: false,
          details: { limit: 'maxSerializedResultBytes', configured: 1, observed: expect.any(Number) },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });

      const oversized = [
        ...Array.from({ length: 31 }, (_, index) => `V${index + 1} n${index + 1} 0 ${index + 1}`),
        'H1 hplus hminus V1 1k',
        '.op',
      ].join('\n');
      const bounded = await wasm.simulate(request(oversized), { requestId: 'wasm-ccvs-order-limit' });
      expect(bounded).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT', phase: 'validation', retryable: false,
          details: { limit: 'maxSystemOrder', configured: 64, observed: 65 },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('solves the bounded linear CCCS OP slice through the WASM backend', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 2',
        'RCTRL control 0 1k',
        'F1 out 0 VCTRL 3',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-cccs-op' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const op = result.data.analyses[0];
      expect(op?.type).toBe('op');
      if (op?.type !== 'op') return;
      expect(op.voltagesV).toMatchObject({ control: 2, out: 6 });
      expect(op.currentsA.VCTRL).toBeCloseTo(-0.002, 15);
      expect(result.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
    } finally {
      await wasm.close();
    }
  });

  it('resolves a mixed-case CCCS controlling voltage source like SPICE', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 2',
        'RCTRL control 0 1k',
        'F1 out 0 vctrl 3',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-cccs-mixed-case-control' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const op = result.data.analyses[0];
      expect(op?.type).toBe('op');
      if (op?.type !== 'op') return;
      expect(op.voltagesV).toMatchObject({ control: 2, out: 6 });
      expect(op.currentsA.VCTRL).toBeCloseTo(-0.002, 15);
      expect(result.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
    } finally {
      await wasm.close();
    }
  });

  it('enforces the serialized-result ceiling for bounded CCCS OP', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 2',
        'RCTRL control 0 1k',
        'F1 out 0 VCTRL 3',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n'), {
        limits: { maxSerializedResultBytes: 1 },
      }), { requestId: 'wasm-cccs-op-serialized-limit' });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT',
          phase: 'serialize',
          retryable: false,
          details: {
            limit: 'maxSerializedResultBytes',
            configured: 1,
            observed: expect.any(Number),
          },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('rejects CCCS forms outside the bounded linear OP slice without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, feature] of [
        ['polynomial', 'V1 control 0 1\nF1 out 0 POLY(1) V1 2\nR1 out 0 1k\n.op', 'cccs-form'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `wasm-cccs-reject-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'UNSUPPORTED_FEATURE',
            phase: 'validation',
            retryable: false,
            details: { backend: 'spice-ts-wasm', feature },
          },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('rejects unresolved CCCS controlling sources with structured validation errors', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, controlSource, reason] of [
        ['missing', 'F1 out 0 VNOPE 2\nRLOAD out 0 1k\n.op', 'VNOPE', 'missing'],
        ['branchless', 'RCTRL control 0 1k\nF1 out 0 RCTRL 2\nRLOAD out 0 1k\n.op', 'RCTRL', 'branchless'],
        ['forward', 'F1 out 0 VCTRL 2\nVCTRL control 0 1\nRLOAD out 0 1k\n.op', 'VCTRL', 'forward-reference'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `wasm-cccs-control-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'INVALID_CIRCUIT',
            phase: 'validation',
            retryable: false,
            details: {
              backend: 'spice-ts-wasm',
              feature: 'cccs-control-source',
              device: 'F1',
              controlSource,
              reason,
            },
          },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('rejects non-finite CCCS gain before stamping', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'VCTRL control 0 1',
        'RCTRL control 0 1k',
        'F1 out 0 VCTRL 1e999',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-cccs-non-finite' });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INVALID_CIRCUIT', phase: 'compile', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('matches the TypeScript backend on fixed passive AC circuits through the complex WASM path', async () => {
    const js = await engine('spice-ts-js');
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [circuitIndex, source] of acCircuits.entries()) {
        const [expected, actual] = await Promise.all([
          js.simulate(request(source), { requestId: `js-ac-${circuitIndex}` }),
          wasm.simulate(request(source), { requestId: `wasm-ac-${circuitIndex}` }),
        ]);
        expect(expected.ok).toBe(true);
        expect(actual.ok).toBe(true);
        if (!expected.ok || !actual.ok) continue;
        const expectedAc = expected.data.analyses[0];
        const actualAc = actual.data.analyses[0];
        expect(expectedAc?.type).toBe('ac');
        expect(actualAc?.type).toBe('ac');
        if (expectedAc?.type !== 'ac' || actualAc?.type !== 'ac') continue;
        expect(actualAc.frequencyHz).toEqual(expectedAc.frequencyHz);
        expect(Object.keys(actualAc.voltagePhasors)).toEqual(Object.keys(expectedAc.voltagePhasors));
        expect(Object.keys(actualAc.currentPhasors)).toEqual(Object.keys(expectedAc.currentPhasors));
        for (const [name, expectedValues] of Object.entries(expectedAc.voltagePhasors) as
          Array<[string, typeof expectedAc.voltagePhasors[string]]>) {
          const actualValues = actualAc.voltagePhasors[name]!;
          expect(actualValues).toHaveLength(expectedValues.length);
          expectedValues.forEach((value, pointIndex) => {
            expect(actualValues[pointIndex]?.magnitude).toBeCloseTo(value.magnitude, 11);
            expect(actualValues[pointIndex]?.phaseDegrees).toBeCloseTo(value.phaseDegrees, 10);
          });
        }
        for (const [name, expectedValues] of Object.entries(expectedAc.currentPhasors) as
          Array<[string, typeof expectedAc.currentPhasors[string]]>) {
          const actualValues = actualAc.currentPhasors[name]!;
          expect(actualValues).toHaveLength(expectedValues.length);
          expectedValues.forEach((value, pointIndex) => {
            expect(actualValues[pointIndex]?.magnitude).toBeCloseTo(value.magnitude, 11);
            expect(actualValues[pointIndex]?.phaseDegrees).toBeCloseTo(value.phaseDegrees, 10);
          });
        }
      }
    } finally {
      await Promise.all([js.close(), wasm.close()]);
    }
  });

  it('uses ngspice total-point semantics for LIN N=1 and N=4', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const { points, source, expectedGrid } of linCircuits) {
        const result = await wasm.simulate(request(source), { requestId: `wasm-ac-lin-${points}` });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const analysis = result.data.analyses[0];
        expect(analysis?.type).toBe('ac');
        if (analysis?.type !== 'ac') continue;
        expect(analysis.frequencyHz).toEqual(expectedGrid);
      }
    } finally {
      await wasm.close();
    }
  });

  it('matches ngspice-47 .ac point counts and grids for DEC, OCT and LIN sweeps', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [sweep, count, second, last] of ngspiceAcGrids) {
        const source = `V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac ${sweep}`;
        const result = await wasm.simulate(request(source), { requestId: `wasm-ac-grid-${sweep}` });
        expect(result.ok, sweep).toBe(true);
        if (!result.ok) continue;
        const analysis = result.data.analyses[0];
        if (analysis?.type !== 'ac') throw new Error(`expected AC result for ${sweep}`);
        const grid = analysis.frequencyHz;
        expect(grid, sweep).toHaveLength(count);
        expect(grid[1]! / second, sweep).toBeCloseTo(1, 7);
        expect(grid.at(-1)! / last, sweep).toBeCloseTo(1, 7);
      }
    } finally {
      await wasm.close();
    }
  });

  it('rejects oversized .ac sweeps with RESOURCE_LIMIT instead of an internal error', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [sweep, observed] of [['lin 5000000000 1 10', 5_000_000_000], ['lin 30000000 1 10', 30_000_000]] as const) {
        const result = await wasm.simulate(
          request(`V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac ${sweep}`),
          { requestId: `wasm-ac-limit-${sweep}` },
        );
        expect(result, sweep).toMatchObject({
          ok: false,
          error: {
            code: 'RESOURCE_LIMIT',
            phase: 'validation',
            details: { limit: 'maxResultPoints', configured: NUMERIC_WASM_LIMITS.maxAcPoints, observed },
          },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('runs bounded passive RC transient analysis with canonical stream ordering and reset', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const first = await wasm.simulate(request(transientCircuit), { requestId: 'tran-result' });
      const second = await wasm.simulate(request(transientCircuit), { requestId: 'tran-reuse' });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data).toEqual(first.data);
      const transient = first.data.analyses[0];
      expect(transient?.type).toBe('tran');
      if (transient?.type !== 'tran') return;
      expect(transient.timeS).toHaveLength(11);
      expect(transient.timeS[0]).toBe(0);
      expect(transient.timeS.at(-1)).toBeCloseTo(1e-3, 15);
      expect(transient.voltagesV.out[0]).toBe(0);
      expect(transient.voltagesV.out.at(-1)).toBeGreaterThan(0.5);

      const currentDriven = await wasm.simulate(request([
        'I1 0 out PULSE(0 1m 0 100u 100u 10m 20m)',
        'R1 out 0 1k',
        'C1 out 0 1u',
        '.tran 100u 1m',
      ].join('\n')), { requestId: 'tran-current-source' });
      expect(currentDriven.ok).toBe(true);

      const reads = [];
      for await (const read of wasm.simulateStream(request(transientCircuit), {
        requestId: 'tran-stream', chunkPoints: 4,
      })) reads.push(read);
      expect(reads.map(read => read.status)).toEqual(['running', 'running', 'complete']);
      const events = reads.flatMap(read => read.events);
      expect(events.map(event => event.type)).toEqual([
        'analysis-start', ...Array.from({ length: 11 }, () => 'point'), 'analysis-end',
      ]);
    } finally {
      await wasm.close();
    }
  });

  it('ramps a zero PULSE TR/TF over TSTEP like ngspice (issue #375)', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'V1 in 0 PULSE(0 1 0 0 0 150u 1)',
        'R1 in 0 1k',
        '.tran 100u 300u',
      ].join('\n')), { requestId: 'tran-zero-edge-pulse' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const transient = result.data.analyses[0];
      if (transient?.type !== 'tran') throw new Error('expected a transient analysis');
      // TR = TF = TSTEP = 100u: rise [0, 100u], high until 250u, fall
      // [250u, 350u]. ngspice-47 (linearized) prints 0, 1, 1, 0.5.
      expect(transient.voltagesV.in[0]).toBe(0);
      expect(transient.voltagesV.in[1]).toBe(1);
      expect(transient.voltagesV.in[2]).toBe(1);
      expect(transient.voltagesV.in[3]).toBeCloseTo(0.5, 9);
    } finally {
      await wasm.close();
    }
  });

  it('schedules an exact 1 us grid through 1 ms without a duplicate terminal point', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'V1 in 0 1',
        'R1 in out 1k',
        'C1 out 0 1u',
        '.tran 1u 1m',
      ].join('\n')), { requestId: 'tran-exact-grid' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const transient = result.data.analyses[0];
      expect(transient?.type).toBe('tran');
      if (transient?.type !== 'tran') return;
      expect(transient.timeS).toHaveLength(1_001);
      expect(transient.timeS.at(-1)).toBe(1e-3);
      expect(transient.timeS.at(-2)).toBeCloseTo(999e-6, 15);
    } finally {
      await wasm.close();
    }
  });

  it('runs a bounded series RL step through WASM with the analytic inductor current', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'V1 in 0 PULSE(0 1 0 1u 1u 1 2)',
        'R1 in out 1k',
        'L1 out 0 100m',
        '.tran 1u 500u',
      ].join('\n')), { requestId: 'tran-rl-step' });
      expect(result).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!result.ok) return;
      const transient = result.data.analyses[0];
      expect(transient?.type).toBe('tran');
      if (transient?.type !== 'tran') return;
      expect(transient.timeS).toHaveLength(501);
      expect(Object.keys(transient.currentsA).sort()).toEqual(['L1', 'V1']);
      const resistance = 1e3;
      const tau = 100e-3 / resistance;
      const rise = 1e-6;
      const atRiseEnd = (rise - tau * (1 - Math.exp(-rise / tau))) / (rise * resistance);
      const analytic = (time: number) => time <= rise
        ? (time - tau * (1 - Math.exp(-time / tau))) / (rise * resistance)
        : atRiseEnd * Math.exp(-(time - rise) / tau) + (1 - Math.exp(-(time - rise) / tau)) / resistance;
      const errors = transient.timeS.map((time, index) => Math.abs(transient.currentsA.L1![index]! - analytic(time)));
      expect(transient.currentsA.L1![0]).toBe(0);
      expect(Math.max(...errors)).toBeLessThan(1e-7);
      expect(transient.currentsA.L1!.at(-1)).toBeGreaterThan(0.99e-3);

      const dcShort = await wasm.simulate(request('V1 in 0 1\nR1 in out 1k\nL1 out 0 1m\n.tran 1u 10u'), {
        requestId: 'tran-rl-dc-short',
      });
      expect(dcShort.ok).toBe(true);
      if (!dcShort.ok || dcShort.data.analyses[0]?.type !== 'tran') return;
      for (const current of dcShort.data.analyses[0].currentsA.L1!) expect(current).toBeCloseTo(1e-3, 15);
      for (const voltage of dcShort.data.analyses[0].voltagesV.out!) expect(Math.abs(voltage)).toBeLessThan(1e-15);
    } finally {
      await wasm.close();
    }
  });

  it('matches the TypeScript engine on series and parallel RLC transients without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    const js = await engine('spice-ts-js');
    try {
      for (const [name, source, vector, tolerance] of [
        ['series', 'V1 in 0 PULSE(0 1 0 1u 1u 10m 20m)\nR1 in a 10\nL1 a out 1m\nC1 out 0 1u\n.tran 1u 400u', 'out', 5e-4],
        ['parallel', 'I1 0 out PULSE(0 1m 0 1u 1u 10m 20m)\nR1 out 0 1k\nL1 out 0 1m\nC1 out 0 1u\n.tran 1u 400u', 'out', 2e-5],
      ] as const) {
        const actual = await wasm.simulate(request(source), { requestId: `rlc-${name}-wasm` });
        const reference = await js.simulate(request(source), { requestId: `rlc-${name}-js` });
        expect(actual).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
        expect(reference.ok).toBe(true);
        if (!actual.ok || !reference.ok) return;
        const wasmTran = actual.data.analyses[0];
        const jsTran = reference.data.analyses[0];
        if (wasmTran?.type !== 'tran' || jsTran?.type !== 'tran') throw new Error('missing transient analysis');
        expect(wasmTran.timeS).toHaveLength(401);
        let maximum = 0;
        wasmTran.timeS.forEach((time, index) => {
          const upper = jsTran.timeS.findIndex(candidate => candidate >= time);
          const t1 = jsTran.timeS[upper]!;
          const lower = t1 === time ? upper : upper - 1;
          const t0 = jsTran.timeS[lower]!;
          const v0 = jsTran.voltagesV[vector]![lower]!;
          const v1 = jsTran.voltagesV[vector]![upper]!;
          const expected = t1 === t0 ? v1 : v0 + (time - t0) / (t1 - t0) * (v1 - v0);
          maximum = Math.max(maximum, Math.abs(wasmTran.voltagesV[vector]![index]! - expected));
        });
        expect(maximum, name).toBeLessThan(tolerance);
      }
    } finally {
      await wasm.close();
      await js.close();
    }
  });

  it.each([
    ['RC', 'V1 in 0 0\nR1 in out 1k\nC1 out 0 1u IC=1\n.tran 1u 100u uic'],
    ['RL', 'V1 in 0 0\nR1 in out 1k\nL1 out 0 1 IC=1m\n.tran 1u 100u uic'],
    ['RL spaced IC without UIC', 'V1 in 0 1\nR1 in out 1k\nL1 out 0 1 ic = 1m\n.tran 1u 100u'],
    ['RC spaced negative IC', 'V1 in 0 2\nR1 in out 1k\nC1 out 0 1u ic = -1\n.tran 1u 100u UIC'],
    ['RC IC ignored without UIC', 'V1 in 0 2\nR1 in out 1k\nC1 out 0 1u IC=-1\n.tran 1u 100u'],
    ['RC zero seed', 'V1 in 0 2\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 100u uic'],
    ['RLC combined IC', 'V1 in 0 2\nR1 in a 10\nL1 a out 1m IC=-1m\nC1 out 0 1u IC=1\n.tran 1u 100u uic'],
    ['floating capacitor IC', 'V1 in 0 2\nR1 in a 1k\nR2 b 0 2k\nC1 a b 1u IC=1\n.tran 1u 100u uic'],
  ])('matches every core transient sample for %s initial conditions', async (name, source) => {
    const wasm = await engine('spice-ts-wasm');
    const js = await engine('spice-ts-js');
    try {
      const actual = await wasm.simulate(request(source), { requestId: `${name}-uic-wasm` });
      const reference = await js.simulate(request(source), { requestId: `${name}-uic-js` });
      expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      expect(reference.ok).toBe(true);
      if (!actual.ok || !reference.ok) throw new Error('missing UIC results');
      const result = actual.data.analyses[0];
      const expected = reference.data.analyses[0];
      if (result?.type !== 'tran' || expected?.type !== 'tran') throw new Error('missing transient analysis');
      expect(result.timeS).toEqual(expected.timeS);
      if (/\buic\b/i.test(source)) expect(result.timeS[0]).toBeGreaterThan(0);
      for (const group of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(result[group]).sort()).toEqual(Object.keys(expected[group]).sort());
        for (const [signal, values] of Object.entries(expected[group])) {
          expect(result[group][signal]).toHaveLength(values.length);
          const maximum = Math.max(...values.map((value, index) =>
            Math.abs(result[group][signal]![index]! - value) / Math.max(Math.abs(value), 1e-12)));
          expect(maximum, `${name} ${group} ${signal}`).toBeLessThanOrEqual(1e-6);
        }
      }
    } finally {
      await wasm.close();
      await js.close();
    }
  });

  it('rejects unsupported inductor forms with deterministic structured errors', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source, feature, message] of [

        ['model', 'V1 in 0 1\nR1 in a 1\nL1 a 0 lmod 1m\n.tran 1u 10u',
          'inductor-form', 'Inductors must use name positive negative constant-inductance'],
        ['instance-parameter', 'V1 in 0 1\nR1 in a 1\nL1 a 0 1m m=2\n.tran 1u 10u',
          'passive-form', 'C/L devices require a value, optional model, and numeric TC1/TC2/IC only'],
        ['expression', 'V1 in 0 1\nR1 in a 1\nL1 a 0 {1m*2}\n.tran 1u 10u',
          'inductor-form', 'Inductors must use name positive negative constant-inductance'],
        ['nonlinear-expression', "V1 in 0 1\nR1 in a 1\nL1 a 0 L='1m*(1+i(V1))'\n.tran 1u 10u",
          'inductor-form', 'Inductors must use name positive negative constant-inductance'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: `inductor-${name}` });
        expect(result, name).toMatchObject({ ok: false, metadata: { backend: 'spice-ts-wasm' } });
        if (result.ok) continue;
        expect(result.error, name).toEqual({
          code: 'UNSUPPORTED_FEATURE', message, retryable: false, phase: 'validation',
          details: { backend: 'spice-ts-wasm', feature },
        });
      }

      const nonpositive = await wasm.simulate(request('V1 in 0 1\nR1 in a 1\nL1 a 0 0\n.tran 1u 10u'), {
        requestId: 'inductor-zero',
      });
      expect(nonpositive).toMatchObject({
        ok: false,
        error: { code: 'INVALID_CIRCUIT', phase: 'compile', message: "Passive device 'L1' must have a positive finite value" },
      });

      const loop = await wasm.simulate(request('V1 in 0 1\nL1 in 0 1m\n.tran 1u 10u'), { requestId: 'inductor-loop' });
      expect(loop).toMatchObject({ ok: false, error: { code: 'SINGULAR_MATRIX', phase: 'solve' } });

      const ladder = ['V1 n0 0 1', ...Array.from({ length: 32 }, (_, index) => `L${index + 1} n${index} n${index + 1} 1m`),
        'R1 n32 0 1', '.tran 1u 10u'].join('\n');
      const bounded = await wasm.simulate(request(ladder), { requestId: 'inductor-order-limit' });
      expect(bounded).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder', configured: 64, observed: 66 } },
      });
    } finally {
      await wasm.close();
    }
  });

  it('enforces the serialized-result byte limit for transient results', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request(transientCircuit, {
        limits: { maxSerializedResultBytes: 1 },
      }), { requestId: 'tran-serialized-limit' });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT',
          phase: 'serialize',
          retryable: false,
          details: {
            limit: 'maxSerializedResultBytes',
            configured: 1,
            observed: expect.any(Number),
          },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('rejects compound clauses after a transient PULSE source', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request([
        'V1 in 0 PULSE(0 1 0 100u 100u 10m 20m) AC 2',
        'R1 in out 1k',
        'C1 out 0 1u',
        '.tran 100u 1m',
      ].join('\n')), { requestId: 'tran-compound-pulse' });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'UNSUPPORTED_FEATURE',
          phase: 'validation',
          details: { backend: 'spice-ts-wasm', feature: 'source-waveform' },
        },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it.each([
    { name: 'RC TSTART', devices: 'R1 in out 1k\nC1 out 0 1u', tran: '.tran 1u 1m 0.2m', start: 0.0002, cap: 1e-6 },
    { name: 'RC diode TMAX', devices: 'R1 in out 1k\nC1 out 0 1u\nD1 out 0 junction\n.model junction D(IS=1e-14 N=1)', tran: '.tran 1u 1m 0 2u', start: 0, cap: 2e-6 },
    { name: 'RC option below TSTEP', devices: 'R1 in out 1k\nC1 out 0 1u', tran: '.tran 10u 100u', start: 0, cap: 2e-6, options: { maxTimestep: 2e-6 } },
    { name: 'RC UIC TSTART TMAX', devices: 'R1 in out 1k\nC1 out 0 1u IC=0.5', tran: '.tran 10u 100u 20u 2u UIC', start: 20e-6, cap: 2e-6 },
    { name: 'coupled inductors TMAX', devices: 'R1 in a 100\nL1 a 0 10m\nL2 out 0 10m\nR2 out 0 100\nK1 L1 L2 0.5', tran: '.tran 10u 100u 20u 2u', start: 20e-6, cap: 2e-6 },
    { name: 'RLC TMAX below TSTEP', devices: 'R1 in a 100\nL1 a out 10m\nC1 out 0 1u', tran: '.tran 10u 100u 0 2u', start: 0, cap: 2e-6 },
    { name: 'TMAX overrides option', devices: 'R1 in out 1k\nC1 out 0 1u', tran: '.tran 10u 100u 0 2u', start: 0, cap: 2e-6, options: { maxTimestep: 5e-7 } },
    { name: 'controlled sources', devices: 'R1 in 0 1k\nG1 g 0 in 0 1m\nR2 g 0 1k\nE1 e 0 in 0 2\nR3 e 0 1k\nF1 f 0 V1 2\nR4 f 0 1k\nH1 h 0 V1 1k\nR5 h 0 1k\nC1 g 0 1n', tran: '.tran 10u 100u 20u 2u', start: 20e-6, cap: 2e-6 },
    { name: 'BJT', devices: 'R1 in c 1k\nVb b 0 0.6\nQ1 c b 0 bipolar\n.model bipolar NPN(IS=1e-15 BF=100)', tran: '.tran 10u 100u 20u 2u', start: 20e-6, cap: 2e-6 },
    { name: 'MOS', devices: 'R1 in d 1k\nVg g 0 2\nM1 d g 0 0 mos W=10u L=1u\n.model mos NMOS(LEVEL=1 VTO=1 KP=100u)', tran: '.tran 10u 100u 20u 2u', start: 20e-6, cap: 2e-6 },
    { name: 'current SIN', devices: 'I1 0 out SIN(0 1m 1k)\nR1 out 0 1k\nC1 out 0 1n', tran: '.tran 10u 100u 0 2u', start: 0, cap: 2e-6 },
    { name: 'PWL', devices: 'R1 in out 1k\nC1 out 0 1u', tran: '.tran 10u 100u 0 2u', start: 0, cap: 2e-6, drive: 'V1 in 0 PWL(0 0 20u 1 100u 0)' },
  ])('supports transient controls with all-signal JS parity: $name', async fixture => {
    const wasm = await engine('spice-ts-wasm');
    const js = await engine('spice-ts-js');
    try {
      const input = request([fixture.drive ?? 'V1 in 0 PULSE(0 1 0 10u 10u 2m 4m)', fixture.devices, fixture.tran].join('\n'), fixture.options);
      const actual = await wasm.simulate(input, { requestId: 'controls-wasm' });
      expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
      if (!actual.ok) return;
      const reference = await js.simulate(input, { requestId: 'controls-js' });
      expect(reference.ok).toBe(true);
      if (!reference.ok) return;
      const a = actual.data.analyses[0];
      const b = reference.data.analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected transient');
      expect(a.timeS.length).toBeGreaterThan(1);
      expect(a.timeS).toHaveLength(b.timeS.length);
      a.timeS.forEach((time, i) => expect(Math.abs(time - b.timeS[i]!)).toBeLessThanOrEqual(1e-12));
      expect(a.timeS.every(time => time >= fixture.start)).toBe(true);
      expect(a.timeS.at(-1)).toBeCloseTo(fixture.tran.includes('1m') ? 0.001 : 0.0001, 14);
      a.timeS.forEach((time, i) => {
        if (i) expect(time - a.timeS[i - 1]!).toBeLessThanOrEqual(fixture.cap * (1 + 1e-10));
      });
      if (fixture.name === 'TMAX overrides option') {
        expect(a.timeS.some((time, i) => i > 0 && time - a.timeS[i - 1]! > 5e-7)).toBe(true);
      }
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [name, values] of Object.entries(a[field])) {
          expect(values).toHaveLength(a.timeS.length);
          values.forEach((value, i) => {
            const expected = b[field][name]![i]!;
            expect(Number.isFinite(value)).toBe(true);
            expect(Math.abs(value - expected), `${field}.${name}[${i}]`).toBeLessThanOrEqual(Math.max(1e-12, Math.abs(expected) * 1e-6));
          });
        }
      }
    } finally { await wasm.close(); await js.close(); }
  });

  it.each([
    '.tran 1u 1m 1m', '.tran 1u 1m 2m', '.tran 1u 1m -1u',
    '.tran 1u 1m 0 0', '.tran 1u 1m 0 -1u',
    '.tran 1u 1m 1e999', '.tran 1u 1m 0 1e999',
    '.tran 1e999 1m', '.tran 1u 1e999',
  ])('rejects invalid transient numeric controls: %s', async tran => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const input = request(`V1 in 0 1\nR1 in 0 1k\n${tran}`);
      expect(await wasm.validate(input, { requestId: 'invalid-control-validation' })).toMatchObject({
        ok: false, error: { code: 'INVALID_CIRCUIT' },
      });
      expect(await wasm.simulate(input, { requestId: 'invalid-control-simulation' })).toMatchObject({
        ok: false, error: { code: 'INVALID_CIRCUIT' },
      });
    } finally { await wasm.close(); }
  });

  it.each([0, -1, Infinity, NaN])('rejects invalid maxTimestep option: %s', async maxTimestep => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const result = await wasm.simulate(request(transientCircuit, { maxTimestep }), { requestId: 'invalid-option' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['INVALID_CIRCUIT', 'INVALID_REQUEST']).toContain(result.error.code);
    } finally { await wasm.close(); }
  });

  it('returns exact diagnostics for unsupported transient controls', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [source, feature, message] of [
        ['V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m 0 2u extra', 'tran-max-timestep', 'Transient maximum timestep is not supported'],
        ['V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m extra', 'tran-start-time', 'Transient start time is not supported'],
        ['V1 in 0 1\nR1 in 0 1k\n.tran 1u 1m extra uic', 'tran-start-time', 'Transient start time is not supported'],
      ] as const) {
        const result = await wasm.simulate(request(source), { requestId: feature });
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'UNSUPPORTED_FEATURE', message, details: { backend: 'spice-ts-wasm', feature } },
        });
      }
      const option = await wasm.simulate(request(transientCircuit, { integrationMethod: 'euler' }), {
        requestId: 'integration-method',
      });
      expect(option).toMatchObject({
        ok: false,
        error: {
          code: 'UNSUPPORTED_FEATURE', message: 'Only trapezoidal transient integration is supported',
          details: { backend: 'spice-ts-wasm', feature: 'integration-method' },
        },
      });
    } finally {
      await wasm.close();
    }
  });

  it('bounds AC result points and rejects non-LEVEL=1 MOS AC without fallback', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const limited = await wasm.simulate(request(linCircuits[1].source, {
        limits: { maxResultPoints: 2 },
      }), { requestId: 'ac-point-limit' });
      expect(limited).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT',
          details: { limit: 'maxResultPoints', configured: 2, observed: 4 },
        },
      });

      const nonlinear = await wasm.simulate(request(
        'V1 in 0 AC 1\nR1 in out 1k\nM1 out in 0 0 mos\n.model mos NMOS(LEVEL=2)\n.ac dec 3 10 10k',
      ), { requestId: 'ac-nonlinear' });
      expect(nonlinear).toMatchObject({
        ok: false,
        error: { code: 'UNSUPPORTED_FEATURE', retryable: false },
        metadata: { backend: 'spice-ts-wasm' },
      });
    } finally {
      await wasm.close();
    }
  });

  it('rejects unsupported analyses and devices without falling back', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      for (const [name, source] of Object.entries({
        capacitor: 'V1 in 0 1\nC1 in 0 1u\n.op',
        waveform: 'V1 in 0 PULSE(0 1 0 1n 1n 1m 2m)\nR1 in 0 1k\n.op',
        unsupportedDiodeParameterTransient: 'V1 in 0 1\nD1 in 0 D\n.model D D(CJSW=1p)\n.tran 1u 1m',
      })) {
        const result = await wasm.simulate(request(source), { requestId: `unsupported-${name}` });
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'UNSUPPORTED_FEATURE', retryable: false },
          metadata: { backend: 'spice-ts-wasm' },
        });
      }
    } finally {
      await wasm.close();
    }
  });

  it('enforces caller and backend resource ceilings before allocation', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const limited = await wasm.simulate(request(circuits[0], {
        limits: { maxComponents: 1 },
      }), { requestId: 'component-limit' });
      expect(limited).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxComponents', configured: 1, observed: 2 } },
      });

      const vccsLimited = await wasm.simulate(request([
        'VCTRL control 0 1',
        'G1 out 0 control 0 1m',
        'R1 out 0 1k',
        '.op',
      ].join('\n'), { limits: { maxComponents: 2 } }), { requestId: 'vccs-component-limit' });
      expect(vccsLimited).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxComponents', configured: 2, observed: 3 } },
      });

      const cccsLimited = await wasm.simulate(request([
        'VCTRL control 0 1',
        'RCTRL control 0 1k',
        'F1 out 0 VCTRL 2',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n'), { limits: { maxComponents: 3 } }), { requestId: 'cccs-component-limit' });
      expect(cccsLimited).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxComponents', configured: 3, observed: 4 } },
      });

      const oversized = Array.from({ length: 65 }, (_, index) => `V${index + 1} n${index + 1} 0 ${index + 1}`).join('\n') + '\n.op';
      const bounded = await wasm.simulate(request(oversized), { requestId: 'order-limit' });
      expect(bounded).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSystemOrder', configured: 64 } },
      });

      const tooManyPoints = await wasm.simulate(request(transientCircuit, {
        limits: { maxResultPoints: 10 },
      }), { requestId: 'tran-point-limit' });
      expect(tooManyPoints).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints', configured: 10, observed: 11 } },
      });
    } finally {
      await wasm.close();
    }
  });

  it('rejects a correctly hashed but invalid numeric artifact before worker construction', async () => {
    const workerUrl = new URL('../dist/worker.js', import.meta.url);
    const workerBytes = new Uint8Array(await readFile(workerUrl));
    const invalid = Uint8Array.from([0, 97, 115, 109, 1, 0, 0]);
    const manifest: SpiceWorkerManifestV1 = {
      schemaVersion: 1,
      engineBuildId: `spice-ts-js-${sha256(workerBytes).slice(0, 16)}`,
      worker: { url: workerUrl.href, sha256: sha256(workerBytes) },
      numericWasm: {
        url: `data:application/wasm;base64,${Buffer.from(invalid).toString('base64')}`,
        sha256: sha256(invalid),
        byteLength: invalid.byteLength,
        engineBuildId: `spice-ts-wasm-${sha256(invalid).slice(0, 16)}`,
      },
    };
    let constructions = 0;
    await expect(createSpiceEngine({
      backend: 'spice-ts-wasm',
      manifest,
      workerFactory: () => { constructions++; throw new Error('must not construct'); },
    })).rejects.toBeInstanceOf(SpiceEngineError);
    expect(constructions).toBe(0);
  });

  it('rejects a numeric artifact integrity mismatch before worker construction', async () => {
    const workerUrl = new URL('../dist/worker.js', import.meta.url);
    const workerBytes = new Uint8Array(await readFile(workerUrl));
    const numericUrl = new URL('../dist/dense-solver.wasm', import.meta.url);
    const wrongSha256 = '0'.repeat(64);
    const manifest: SpiceWorkerManifestV1 = {
      schemaVersion: 1,
      engineBuildId: `spice-ts-js-${sha256(workerBytes).slice(0, 16)}`,
      worker: { url: workerUrl.href, sha256: sha256(workerBytes) },
      numericWasm: {
        url: numericUrl.href,
        sha256: wrongSha256,
        byteLength: (await readFile(numericUrl)).byteLength,
        engineBuildId: `spice-ts-wasm-${wrongSha256.slice(0, 16)}`,
      },
    };
    let constructions = 0;
    await expect(createSpiceEngine({
      backend: 'spice-ts-wasm',
      manifest,
      workerFactory: () => { constructions++; throw new Error('must not construct'); },
    })).rejects.toMatchObject({
      error: { code: 'BACKEND_UNAVAILABLE', phase: 'transport' },
    });
    expect(constructions).toBe(0);
  });

  it('registers cancellation before asynchronous WASM worker construction', async () => {
    const wasm = await engine('spice-ts-wasm');
    try {
      const pending = wasm.simulate(request([
        'VCTRL control 0 2',
        'RCTRL control 0 1k',
        'F1 out 0 VCTRL 3',
        'RLOAD out 0 1k',
        '.op',
      ].join('\n')), { requestId: 'wasm-cancel' });
      expect(await wasm.cancel('wasm-cancel')).toEqual({ requestId: 'wasm-cancel', status: 'cancelling' });
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    } finally {
      await wasm.close();
    }
  });

  it('terminates an unresponsive worker at the caller wall-time bound', async () => {
    let terminations = 0;
    const silentWorker: WorkerLike = {
      postMessage() {},
      onMessage() { return () => {}; },
      onError() { return () => {}; },
      terminate() { terminations++; },
    };
    const wasm = await createSpiceEngine({
      backend: 'spice-ts-wasm',
      workerFactory: () => silentWorker,
    });
    try {
      const result = await wasm.simulate(request(circuits[0], {
        limits: { maxWallTimeMs: 5 },
      }), { requestId: 'wasm-deadline' });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'RESOURCE_LIMIT',
          phase: 'solve',
          details: { limit: 'maxWallTimeMs', configured: 5, observed: 5 },
        },
      });
      expect(terminations).toBe(1);
    } finally {
      await wasm.close();
    }
  });
});
