import { describe, expect, it, vi } from 'vitest';
import * as stepping from './transient-step.js';
import { parse } from '../parser/index.js';
import { resolveOptions } from '../types.js';
import { createDriverFromCompiled, createTransientSim } from './transient-driver.js';
import type { TransientRejection } from './transient-driver.js';

const SINE = `Voltage predictor telemetry
V1 in 0 SIN(0 1 1MEG)
R1 in 0 1k
.tran 100n 1u
.end`;

const JFET = `Charge telemetry
V1 in 0 SIN(0 1 1MEG)
R1 in g 1k
J1 d g 0 JMOD
RD d 0 1k
.model JMOD NJF(CGS=1p CGD=1p)
.tran 1n 1u
.end`;

describe('opt-in transient rejection telemetry (#1310)', () => {
  it.each(['stepping', 'compiled'] as const)(
    'reports the resolved oscillation-floor recovery timestep in the %s driver',
    async driver => {
      const events: TransientRejection[] = [];
      const onReject = (event: TransientRejection) => events.push(event);
      const netlist = SINE.replace('.tran 100n 1u', '.tran 1f 1p');
      const compiledSim = driver === 'compiled'
        ? createDriverFromCompiled(parse(netlist).compile(), resolveOptions({}, 1e-12), {
          stopTime: 1e-12, timestep: 1e-15, maxTimestep: 1e-15, onReject,
        })
        : undefined;
      const sim = compiledSim ?? await createTransientSim(netlist, { onReject });
      const attempt = vi.spyOn(stepping, 'attemptStep').mockReturnValueOnce({
        ok: false, reason: 'nr-divergence', iterations: 100, oscillated: true,
        lastSolution: new Float64Array(), prevIterSolution: new Float64Array(),
      });
      try {
        if (compiledSim) compiledSim.advanceSolution();
        else sim.advance();
        expect(events).toHaveLength(1);
        expect(events[0].reason).toBe('newton');
        expect(attempt.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(events[0].nextTimestep).toBe(attempt.mock.calls[1][1].dt);
        expect(events[0].nextTimestep).toBe(1e-15);
      } finally {
        attempt.mockRestore();
        sim.dispose();
      }
    },
  );

  it('reports a Newton retry even when recovery changes method without cutting dt', async () => {
    const events: TransientRejection[] = [];
    const sim = await createTransientSim(JFET.replace('.end', 'L1 d 0 1m\n.end'), {
      onReject: event => events.push(event),
    });
    const attempt = vi.spyOn(stepping, 'attemptStep').mockReturnValueOnce({
      ok: false, reason: 'nr-divergence', iterations: 100, oscillated: false,
      lastSolution: new Float64Array(), prevIterSolution: new Float64Array(),
    });
    try {
      sim.advance();
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('newton');
      expect(events[0].nextTimestep).toBe(events[0].timestep);
      expect(sim.convergence.transient.nrRetries).toBe(1);
    } finally {
      attempt.mockRestore();
      sim.dispose();
    }
  });

  it('classifies voltage rejects without changing accepted points or convergence', async () => {
    const events: TransientRejection[] = [];
    const make = (onReject?: (event: TransientRejection) => void) => {
      const compiled = parse(SINE).compile();
      // An uncovered stateful device keeps the fallback voltage predictor active.
      compiled.devices.find(device => device.name === 'R1')!.acceptTransientStep = () => {};
      return createDriverFromCompiled(compiled, resolveOptions({}, 1e-6), {
        stopTime: 1e-6, timestep: 100e-9, maxTimestep: 20e-9, onReject,
      });
    };
    const plain = make();
    const debug = make(event => events.push(event));
    expect(debug.advanceUntil(1e-6)).toEqual(plain.advanceUntil(1e-6));
    expect(debug.convergence).toEqual(plain.convergence);
    expect(events.length).toBe(debug.convergence.transient.rejectedSteps);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.reason).toBe('voltage-lte');
      expect(event.voltageRatio).toBeGreaterThan(1);
      expect(event.nextTimestep).toBeLessThan(event.timestep);
    }
    debug.reset();
    events.length = 0;
    debug.advanceUntil(1e-6);
    expect(events.length).toBe(debug.convergence.transient.rejectedSteps);
    plain.dispose();
    debug.dispose();
  });

  it('classifies charge rejects and preserves the voltage predicate', () => {
    const compiled = parse(JFET).compile();
    const jfet = compiled.devices.find(device => device.name === 'J1')!;
    // Deliberately strict hook tests classification, not physical parity.
    let calls = 0;
    jfet.truncateTransientStep = (_ctx, truncation) => ++calls === 5 ? truncation.deltas[0] / 2 : Infinity;
    const events: TransientRejection[] = [];
    const sim = createDriverFromCompiled(compiled, resolveOptions({}, 1e-6), {
      stopTime: 1e-6, timestep: 1e-9, maxTimestep: 2e-8,
      onReject: event => events.push(event),
    });
    sim.advanceUntil(1e-7);
    expect(events.length).toBe(sim.convergence.transient.rejectedSteps);
    expect(events.some(event => event.reason === 'charge-lte')).toBe(true);
    for (const event of events) {
      expect(event.reason).toBe(event.voltageRatio! > 1 ? 'voltage-and-charge-lte' : 'charge-lte');
      expect(event.chargeBound).toBeLessThan(0.9 * event.timestep);
    }
    sim.dispose();
  });

  it('does not report scheduled breakpoint clipping as a rejected trial', async () => {
    const events: TransientRejection[] = [];
    const sim = await createTransientSim(`Breakpoint clipping
V1 in 0 PULSE(0 1 0 1n 1n 5n 10n)
R1 in 0 1k
.tran 1n 20n
.end`, { onReject: event => events.push(event) });
    sim.advanceUntil(20e-9);
    expect(events.length).toBe(sim.convergence.transient.rejectedSteps);
    expect(events.some(event => event.reason === 'breakpoint')).toBe(false);
    sim.dispose();
  });
});
