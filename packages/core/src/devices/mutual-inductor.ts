import type { DeviceModel, StampContext } from './device.js';
import type { Inductor } from './inductor.js';

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
  ) {
    if (!Number.isFinite(coupling) || Math.abs(coupling) > 1) {
      throw new Error(`K-element '${name}' coupling coefficient must be between -1 and 1`);
    }
  }

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
