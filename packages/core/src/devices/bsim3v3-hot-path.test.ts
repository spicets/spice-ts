import { describe, expect, it } from 'vitest';
import { BSIM3v3 } from './bsim3v3.js';
import { fetlim, limvds, stepScale } from './devsup.js';
import type { StampContext } from './device.js';

// Preserve the callback-based limiter's arithmetic while removing its per-call closures.
describe('BSIM3 allocation-free bias reads', () => {
  for (const polarity of [1, -1]) {
    for (const nodes of [[0, 1, -1, -1], [-1, 1, 0, -1], [0, -1, 1, -1]]) {
      it(`preserves forward/reverse limiting for type ${polarity}, nodes ${nodes}`, () => {
        const device = new BSIM3v3('M1', nodes, {}, {}, polarity);
        const von = polarity * device.size.instVth0;
        for (const previous of [new Float64Array([0.1, 0.8]), new Float64Array([-0.4, -1])]) {
          for (const candidate of [new Float64Array([2, 3]), new Float64Array([-2, -3])]) {
            const bias = (solution: Float64Array) => {
              const voltage = (node: number) => node >= 0 ? solution[node] : 0;
              const source = voltage(nodes[2]);
              return [polarity * (voltage(nodes[1]) - source), polarity * (voltage(nodes[0]) - source)];
            };
            const [vgsOld, vdsOld] = bias(previous);
            const [vgsNew, vdsNew] = bias(candidate);
            const gate = vdsOld >= 0
              ? stepScale(vgsOld, vgsNew, fetlim(vgsNew, vgsOld, von))
              : stepScale(vgsOld - vdsOld, vgsNew - vdsNew, fetlim(vgsNew - vdsNew, vgsOld - vdsOld, von));
            const drain = vdsOld >= 0
              ? stepScale(vdsOld, vdsNew, limvds(vdsNew, vdsOld))
              : stepScale(-vdsOld, -vdsNew, limvds(-vdsNew, -vdsOld));
            expect(device.limitNewtonStep(previous, candidate)).toBe(Math.min(gate, drain));
          }
        }
      });
    }
  }

  it('keeps context method receivers and never reads a ground index', () => {
    const device = new BSIM3v3('M1', [0, 1, -1, -1], {}, {}, 1);
    const ctx: StampContext & { solution: Float64Array } = {
      solution: new Float64Array([0.8, 1]),
      getVoltage(node) {
        expect(node).toBeGreaterThanOrEqual(0);
        return this.solution[node];
      },
      getCurrent() { return 0; },
      stampG(_row, _col, value) { expect(Number.isFinite(value)).toBe(true); },
      stampB(_row, value) { expect(Number.isFinite(value)).toBe(true); },
      stampC(_row, _col, value) { expect(Number.isFinite(value)).toBe(true); },
      time: 0, dt: 0, numNodes: 2, sourceScale: 1, useDcSourceValue: false,
    };
    device.stamp(ctx);
    device.stampDynamic(ctx);
  });
});
