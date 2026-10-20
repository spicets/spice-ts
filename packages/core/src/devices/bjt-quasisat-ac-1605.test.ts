import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { UnsupportedModelParameterError } from '../errors.js';

// Original MIT decks, generated with installed ngspice-47 on identical netlists.
// spice-heavy ngspice -b <deck>, .control: set numdgt=17; set wr_singlescale;
// run; wrdata <file> vm(4) vp(4). vp is radians, spice-ts phase is degrees.
// Equations: ngspice-47 src/spicelib/devices/bjt/{bjtload,bjtacld}.c.
const oracle = JSON.parse(readFileSync(
  new URL('./fixtures/bjt-quasisat-ac-1605.json', import.meta.url), 'utf8',
)) as { name: string; deck: string; points: [number, number, number][] }[];

describe('BJT quasi-saturation small-signal AC (#1605)', () => {
  it.each(oracle)('$name matches ngspice-47 magnitude and phase at every frequency', async fixture => {
    const result = await simulate(fixture.deck);
    const response = result.ac!.voltage('4');
    expect(response).toHaveLength(fixture.points.length);
    let worstMagnitude = 0;
    let worstPhase = 0;
    for (const [index, [frequency, magnitude, radians]] of fixture.points.entries()) {
      expect(result.ac!.frequencies[index] / frequency).toBeCloseTo(1, 10);
      const magnitudeError = Math.abs(response[index].magnitude / magnitude - 1);
      const phaseError = Math.abs(((response[index].phase - radians * 180 / Math.PI + 540) % 360) - 180);
      expect(magnitudeError, `magnitude @ ${frequency}`).toBeLessThanOrEqual(1e-5);
      expect(phaseError, `phase @ ${frequency}`).toBeLessThanOrEqual(1e-3);
      worstMagnitude = Math.max(worstMagnitude, magnitudeError);
      worstPhase = Math.max(worstPhase, phaseError);
    }
    console.info(fixture.name, { worstMagnitude, worstPhase });
  });

  it.each([
    ['disabled RCO', 'rco=50', 'rco=0'],
    ['reverse epi voltage', 'DC 5', 'DC -0.3'],
  ])('keeps QCO inert for %s', async (_name, from, to) => {
    const deck = oracle[1].deck.replace(from, to);
    const charged = await simulate(deck);
    const uncharged = await simulate(deck.replace('qco=1e-10', 'qco=0'));
    expect(charged.ac!.voltage('4')).toEqual(uncharged.ac!.voltage('4'));
  });

  it('continues rejecting transient QCO integration with the same typed error', async () => {
    const deck = oracle[1].deck.replace('.ac dec 5 1k 1g', '.tran 1n 10n');
    await expect(simulate(deck)).rejects.toBeInstanceOf(UnsupportedModelParameterError);
    await expect(simulate(deck)).rejects.toThrow(
      'BJT quasi-saturation supports only static op/dc; tran is unsupported',
    );
  });
});
