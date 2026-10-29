import { describe, expect, it } from 'vitest';
import { createTransientSim, simulate } from '../index.js';
import { parse } from '../parser/index.js';

describe('live transient sources', () => {
  it('changes a DC voltage source without restarting the circuit', async () => {
    const sim = await createTransientSim(parse(`Live source
V1 in 0 DC 0
R1 in out 1k
C1 out 0 1u
.tran 10u 4m
.end`));
    sim.advanceUntil(1e-3);
    const before = sim.peekInitialStep();
    expect(before.voltages.get('out')).toBeCloseTo(0, 8);
    sim.setSourceValue('v1', 1);
    const after = sim.advanceUntil(3e-3).at(-1)!;
    expect(after.voltages.get('in')).toBeCloseTo(1, 8);
    expect(after.voltages.get('out')).toBeGreaterThan(0.8);
    expect(after.voltages.get('out')).toBeLessThan(0.9);
  });

  it('tracks a PWL-equivalent voltage transition in an RC circuit', async () => {
    const sim = await createTransientSim(`Live source
V1 in 0 DC 0
R1 in out 1k
C1 out 0 1u
.tran 10u 4m
.end`);
    const target = 1e-3;
    const before = sim.advanceTo(target);
    expect(before.at(-1)!.time).toBe(target);
    expect(sim.simTime).toBe(target);
    const changeTime = target;
    sim.setSourceValue('V1', 1);
    const samples = sim.advanceTo(4e-3);
    const reference = await simulate(`PWL reference
V1 in 0 PWL(0 0 ${changeTime} 0 ${changeTime + 1e-9} 1 4m 1)
R1 in out 1k
C1 out 0 1u
.tran 10u 4m
.end`);
    const times = reference.transient!.time;
    const values = reference.transient!.voltage('out');
    const compared = samples.filter(s => s.time >= changeTime + 1e-4 && s.time <= times[times.length - 1]);
    expect(compared.length).toBeGreaterThan(10);
    for (const sample of compared) {
      // Independent RC step response: R = 1 kΩ, C = 1 µF, τ = 1 ms.
      const analytic = 1 - Math.exp(-(sample.time - changeTime) / 1e-3);
      expect(Math.abs(sample.voltages.get('out')! - analytic)).toBeLessThan(0.003);
      const upper = times.findIndex(t => t >= sample.time);
      if (upper <= 0) continue;
      const fraction = (sample.time - times[upper - 1]) / (times[upper] - times[upper - 1]);
      const expected = values[upper - 1] + fraction * (values[upper] - values[upper - 1]);
      expect(Math.abs(sample.voltages.get('out')! - expected)).toBeLessThan(0.003);
    }
  });

  it('validates updates and retains the changed value on reset', async () => {
    const sim = await createTransientSim(`Live source
I1 0 out DC 0
R1 out 0 1k
.tran 10u 1m
.end`);
    expect(() => sim.setSourceValue('R1', 1)).toThrow();
    expect(() => sim.setSourceValue('missing', 1)).toThrow();
    expect(() => sim.setSourceValue('I1', Infinity)).toThrow();
    sim.setSourceValue('i1', 0.001);
    expect(sim.advance().voltages.get('out')).toBeCloseTo(1, 6);
    sim.reset();
    expect(sim.peekInitialStep().voltages.get('out')).toBeCloseTo(1, 6);
    sim.dispose();
    expect(() => sim.setSourceValue('I1', 0)).toThrow();
  });

  it('restores the original UIC seed on reset while retaining the updated source', async () => {
    const sim = await createTransientSim(`UIC reset
V1 in 0 DC 1
R1 in out 1k
C1 out 0 1u IC=0
.tran 10u 4m UIC
.end`);
    sim.setSourceValue('V1', 2);
    sim.advanceTo(1e-3);
    sim.reset();
    expect(sim.peekInitialStep().voltages.get('in')).toBeCloseTo(0, 8);
    expect(sim.peekInitialStep().voltages.get('out')).toBeCloseTo(0, 8);
    expect(sim.advanceTo(2e-3).at(-1)!.voltages.get('out')).toBeCloseTo(2 * (1 - Math.exp(-2)), 3);
  });

  it('rejects overwriting time-dependent source waveforms', async () => {
    const sim = await createTransientSim(`Waveform
V1 in 0 PULSE(0 1 1u 1u 1u 10u 20u)
R1 in 0 1k
.tran 1u 100u
.end`);
    expect(() => sim.setSourceValue('V1', 1)).toThrow();
    sim.dispose();
  });
});
