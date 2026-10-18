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
    // Cholesky detects non-viable groups even when every pair has |k| < 1.
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j <= i; j++) {
        let value = matrix[i][j];
        for (let k = 0; k < j; k++) value -= matrix[i][k] * matrix[j][k];
        if (i === j) {
          if (!(value > 0)) reject();
          matrix[i][j] = Math.sqrt(value);
        } else {
          matrix[i][j] = value / matrix[j][j];
        }
      }
    }
  }
}
