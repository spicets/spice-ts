import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { resolveVBICParams } from './vbic.js';

describe('VBIC explicit resistance minimum (#1309)', () => {
  // ngspice-47 a80f6e3e vbicmpar.c:20,42-120 clamps supplied values;
  // vbicsetup.c:44-73 supplies different defaults when omitted.
  for (const name of ['RCX', 'RCI', 'RBX', 'RBI', 'RE', 'RS', 'RBP'] as const) {
    it.each([0, 1e-9, 0.009, 0.01, 0.1])(`${name}=%s uses the supplied-value minimum`, value => {
      expect(resolveVBICParams({ [name]: value }, 1)[name]).toBe(Math.max(0.01, value));
    });
  }
  it('does not clamp omitted zero defaults', () => {
    const params = resolveVBICParams({}, 1);
    for (const name of ['RCX', 'RBX', 'RE', 'RS'] as const) expect(params[name]).toBe(0);
    for (const name of ['RCI', 'RBI', 'RBP'] as const) expect(params[name]).toBe(0.1);
  });
  it('matches ngspice-47 currents at the first divergent DFF transistor bias', async () => {
    const reference = JSON.parse(readFileSync('../../benchmarks/vbic-resistance/ngspice-47.json', 'utf8')) as {
      version: string; deck: string; sha256: string; signals: Record<string, { re: number }[]>;
    };
    expect(reference.version).toBe('ngspice-47');
    expect(createHash('sha256').update(reference.deck).digest('hex')).toBe(reference.sha256);
    const result = (await simulate(reference.deck)).dc!;
    for (const source of ['vc', 'vb', 've', 'vs']) {
      // Off-state picoampere currents: 10 pA absolute allowance, not a
      // meaningless relative tolerance against a nearly zero denominator.
      expect(Math.abs(result.current(source) - reference.signals[`i(${source})`][0].re)).toBeLessThan(1e-11);
    }
  });
});
