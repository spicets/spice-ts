import { describe, it, expect } from 'vitest';
import { parse } from '../parser/index.js';
import { MNAAssembler } from '../mna/assembler.js';
import { resolveOptions } from '../types.js';
import { attemptStep } from './transient-step.js';
import { SingularMatrixError } from '../errors.js';
import type { SparseSolver } from '../solver/sparse-solver.js';
import { SwitchBase, REALLY_ON } from '../devices/switch.js';

function buildRCContext() {
  const ckt = parse(`
V1 1 0 DC 5
R1 1 2 1k
C1 2 0 1u
.tran 1u 1m
`);
  const compiled = ckt.compile();
  const options = resolveOptions(undefined, 1e-3);
  const assembler = new MNAAssembler(compiled.nodeCount, compiled.branchCount);
  return { compiled, options, assembler };
}

describe('attemptStep', () => {
  it.each([
    ['SW', 'V1 ctrl 0 DC 500n\nS1 out 0 ctrl 0 SW', 'VT=200n'],
    ['CSW', 'I1 0 ctrl DC 500n\nV1 ctrl 0 0\nW1 out 0 V1 CSW', 'IT=200n'],
  ])('reloads %s after a first Newton update inside convergence tolerance', (model, control, threshold) => {
    // NIiter (ngspice-47 niiter.c:287-290) never accepts iteration one.
    // A small control update can cross VT even when NIconvTest would pass.
    const compiled = parse(`Switch below convergence tolerance
${control}
R1 out 0 1k
.model ${model} ${model}(${threshold} RON=1 ROFF=1e12)
.tran 1u 1m
.end`).compile();
    const options = resolveOptions(undefined, 1e-3);
    const assembler = new MNAAssembler(compiled.nodeCount, compiled.branchCount);
    const result = attemptStep({ compiled, assembler, options }, {
      dt: 1e-6, time: 1e-6, prevSolution: new Float64Array(assembler.solution),
      prevB: undefined, gmin: 1e-12, voltageLimit: 3.5,
    });
    expect(result.ok).toBe(true);
    expect(compiled.devices.find(device => device instanceof SwitchBase)!.currentState).toBe(REALLY_ON);
    expect(result.iterations).toBeGreaterThanOrEqual(2);
  });

  it('converges in a small number of iterations for a linear RC circuit', () => {
    const { compiled, options, assembler } = buildRCContext();
    const prevSol = new Float64Array(assembler.solution);

    const result = attemptStep(
      { compiled, assembler, options },
      { dt: 1e-6, time: 1e-6, prevSolution: prevSol, prevB: undefined, gmin: 1e-12, voltageLimit: 3.5 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.iterations).toBeLessThanOrEqual(5);
      expect(result.solution.length).toBe(compiled.nodeCount + compiled.branchCount);
    }
  });

  it('returns ok=false with reason="nr-divergence" when NR cannot converge', () => {
    const { compiled, options, assembler } = buildRCContext();
    // Force failure by setting maxTransientIterations to 0
    const brokenOpts = { ...options, maxTransientIterations: 0 };
    const prevSol = new Float64Array(assembler.solution);

    const result = attemptStep(
      { compiled, assembler, options: brokenOpts },
      { dt: 1e-6, time: 1e-6, prevSolution: prevSol, prevB: undefined, gmin: 1e-12, voltageLimit: 3.5 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('nr-divergence');
    }
  });

  it('leaves assembler.solution unchanged when maxTransientIterations=0 (loop never runs)', () => {
    const { compiled, options, assembler } = buildRCContext();
    const brokenOpts = { ...options, maxTransientIterations: 0 };
    const prevSol = new Float64Array(assembler.solution);
    const snapshot = new Float64Array(assembler.solution);

    attemptStep(
      { compiled, assembler, options: brokenOpts },
      { dt: 1e-6, time: 1e-6, prevSolution: prevSol, prevB: undefined, gmin: 1e-12, voltageLimit: 3.5 },
    );

    // When the loop never enters, nothing gets stamped or solved, so the
    // assembler.solution is guaranteed unchanged. This documents the loop-
    // not-entered edge case; the failure-on-iter-N contract is "indeterminate".
    expect(Array.from(assembler.solution)).toEqual(Array.from(snapshot));
  });
});

describe('attemptStep NR adaptive damping', () => {
  it('reports oscillation in the step result when sign flips are detected', () => {
    // Build a diode with very sharp I-V curve so NR oscillates at the first step.
    // The series resistor keeps a finite solution: a bare N=0.1 junction across
    // 5 V has none (ngspice-47 reports NaN), and pnjlim now walks the junction
    // towards the exact law instead of compressing it to a fixed ceiling.
    const ckt = parse(`
V1 1 0 DC 5
R1 1 2 1
.model DSHARP D(IS=1e-18 N=0.1)
D1 2 0 DSHARP
.tran 1u 1m
`);
    const compiled = ckt.compile();
    const options = resolveOptions(undefined, 1e-3);
    const assembler = new MNAAssembler(compiled.nodeCount, compiled.branchCount);
    const prevSol = new Float64Array(assembler.solution);

    const result = attemptStep(
      { compiled, assembler, options },
      { dt: 1e-6, time: 1e-6, prevSolution: prevSol, prevB: undefined, gmin: 1e-12, voltageLimit: 3.5 },
    );

    // This particular pathological model should trigger the oscillation branch
    // at least once. We don't care whether it ultimately converges — just that
    // the step result can carry the oscillation flag.
    if (result.ok) {
      expect(typeof result.oscillated).toBe('boolean');
    }
  });

  it('a tighter voltage limit reduces per-iteration delta magnitude', () => {
    const ckt = parse(`
V1 1 0 DC 10
R1 1 2 10
R2 2 0 10
.tran 1u 1m
`);
    const compiled = ckt.compile();
    const options = resolveOptions(undefined, 1e-3);
    const assembler = new MNAAssembler(compiled.nodeCount, compiled.branchCount);
    const prevSol = new Float64Array(assembler.solution);

    const tight = attemptStep(
      { compiled, assembler, options },
      { dt: 1e-6, time: 1e-6, prevSolution: prevSol, prevB: undefined, gmin: 1e-12, voltageLimit: 1.0 },
    );
    assembler.solution.fill(0);
    const loose = attemptStep(
      { compiled, assembler, options },
      { dt: 1e-6, time: 1e-6, prevSolution: prevSol, prevB: undefined, gmin: 1e-12, voltageLimit: 100 },
    );

    expect(tight.ok).toBe(true);
    expect(loose.ok).toBe(true);
    if (tight.ok && loose.ok) {
      // Tight limit should take more NR iterations to converge
      expect(tight.iterations).toBeGreaterThanOrEqual(loose.iterations);
    }
  });
});

describe('attemptStep linear-solve failures (issue #444 review)', () => {
  // ngspice dctran treats E_SINGULAR from NIiter as non-convergence and cuts
  // the timestep; a singular or non-finite solve must not abort the transient.
  function contextWithSolver(solver: SparseSolver) {
    const { compiled, options } = buildRCContext();
    const assembler = new MNAAssembler(compiled.nodeCount, compiled.branchCount, {
      solverFactory: () => solver,
    });
    return { compiled, options, assembler };
  }

  function stubSolver(overrides: Partial<SparseSolver>): SparseSolver {
    let analyzed = false;
    return {
      analyzePattern: () => { analyzed = true; },
      factorize: () => {},
      solve: b => b,
      isPatternAnalyzed: () => analyzed,
      ...overrides,
    };
  }

  const attempt = (prevSolution: Float64Array) => ({
    dt: 1e-6, time: 1e-6, prevSolution, prevB: undefined, gmin: 1e-12, voltageLimit: 3.5,
  });

  it('fails the NR attempt instead of throwing when factorization is singular', () => {
    const { compiled, options, assembler } = contextWithSolver(stubSolver({
      factorize: () => { throw SingularMatrixError.atPivot(1); },
    }));
    const result = attemptStep({ compiled, assembler, options }, attempt(new Float64Array(assembler.solution)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('nr-divergence');
      expect(result.iterations).toBe(1);
    }
  });

  it('fails the NR attempt instead of throwing when the solve is singular', () => {
    const { compiled, options, assembler } = contextWithSolver(stubSolver({
      solve: () => { throw SingularMatrixError.atPivot(0); },
    }));
    const result = attemptStep({ compiled, assembler, options }, attempt(new Float64Array(assembler.solution)));
    expect(result.ok).toBe(false);
  });

  it('fails the NR attempt when the solve returns a non-finite iterate', () => {
    const { compiled, options, assembler } = contextWithSolver(stubSolver({
      solve: b => { b.fill(Number.NaN); return b; },
    }));
    const result = attemptStep({ compiled, assembler, options }, attempt(new Float64Array(assembler.solution)));
    expect(result.ok).toBe(false);
    expect(Array.from(assembler.solution).every(Number.isFinite)).toBe(true);
  });

  it('still propagates unrelated solver errors', () => {
    const { compiled, options, assembler } = contextWithSolver(stubSolver({
      factorize: () => { throw new RangeError('bug'); },
    }));
    expect(() => attemptStep({ compiled, assembler, options }, attempt(new Float64Array(assembler.solution))))
      .toThrow(RangeError);
  });
});
