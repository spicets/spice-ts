import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTransientSim } from './transient-driver.js';
import type { SparseSolver, TransientSimOptions } from '../index.js';
import * as sparse from '../solver/sparse-solver.js';
import { InvalidCircuitError } from '../errors.js';
import { parse } from '../parser/index.js';
import { resolveOptions } from '../types.js';
import { solveDCOperatingPoint } from './dc.js';

const RECTIFIER = `Injected diode rectifier
V1 in 0 SIN(0 5 1k)
D1 in out rectifier
R1 out 0 1k
C1 out 0 1u
.model rectifier D(IS=1n CJO=10p)
.tran 10u 2m
`;

function countingFactory() {
  const create = sparse.createSparseSolver;
  const solves: number[] = [];
  const factory = vi.fn((): SparseSolver => {
    const inner = create();
    const index = solves.push(0) - 1;
    return {
      analyzePattern: (...args) => inner.analyzePattern(...args),
      isPatternAnalyzed: () => inner.isPatternAnalyzed(),
      factorize: matrix => inner.factorize(matrix),
      solve: (...args) => {
        solves[index]++;
        return inner.solve(...args);
      },
    };
  });
  return { factory, solves };
}

afterEach(() => vi.restoreAllMocks());

describe('per-instance transient solverFactory (#1581)', () => {
  it('routes every DC and transient solve through the factory, with bit-identical replay', async () => {
    const defaultFactory = vi.spyOn(sparse, 'createSparseSolver');
    const baseline = await createTransientSim(RECTIFIER);
    const expected = baseline.advanceUntil(2e-3);
    expect(Math.max(...expected.map(step => step.voltages.get('out')!))).toBeGreaterThan(3);
    expect(Math.min(...expected.map(step => step.voltages.get('in')!))).toBeLessThan(-4);
    const baselineSolves = baseline.convergence.dc.newtonIterations
      + baseline.convergence.transient.newtonIterations;
    baseline.dispose();
    expect(defaultFactory.mock.calls.length).toBeGreaterThanOrEqual(2);
    defaultFactory.mockRestore();

    const { factory, solves } = countingFactory();
    const defaults = vi.spyOn(sparse, 'createSparseSolver');
    const options: TransientSimOptions = { solverFactory: factory };
    const sim = await createTransientSim(RECTIFIER, options);
    try {
      expect(factory).toHaveBeenCalledTimes(1); // DC initialization
      expect(solves[0]).toBeGreaterThan(0);
      const actual = sim.advanceUntil(2e-3);
      expect(factory).toHaveBeenCalledTimes(2); // transient assembler
      expect(solves.every(count => count > 0)).toBe(true);
      expect(solves.reduce((sum, count) => sum + count, 0)).toBe(baselineSolves);
      expect(actual).toEqual(expected);
      sim.reset();
      expect(factory).toHaveBeenCalledTimes(3);
      expect(sim.advanceUntil(2e-3)).toEqual(expected);
      expect(factory).toHaveBeenCalledTimes(4);
      expect(defaults).not.toHaveBeenCalled();
    } finally {
      sim.dispose();
    }
  });

  it.each([false, true])('propagates a structured factory error without recovery (UIC=%s)', async uic => {
    const failure = new InvalidCircuitError('Injected solver unavailable');
    const factory = vi.fn((): SparseSolver => { throw failure; });
    const defaults = vi.spyOn(sparse, 'createSparseSolver');
    if (uic) {
      const sim = await createTransientSim(`${RECTIFIER.trim()} uic`, { solverFactory: factory });
      try {
        expect(() => sim.advance()).toThrow(failure);
      } finally {
        sim.dispose();
      }
    } else {
      await expect(createTransientSim(RECTIFIER, { solverFactory: factory })).rejects.toBe(failure);
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(defaults).not.toHaveBeenCalled();
  });

  it('keeps factory failures out of DC convergence recovery even for singular-matrix errors', async () => {
    const { SingularMatrixError } = await import('../errors.js');
    const failure = new SingularMatrixError('Backend unavailable', ['out']);
    const factory = vi.fn((): SparseSolver => { throw failure; });
    await expect(createTransientSim(RECTIFIER, { solverFactory: factory })).rejects.toBe(failure);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('propagates failure when constructing the transient solver after a successful DC init', async () => {
    const { factory } = countingFactory();
    const sim = await createTransientSim(RECTIFIER, { solverFactory: factory });
    const failure = new InvalidCircuitError('Transient backend unavailable');
    factory.mockImplementationOnce(() => { throw failure; });
    const defaults = vi.spyOn(sparse, 'createSparseSolver');
    try {
      expect(() => sim.advance()).toThrow(failure);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(defaults).not.toHaveBeenCalled();
    } finally {
      sim.dispose();
    }
  });

  it('injects the solver into the passive OPtran fallback', () => {
    const compiled = parse(`Floating passive RC
V1 in 0 1
R1 in 0 1k
R2 a b 1k
C1 a 0 1u
C2 b 0 1u
`).compile();
    const { factory, solves } = countingFactory();
    const defaults = vi.spyOn(sparse, 'createSparseSolver');
    const { assembler } = solveDCOperatingPoint(
      compiled, resolveOptions(), undefined, undefined, 'operating-point', undefined,
      { solverFactory: factory },
    );
    expect(assembler.solution.every(Number.isFinite)).toBe(true);
    expect(factory.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(solves.slice(1).some(count => count > 0)).toBe(true);
    expect(defaults).not.toHaveBeenCalled();
  });

  it('propagates factory errors from the OPtran fallback unchanged', () => {
    const compiled = parse('Floating passive RC\nR1 a b 1k\nC1 a 0 1u\nC2 b 0 1u').compile();
    const { factory } = countingFactory();
    const failure = new InvalidCircuitError('OPtran backend unavailable');
    const normal = factory.getMockImplementation()!;
    factory.mockImplementationOnce(normal).mockImplementationOnce(() => { throw failure; });
    const defaults = vi.spyOn(sparse, 'createSparseSolver');
    expect(() => solveDCOperatingPoint(
      compiled, resolveOptions(), undefined, undefined, 'operating-point', undefined,
      { solverFactory: factory },
    )).toThrow(failure);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(defaults).not.toHaveBeenCalled();
  });
});
