import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { InvalidCircuitError } from '../errors.js';

const fixtures = new URL('./__fixtures__/diode-self-heating-ac/', import.meta.url);
const cases = ['static', 'thermal-cap', 'junction-cap', 'both-caps', 'default-cth',
  'series-resistance', 'external-thermal-cap'];
type Reference = { sha256: string; rows: number[][] };

describe('self-heating diode AC parity with ngspice-47 (#1787)', () => {
  it.each(cases)('matches thermal voltage, anode voltage and source current: %s', async name => {
    const deck = readFileSync(new URL(`${name}.cir`, fixtures), 'utf8');
    const reference: Reference = JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), 'utf8'));
    expect(createHash('sha256').update(deck).digest('hex')).toBe(reference.sha256);
    const result = (await simulate(deck)).ac!;
    expect(result.frequencies).toHaveLength(reference.rows.length);
    const signals = [result.voltage('tj'), result.voltage('anode'), result.current('vsrc')];
    let maxAbsoluteError = 0;
    let maxRelativeMagnitudeError = 0;
    let maxPhaseErrorDegrees = 0;
    for (const [i, row] of reference.rows.entries()) {
      expect(Math.abs(result.frequencies[i] / row[0] - 1)).toBeLessThan(1e-10);
      for (const [signal, points] of signals.entries()) {
        const re = row[1 + signal * 2];
        const im = row[2 + signal * 2];
        const magnitude = Math.hypot(re, im);
        const phase = Math.atan2(im, re) * 180 / Math.PI;
        const point = points[i];
        const angle = point.phase * Math.PI / 180;
        maxAbsoluteError = Math.max(maxAbsoluteError,
          Math.hypot(point.magnitude * Math.cos(angle) - re, point.magnitude * Math.sin(angle) - im));
        maxRelativeMagnitudeError = Math.max(maxRelativeMagnitudeError, Math.abs(point.magnitude / magnitude - 1));
        maxPhaseErrorDegrees = Math.max(maxPhaseErrorDegrees, Math.abs(((point.phase - phase + 540) % 360) - 180));
      }
    }
    console.info(name, { maxAbsoluteError, maxRelativeMagnitudeError, maxPhaseErrorDegrees });
    // Same 1e-4 magnitude/radian tolerance as diode-depletion.test.ts.
    expect(maxRelativeMagnitudeError).toBeLessThan(1e-4);
    expect(maxPhaseErrorDegrees * Math.PI / 180).toBeLessThan(1e-4);
  });

  it.each(['static', 'both-caps'])('keeps thermal noise a typed error: %s', async name => {
    const deck = readFileSync(new URL(`${name}.cir`, fixtures), 'utf8');
    await expect(simulate(deck.replace('.ac dec 10 1 1e6', '.noise v(anode) vsrc dec 10 1 1e6')))
      .rejects.toBeInstanceOf(InvalidCircuitError);
    await expect(simulate(deck.replace('.ac dec 10 1 1e6', '.noise v(anode) vsrc dec 10 1 1e6')))
      .rejects.toThrow('Self-heating diode noise');
  });

  it('runs transient thermal junction charge (#1801)', async () => {
    const deck = readFileSync(new URL('junction-cap.cir', fixtures), 'utf8');
    const result = await simulate(deck.replace('.ac dec 10 1 1e6', '.tran 1u 2u'));
    expect(result.transient!.time.at(-1)).toBeCloseTo(2e-6, 12);
    expect(result.transient!.voltage('anode').every(Number.isFinite)).toBe(true);
  });

  it('reproduces ngspice-47 intrinsic CTH0 AC initialization, not a physical thermal pole', () => {
    const rows = (name: string): number[][] => JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), 'utf8')).rows;
    expect(rows('thermal-cap')).toEqual(rows('static'));
    expect(rows('default-cth')).toEqual(rows('static'));
    // An explicit capacitor must still produce the thermal pole in both engines.
    expect(rows('external-thermal-cap')).not.toEqual(rows('static'));
  });
});
