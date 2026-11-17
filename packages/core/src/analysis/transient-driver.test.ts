import { describe, it, expect } from 'vitest';
import { createTransientSim } from './transient-driver.js';
import { TimestepTooSmallError } from '../errors.js';

const RC_NETLIST = `
V1 1 0 DC 5
R1 1 2 1k
C1 2 0 1u
.tran 1u 1m
`;

const DYNAMIC_HISTORY_NETLIST = `
V1 in 0 PULSE(0 1 1u 100n 100n 2u 5u)
R1 in out 1k
D1 out 0 DMOD
.model DMOD D(CJO=1n)
.tran 100n 10u
`;

describe('createTransientSim', () => {
  it('returns a driver with simTime=0 after creation', async () => {
    const sim = await createTransientSim(RC_NETLIST);
    expect(sim.simTime).toBe(0);
    expect(sim.isDone).toBe(false);
    sim.dispose();
  });

  it('advance() returns a TransientStep with time > 0', async () => {
    const sim = await createTransientSim(RC_NETLIST);
    const step = sim.advance();
    expect(step.time).toBeGreaterThan(0);
    expect(step.voltages.has('1')).toBe(true);
    expect(step.voltages.has('2')).toBe(true);
    expect(sim.simTime).toBe(step.time);
    sim.dispose();
  });

  it('step and exact-target advancement preserve warm transient state', async () => {
    const sim = await createTransientSim(RC_NETLIST);
    const first = sim.step();
    expect(first.time).toBeGreaterThan(0);
    const samples = sim.advanceTo(0.0001234567);
    expect(samples.at(-1)!.time).toBe(0.0001234567);
    expect(sim.advanceTo(sim.simTime)).toEqual([]);
    expect(() => sim.advanceTo(NaN)).toThrow();
    expect(() => sim.advanceTo(first.time)).toThrow();
    expect(() => sim.advanceTo(2e-3)).toThrow();
    const final = sim.advanceTo(1e-3).at(-1)!;
    const baseline = await createTransientSim(RC_NETLIST);
    const reference = baseline.advanceTo(1e-3).at(-1)!;
    expect(final.voltages.get('2')).toBeCloseTo(reference.voltages.get('2')!, 6);
    sim.dispose();
    expect(() => sim.advanceTo(1e-3)).toThrow();
    baseline.dispose();
  });

  it('matches a single transient run across multiple exact targets', async () => {
    const { simulate } = await import('../simulate.js');
    const reference = (await simulate(DYNAMIC_HISTORY_NETLIST)).transient!;
    const sim = await createTransientSim(DYNAMIC_HISTORY_NETLIST);
    const samples = [sim.peekInitialStep(), ...sim.advanceTo(1.23e-6),
      ...sim.advanceTo(4.56e-6), ...sim.advanceTo(sim.stopTime!)];
    const voltages = reference.voltage('out');
    for (let i = 0; i < reference.time.length; i++) {
      const t = reference.time[i];
      const upper = samples.findIndex(s => s.time >= t);
      if (upper <= 0) continue;
      const a = samples[upper - 1];
      const b = samples[upper];
      const fraction = (t - a.time) / (b.time - a.time);
      const value = a.voltages.get('out')! + fraction * (b.voltages.get('out')! - a.voltages.get('out')!);
      expect(Math.abs(value - voltages[i])).toBeLessThan(0.003);
    }
    sim.dispose();
  });

  it('advanceUntil(t) returns multiple steps', async () => {
    const sim = await createTransientSim(RC_NETLIST);
    const steps = sim.advanceUntil(100e-6);
    expect(steps.length).toBeGreaterThan(3);
    expect(steps[steps.length - 1].time).toBeGreaterThanOrEqual(100e-6);
    sim.dispose();
  });

  it.each([
    ['static-current history', RC_NETLIST],
    ['device RHS history', DYNAMIC_HISTORY_NETLIST],
  ])('reuses the accepted-step buffer for %s', async (_label, netlist) => {
    const sim = await createTransientSim(netlist);
    const internal = sim as unknown as { prevB: Float64Array };
    const initialHistory = internal.prevB;

    sim.advance();
    expect(internal.prevB).toBe(initialHistory);
    sim.advance();
    expect(internal.prevB).toBe(initialHistory);
    sim.reset();
    expect(internal.prevB).toBe(initialHistory);
    sim.dispose();
  });

  it('isDone becomes true once simTime crosses stopTime', async () => {
    const sim = await createTransientSim(RC_NETLIST);
    sim.advanceUntil(2e-3); // past stopTime=1ms
    expect(sim.isDone).toBe(true);
    sim.dispose();
  });

  it('reset() restores simTime to 0 and replays produce the same first step', async () => {
    const sim = await createTransientSim(RC_NETLIST);
    const a = sim.advance();
    sim.reset();
    expect(sim.simTime).toBe(0);
    const b = sim.advance();
    expect(b.time).toBeCloseTo(a.time, 12);
    for (const node of ['1', '2']) {
      expect(b.voltages.get(node)).toBeCloseTo(a.voltages.get(node)!, 9);
    }
    sim.dispose();
  });

  it('advance() after dispose() throws', async () => {
    const sim = await createTransientSim(RC_NETLIST);
    sim.dispose();
    expect(() => sim.advance()).toThrow();
  });

  it('matches simulate() trajectory on RC circuit', async () => {
    const { simulate } = await import('../simulate.js');
    const baseline = await simulate(RC_NETLIST);
    const baselineV2 = baseline.transient!.voltage('2');

    const sim = await createTransientSim(RC_NETLIST);
    const steps = sim.advanceUntil(1e-3);
    sim.dispose();

    // The driver produces its own timestep schedule (may not match exactly
    // but should converge to the same RC step response within ~1e-9 at common
    // points). Compare steady-state value only as a lightweight check.
    const finalDriver = steps[steps.length - 1];
    const driverV2 = finalDriver.voltages.get('2')!;
    const baselineFinal = baselineV2[baselineV2.length - 1];
    expect(driverV2).toBeCloseTo(baselineFinal, 9);
  });
});

describe('TransientSim boundary behavior', () => {
  it('advance() past isDone does not produce dt=0 (no division-by-zero)', async () => {
    // Regression: previously, the grow-factor clamp at the end of the last
    // step set `dt = stopTime - this.time` which evaluates to 0 once time has
    // reached stopTime. Calling advance() again then passed dt=0 into
    // `buildCompanionSystem`, producing `Infinity` in the matrix.
    const sim = await createTransientSim(RC_NETLIST);
    sim.advanceUntil(2e-3);
    expect(sim.isDone).toBe(true);
    // Spec: stopTime is advisory, advance() may be called past it.
    const step = sim.advance();
    expect(Number.isFinite(step.time)).toBe(true);
    expect(step.time).toBeGreaterThan(sim.stopTime!);
    for (const v of step.voltages.values()) expect(Number.isFinite(v)).toBe(true);
    sim.dispose();
  });
});

describe('TransientSim convergence', () => {
  it('hitting the dt floor throws TimestepTooSmallError', async () => {
    // Force dt-floor by starving NR of iterations. Every attemptStep call
    // returns ok=false immediately, so the driver keeps cutting dt by 8 until
    // it falls below MIN_TIMESTEP.
    const sim = await createTransientSim(`
V1 1 0 DC 5
R1 1 2 1k
C1 2 0 1u
.tran 1u 1m
`, { maxTransientIterations: 0 });
    try {
      expect(() => sim.advanceUntil(1e-6)).toThrow(TimestepTooSmallError);
    } finally {
      sim.dispose();
    }
  });
});
