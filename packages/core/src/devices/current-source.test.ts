import { describe, it, expect } from 'vitest';
import { CurrentSource } from './current-source.js';

describe('CurrentSource.getBreakpoints', () => {
  it('returns pulse breakpoints when the waveform is a pulse', () => {
    const src = new CurrentSource('I1', [0, -1], {
      type: 'pulse', v1: 0, v2: 1e-3, delay: 0,
      rise: 100e-9, fall: 100e-9, width: 4.8e-6, period: 10e-6,
    });
    const bps = src.getBreakpoints!(1e-5);
    // Later corners are scheduled only when an analog step is accepted.
    expect(bps).toEqual([0, 100e-9]);
  });

  it('returns empty for DC sources', () => {
    const src = new CurrentSource('I1', [0, -1], { type: 'dc', value: 1e-3 });
    expect(src.getBreakpoints!(1e-3)).toEqual([]);
  });
});
