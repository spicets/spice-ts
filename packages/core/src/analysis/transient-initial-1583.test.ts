import { describe, expect, it } from 'vitest';
import { createTransientSim, simulate } from '../index.js';
import type { TransientSim, TransientStep } from '../index.js';

const DECKS = [
  ['RC', `RC step response
V1 in 0 PULSE(0 5 1u 100n 100n 1m 2m)
R1 in out 1k
C1 out 0 1u
.tran 1u 100u
.end
`],
  ['half-wave rectifier', `Half-wave diode rectifier
V1 in 0 SIN(0 5 1k)
R1 in anode 100
D1 anode out rectifier
R2 out 0 1k
C1 out 0 100n
.model rectifier D(IS=1n RS=2)
.tran 1u 2m
.end
`],
] as const;

describe('public TransientSim.peekInitialStep (#1583)', () => {
  it.each(DECKS)('reproduces every simulate() sample exactly for %s', async (_name, deck) => {
    const expected = (await simulate(deck)).transient!;
    const sim: TransientSim = await createTransientSim(deck);
    try {
      const initial: TransientStep = sim.peekInitialStep();
      const convergence = sim.convergence;
      expect(initial.time).toBe(0);
      expect(sim.peekInitialStep()).toEqual(initial);
      expect(sim.simTime).toBe(0);
      expect(sim.isDone).toBe(false);
      expect(sim.convergence).toEqual(convergence);

      const steps = [initial];
      while (!sim.isDone) steps.push(sim.advance());
      expect(steps).toHaveLength(expected.time.length);
      for (let i = 0; i < steps.length; i++) {
        expect(steps[i].time).toBe(expected.time[i]);
        expect([...steps[i].voltages.keys()]).toEqual([...expected.voltages.keys()]);
        expect([...steps[i].currents.keys()]).toEqual([...expected.currents.keys()]);
        for (const [node, values] of expected.voltages) {
          expect(steps[i].voltages.get(node)).toBe(values[i]);
        }
        for (const [branch, values] of expected.currents) {
          expect(steps[i].currents.get(branch)).toBe(values[i]);
        }
      }

      sim.reset();
      expect(sim.peekInitialStep()).toEqual(initial);
      expect(sim.peekInitialStep()).toEqual(initial);
      expect(sim.simTime).toBe(0);
      const first = sim.advance();
      expect(first).toEqual(steps[1]);
      expect(sim.peekInitialStep()).toEqual(first);
      const detached = sim.peekInitialStep();
      detached.voltages.set('in', 123);
      detached.currents.clear();
      expect(sim.peekInitialStep()).toEqual(first);
      // Returned Maps are detached snapshots, not aliases of the solver state.
      expect(initial.time).toBe(0);
      expect(initial.voltages.get('in')).toBe(expected.voltage('in')[0]);
    } finally {
      sim.dispose();
    }
  });
});
