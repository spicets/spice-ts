import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const base = new URL('../../../../benchmarks/bsim3-acnqs-1249/', import.meta.url);
const deck = readFileSync(new URL('common-source.cir', base), 'utf8');
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as {
  engine: string;
  cases: { name: string; acnqs: number; deck: string; sha256: string; samples: { frequency: number; re: number; im: number }[] }[];
};

describe('BSIM3 ACNQSMOD (#1249)', () => {
  it.each(reference.cases)('$name ACNQSMOD=$acnqs matches ngspice-47 over six decades', async c => {
    const text = c.deck;
    if (c.name === 'common-source') expect(text).toBe(deck.replace('ACNQSMOD=1', `ACNQSMOD=${c.acnqs}`));
    expect(reference.engine).toBe('ngspice-47');
    expect(createHash('sha256').update(text).digest('hex')).toBe(c.sha256);
    const ac = (await simulate(text)).ac!;
    expect(ac.frequencies).toHaveLength(c.samples.length);
    const out = ac.voltage('out');
    const peak = Math.max(...c.samples.map(s => Math.hypot(s.re, s.im)));
    const phasePeak = Math.max(...c.samples.map(s => Math.abs(Math.atan2(s.im, s.re) * 180 / Math.PI)));
    const complex = [], magnitude = [], phase = [];
    for (let i = 0; i < out.length; i++) {
      const s = c.samples[i], a = out[i];
      expect(ac.frequencies[i] / s.frequency).toBeCloseTo(1, 10);
      const angle = a.phase * Math.PI / 180;
      complex.push(Math.hypot(a.magnitude * Math.cos(angle) - s.re, a.magnitude * Math.sin(angle) - s.im) / peak);
      magnitude.push(Math.abs(a.magnitude - Math.hypot(s.re, s.im)) / peak);
      const delta = a.phase - Math.atan2(s.im, s.re) * 180 / Math.PI;
      phase.push(Math.abs((delta + 540) % 360 - 180));
    }
    console.log(c.name, 'ACNQSMOD', c.acnqs, { complex: Math.max(...complex), magnitude: Math.max(...magnitude), phaseDegrees: Math.max(...phase) });
    expect(Math.max(...complex)).toBeLessThan(0.01);
    expect(Math.max(...magnitude)).toBeLessThan(0.01);
    expect(Math.max(...phase) / phasePeak).toBeLessThan(0.01);
  });

  it('leaves explicit ACNQSMOD=0 bit-identical to default QS', async () => {
    const a = (await simulate(deck.replace('ACNQSMOD=1', 'ACNQSMOD=0'))).ac!;
    const b = (await simulate(deck.replace('ACNQSMOD=1', ''))).ac!;
    expect(a.voltage('out')).toEqual(b.voltage('out'));
  });

  it('has a measurable high-frequency NQS effect in the reference', () => {
    const [qs, nqs] = reference.cases;
    expect(Math.max(...nqs.samples.map((s, i) => Math.hypot(s.re - qs.samples[i].re, s.im - qs.samples[i].im)))
      / Math.max(...qs.samples.map(s => Math.hypot(s.re, s.im)))).toBeGreaterThan(0.01);
  });

  it('resolves instance overrides and invalid instance fallback like b3set.c', async () => {
    const baseline = (await simulate(deck)).ac!.voltage('out');
    const instance = deck.replace('W=10u', 'ACNQSMOD=1 W=10u').replace('VERSION=3.3.0 ACNQSMOD=1', 'VERSION=3.3.0');
    expect((await simulate(instance)).ac!.voltage('out')).toEqual(baseline);
    expect((await simulate(deck.replace('W=10u', 'ACNQSMOD=7 W=10u'))).ac!.voltage('out')).toEqual(baseline);
    const qs = (await simulate(deck.replace('ACNQSMOD=1', 'ACNQSMOD=0'))).ac!.voltage('out');
    expect((await simulate(deck.replace('W=10u', 'ACNQSMOD=0 W=10u'))).ac!.voltage('out')).toEqual(qs);
  });

  it('keeps unsupported transient-NQS AC combinations and NQS noise typed', async () => {
    await expect(simulate(deck.replace('W=10u', 'NQSMOD=1 W=10u'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_MODEL_PARAMETER', parameter: 'NQSMOD',
    });
    await expect(simulate(deck.replace('.ac dec 10 1e6 1e12', '.noise v(out) VIN dec 10 1e6 1e12'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_MODEL_PARAMETER', parameter: 'ACNQSMOD',
    });
  });
});
