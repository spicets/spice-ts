import { describe, it, expect } from 'vitest';
import { VoltageSource, evaluatePulse, pulseBreakpoints, pwlBreakpoints } from './voltage-source.js';
import type { PulseSource, PWLSource } from '../types.js';

describe('pulseBreakpoints', () => {
  it('emits the rising-edge start at t=0 when delay is zero', () => {
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 5, delay: 0,
      rise: 100e-9, fall: 100e-9, width: 4.8e-6, period: 10e-6,
    };
    // t=0 is a slope discontinuity the transient driver must integrate
    // across at order 1; fall-edge end (5e-6) has a sub-ULP FP rounding from
    // 100e-9 + 4.8e-6 + 100e-9 — use the exact JS result.
    expect(pulseBreakpoints(p, 9e-6)).toEqual([
      0,
      100e-9,
      0 + 100e-9 + 4.8e-6,          // 4.9e-6 (exact)
      0 + 100e-9 + 4.8e-6 + 100e-9, // ≈5.0e-6 (IEEE 754 result)
    ]);
  });

  it('emits breakpoints across multiple periods up to stopTime', () => {
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 5, delay: 0,
      rise: 100e-9, fall: 100e-9, width: 4.8e-6, period: 10e-6,
    };
    // period 1 corners: 0, 100n, 4.9u, ~5.0u
    // period 2 corners: 10u, ~10.1u, ~14.9u  (fall-end ~15.0u > stopTime — skipped)
    expect(pulseBreakpoints(p, 15e-6)).toEqual([
      0,
      100e-9,
      0 + 100e-9 + 4.8e-6,
      0 + 100e-9 + 4.8e-6 + 100e-9,
      10e-6,
      10e-6 + 100e-9,
      10e-6 + 100e-9 + 4.8e-6,
    ]);
  });

  it('respects non-zero delay (all four corners emit in the first period)', () => {
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 5, delay: 1e-6,
      rise: 100e-9, fall: 100e-9, width: 4.8e-6, period: 10e-6,
    };
    expect(pulseBreakpoints(p, 8e-6)).toEqual([
      1e-6,
      1e-6 + 100e-9,
      1e-6 + 100e-9 + 4.8e-6,
      1e-6 + 100e-9 + 4.8e-6 + 100e-9,
    ]);
  });

  it('returns empty when stopTime is before first edge', () => {
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 5, delay: 5e-6,
      rise: 100e-9, fall: 100e-9, width: 4.8e-6, period: 10e-6,
    };
    expect(pulseBreakpoints(p, 1e-6)).toEqual([]);
  });

  it('treats PER <= 0 as one pulse, as evaluatePulse and ngspice (TPER = TSTOP) do', () => {
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 5, delay: 0,
      rise: 100e-9, fall: 100e-9, width: 4.8e-6, period: 0,
    };
    expect(pulseBreakpoints(p, 1e-3)).toEqual([0, 100e-9, 100e-9 + 4.8e-6, 100e-9 + 4.8e-6 + 100e-9]);
  });

  it('keeps the corners of a PULSE with PER omitted (period Infinity, #469)', () => {
    // corpus-e d_bjt-rtlinv.ckt: pulse(0 5 2ns 2ns 2ns 80ns), .tran 5ns 200ns.
    // 0 * Infinity is NaN, which used to drop every corner.
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 5, delay: 2e-9,
      rise: 2e-9, fall: 2e-9, width: 80e-9, period: Infinity,
    };
    expect(pulseBreakpoints(p, 200e-9)).toEqual([2e-9, 2e-9 + 2e-9, 2e-9 + 2e-9 + 80e-9, 2e-9 + 2e-9 + 80e-9 + 2e-9]);
  });

  it('stops after NP pulses, keeping the one corner ngspice schedules past NP*PER (#492)', () => {
    // ngspice-47 vsrcacct.c: no breakpoint is scheduled once TIME-TD > NP*PER,
    // but the evaluation at TIME-TD == NP*PER still queues the next corner.
    // `pulse(0 1 0 0.1 0.1 0.3 1 2)` over 5 s: ngspice -b steps through
    // 2.0 and 2.1 and then never lands on another corner.
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 1, delay: 0,
      rise: 0.1, fall: 0.1, width: 0.3, period: 1, pulses: 2,
    };
    expectCloseList(pulseBreakpoints(p, 5), [0, 0.1, 0.4, 0.5, 1, 1.1, 1.4, 1.5, 2, 2.1]);
  });

  it('ignores a non-positive NP like ngspice (PHASE > 0 guard)', () => {
    const p: PulseSource = {
      type: 'pulse', v1: 0, v2: 1, delay: 0,
      rise: 0.1, fall: 0.1, width: 0.3, period: 1, pulses: 0,
    };
    expectCloseList(pulseBreakpoints(p, 2), [0, 0.1, 0.4, 0.5, 1, 1.1, 1.4, 1.5]);
  });
});

function expectCloseList(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 14));
}

describe('evaluatePulse number of pulses (NP)', () => {
  const p: PulseSource = {
    type: 'pulse', v1: -1, v2: 1, delay: 0.5,
    rise: 0.1, fall: 0.1, width: 0.3, period: 1, pulses: 2,
  };

  it('repeats only NP pulses after the delay, then holds V1 (ngspice vsrcload.c)', () => {
    expect(evaluatePulse(p, 0.5 + 0.2)).toBe(1);
    expect(evaluatePulse(p, 1.5 + 0.2)).toBe(1);
    expect(evaluatePulse(p, 2.5 + 0.2)).toBe(-1);
    expect(evaluatePulse(p, 9.5 + 0.2)).toBe(-1);
  });

  it('truncates a fractional NP at NP*PER after the delay', () => {
    const half = { ...p, pulses: 1.25 };
    expect(evaluatePulse(half, 0.5 + 1.2)).toBe(1);
    expect(evaluatePulse(half, 0.5 + 1.3)).toBe(-1);
  });
});

describe('pwlBreakpoints', () => {
  it('returns only the first corner after t=0; later corners are scheduled on accept', () => {
    const pwl: PWLSource = {
      type: 'pwl',
      points: [{ time: 0, value: 0 }, { time: 1e-6, value: 1 }, { time: 3e-6, value: 0 }],
    };
    expect(pwlBreakpoints(pwl, 2e-6)).toEqual([1e-6]);
    expect(pwlBreakpoints(pwl, 0.5e-6)).toEqual([]);
  });
});

describe('VoltageSource.getBreakpoints', () => {
  it('returns pulse breakpoints when the waveform is a pulse', () => {
    const src = new VoltageSource('V1', [0, -1], 0, {
      type: 'pulse', v1: 0, v2: 5, delay: 0,
      rise: 100e-9, fall: 100e-9, width: 4.8e-6, period: 10e-6,
    });
    const bps = src.getBreakpoints!(1e-5);
    expect(bps.length).toBeGreaterThan(0);
    expect(bps[0]).toBe(0);
    expect(bps[1]).toBe(100e-9);
  });

  it('returns empty for DC sources', () => {
    const src = new VoltageSource('V1', [0, -1], 0, { type: 'dc', value: 5 });
    expect(src.getBreakpoints!(1e-3)).toEqual([]);
  });

  it('returns empty for SIN sources', () => {
    const src = new VoltageSource('V1', [0, -1], 0, {
      type: 'sin', offset: 0, amplitude: 1, frequency: 1e3,
    });
    expect(src.getBreakpoints!(1e-3)).toEqual([]);
  });
});
