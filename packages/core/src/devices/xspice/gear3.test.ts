import { describe, expect, it } from 'vitest';
import type { ChargeIntegration } from '../device.js';
import { XSPICE_BEHAVIORS, type CodeModelBehavior, type CodeModelCall } from './models.js';
import { REACTIVE_IC_BEHAVIORS } from './reactive-ic-models.js';
import { sTransferBehavior } from './s-xfer.js';

// Independent Lagrange derivative reference, not the production BDF helper.
function derivativeWeights(steps: number[]): number[] {
  const nodes = [0];
  for (const step of steps) nodes.push(nodes.at(-1)! - step);
  return nodes.map((node, j) => {
    let derivative = 0;
    for (let k = 0; k < nodes.length; k++) {
      if (k === j) continue;
      let term = 1 / (node - nodes[k]);
      for (let m = 0; m < nodes.length; m++) {
        if (m !== j && m !== k) term *= -nodes[m] / (node - nodes[m]);
      }
      derivative += term;
    }
    return derivative;
  });
}

const subjects: { name: string; create(): CodeModelBehavior; initial: number[]; scale: number; feedback: number[] }[] = [
  { name: 'int', create: () => XSPICE_BEHAVIORS.get('int')!(new Map([
    ['in_offset', [0]], ['gain', [1]], ['out_ic', [1]],
    ['out_lower_limit', [-1e20]], ['out_upper_limit', [1e20]], ['limit_range', [0]],
  ]), {} as never), initial: [1], scale: 1, feedback: [0] },
  ...['capacitoric', 'inductoric'].map(name => ({
    name, create: () => REACTIVE_IC_BEHAVIORS.get(name)!(new Map([
      [name === 'capacitoric' ? 'c' : 'l', [2]], ['ic', [1]],
    ]), {} as never), initial: [1], scale: 0.5, feedback: [0],
  })),
  ...[1, 2].map(order => ({
    name: `s_xfer cascade ${order}`, initial: Array<number>(order).fill(1), scale: 1,
    feedback: Array<number>(order).fill(0.25),
    create: () => sTransferBehavior({ numerator: [1], denominator: [...Array<number>(order).fill(0.25), 1],
      initial: Array<number>(order).fill(1), gain: 1, offset: 0 }),
  })),
];

for (const subject of subjects) {
  describe(`${subject.name} BDF3`, () => {
    it.each(['euler', 'trapezoidal', 'missing prevDt', 'missing prevPrevDt'] as const)(
      'retains the lower-order path for %s even with three accepted points', mode => {
        const behaviors = [subject.create(), subject.create()];
        const call = (time: number, integration?: ChargeIntegration): CodeModelCall => ({
          analysis: time === 0 ? 'dc' : 'tran', init: time === 0, time, delta: 0.1,
          inputs: Float64Array.of(2 + time), outputs: new Float64Array(1), partials: new Float64Array(1),
          integration, notConverged() {},
        });
        for (const behavior of behaviors) {
          for (const time of [0, 0.1, 0.2]) behavior.accept!(call(time));
        }
        const integration: ChargeIntegration = {
          method: mode === 'euler' || mode === 'trapezoidal' ? mode : 'gear2',
          order: 3, dt: 0.1, prevDt: mode === 'missing prevDt' ? undefined : 0.1,
          prevPrevDt: mode === 'missing prevPrevDt' ? undefined : 0.1,
        };
        const trial = call(0.3, integration);
        const lowerOrder = call(0.3, { ...integration, order: 2 });
        behaviors[0].load(trial);
        behaviors[1].load(lowerOrder);
        expect(trial.outputs).toEqual(lowerOrder.outputs);
        expect(trial.partials).toEqual(lowerOrder.partials);
      },
    );
    for (const steps of [[0.1, 0.1, 0.1, 0.1, 0.1], [0.08, 0.13, 0.06, 0.11, 0.09]]) {
      it(`matches the reference on ${steps[0] === steps[1] ? 'uniform' : 'non-uniform'} steps and restarts`, () => {
        const behavior = subject.create();
        const call = (time: number, input: number, integration?: ChargeIntegration): CodeModelCall => ({
          analysis: time === 0 ? 'dc' : 'tran', init: time === 0, time, delta: integration?.dt ?? 0,
          inputs: Float64Array.of(input), outputs: new Float64Array(1), partials: new Float64Array(1),
          integration, notConverged() {},
        });
        const run = () => {
          behavior.accept!(call(0, 0));
          const history = [[...subject.initial]];
          let time = 0;
          for (let n = 0; n < steps.length; n++) {
            time += steps[n];
            const integration: ChargeIntegration = { method: 'gear2', order: 3, dt: steps[n],
              prevDt: steps[n - 1], prevPrevDt: steps[n - 2] };
            const weights = derivativeWeights(steps.slice(Math.max(0, n - 2), n + 1).reverse());
            const states = [...subject.initial, (2 + time * time) * subject.scale];
            for (let i = 0; i < subject.feedback.length; i++) states[subject.initial.length] -= subject.feedback[i] * history[0][i];
            for (let i = subject.initial.length; i > 0; i--) {
              let rhs = states[i];
              for (let j = 1; j < weights.length; j++) rhs -= weights[j] * history[j - 1][i - 1];
              states[i - 1] = rhs / weights[0];
            }
            // Neither rejected trials nor repeated Newton loads may advance history.
            behavior.load(call(time + 1, 999, integration));
            const trial = call(time, 2 + time * time, integration);
            behavior.load(trial);
            behavior.load(trial);
            expect(trial.outputs[0]).toBeCloseTo(states[0], 12);
            expect(trial.partials[0]).toBeCloseTo(subject.name.startsWith('s_xfer') ? states[1] : subject.scale / weights[0], 12);
            behavior.accept!(trial);
            history.unshift(states.slice(0, subject.initial.length));
          }
        };
        run();
        behavior.reset!();
        run();
      });
    }
  });
}
