import type { DeviceModel, StampContext } from './device.js';
import type { Inductor } from './inductor.js';
import { InvalidCircuitError } from '../errors.js';

/** SPICE K-element coupling two inductor branch equations. */
export class MutualInductor implements DeviceModel {
  readonly nodes: number[] = [];
  readonly branches: number[] = [];
  readonly isNonlinear = false;

  constructor(
    readonly name: string,
    readonly indA: Inductor,
    readonly indB: Inductor,
    public coupling: number,
  ) {}

  stamp(_ctx: StampContext): void {
    // Mutual inductance has no DC contribution.
  }

  stampDynamic(ctx: StampContext): void {
    const mutual = this.coupling * Math.sqrt(this.indA.inductance * this.indB.inductance);
    const branchA = ctx.numNodes + this.indA.branchIndex;
    const branchB = ctx.numNodes + this.indB.branchIndex;
    // Match Inductor's -L branch-equation convention.
    ctx.stampC(branchA, branchB, -mutual);
    ctx.stampC(branchB, branchA, -mutual);
  }
}

/** Validate connected K groups before any analysis, including DC and control alters. */
export function validateCoupledInductors(devices: readonly DeviceModel[]): void {
  const adjacency = new Map<Inductor, MutualInductor[]>();
  for (const device of devices) {
    if (!(device instanceof MutualInductor)) continue;
    for (const inductor of [device.indA, device.indB]) {
      const edges = adjacency.get(inductor) ?? [];
      edges.push(device);
      adjacency.set(inductor, edges);
    }
  }
  const visited = new Set<Inductor>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const inductors: Inductor[] = [];
    const couplings = new Set<MutualInductor>();
    const pending = [start];
    while (pending.length > 0) {
      const inductor = pending.pop()!;
      if (visited.has(inductor)) continue;
      visited.add(inductor);
      inductors.push(inductor);
      for (const edge of adjacency.get(inductor)!) {
        couplings.add(edge);
        pending.push(edge.indA, edge.indB);
      }
    }
    const reject = (): never => {
      throw new InvalidCircuitError(`Inductive system is not positive definite: ${[
        ...inductors.map(inductor => inductor.name),
        ...Array.from(couplings, coupling => coupling.name),
      ].join(', ')}`);
    };
    if (inductors.some(inductor => !Number.isFinite(inductor.inductance) || inductor.inductance <= 0)) reject();

    // Congruence by diag(1/sqrt(L)) preserves definiteness without a
    // circuit-dependent absolute inductance tolerance.
    const indices = new Map(inductors.map((inductor, index) => [inductor, index]));
    const matrix: number[][] = inductors.map((_, i) => inductors.map((_, j) => i === j ? 1 : 0));
    for (const coupling of couplings) {
      if (!Number.isFinite(coupling.coupling)) reject();
      const i = indices.get(coupling.indA)!;
      const j = indices.get(coupling.indB)!;
      matrix[i][j] += coupling.coupling;
      matrix[j][i] += coupling.coupling;
    }
    // Pivoted Cholesky detects indefinite groups even when every |k| < 1,
    // but preserves ngspice's valid semidefinite ideal transformers (|k|=1).
    // The normalized matrix has unit diagonal, so this roundoff allowance
    // depends only on group size, not on circuit inductance magnitudes.
    const tolerance = 16 * Number.EPSILON * matrix.length;
    for (let i = 0; i < matrix.length; i++) {
      let pivot = i;
      for (let j = i + 1; j < matrix.length; j++) {
        if (matrix[j][j] > matrix[pivot][pivot]) pivot = j;
      }
      [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
      for (const row of matrix) [row[i], row[pivot]] = [row[pivot], row[i]];
      const diagonal = matrix[i][i];
      if (diagonal < -tolerance) reject();
      if (diagonal <= tolerance) {
        // A zero pivot is legal only if the entire residual block is zero.
        // Ignoring its off-diagonal entries would admit indefinite groups.
        for (let j = i; j < matrix.length; j++) {
          for (let k = i; k < matrix.length; k++) {
            if (Math.abs(matrix[j][k]) > tolerance) reject();
          }
        }
        break;
      }
      for (let j = i + 1; j < matrix.length; j++) {
        for (let k = j; k < matrix.length; k++) {
          matrix[k][j] -= matrix[j][i] * matrix[k][i] / diagonal;
          matrix[j][k] = matrix[k][j];
        }
      }
    }
  }
}
