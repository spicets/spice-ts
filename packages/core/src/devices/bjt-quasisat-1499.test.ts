import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { UnsupportedModelParameterError } from '../errors.js';
const oracle = JSON.parse(readFileSync(
  new URL('./fixtures/bjt-quasisat-1499.json', import.meta.url), 'utf8',
)) as { name: string; deck: string; points: [number, number, number][] }[];

// Original MIT regression decks. ngspice-47, spice-heavy ngspice -b <deck>:
// .control: set numdgt=17; set wr_singlescale; save all @q1[vbc]; run;
// wrdata <file> i(VCE) v(b) @q1[vbc] i(VBE)
// Intrinsic collector = V(b) + I(VBE)*RB - polarity*@q1[vbc].
// Saving vbc explicitly is essential: otherwise ngspice returns only its last value.
// Equations: https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/bjt/bjtload.c
// Fixtures are original MIT decks, not redistributed upstream examples.
describe('static Kull epi-region model (#1499)', () => {
  it.each(oracle)('$name matches ngspice-47 current and intrinsic collector', async fixture => {
    const result = await simulate(fixture.deck);
    const currents = result.dcSweep?.current('VCE') ?? [result.dc!.current('VCE')];
    const voltages = result.dcSweep?.voltage('Q1.collector') ?? [result.dc!.voltage('Q1.collector')];
    expect(currents.length).toBe(fixture.points.length);
    let worstCurrent = 0;
    let worstVoltage = 0;
    for (const [index, [, ic, vc]] of fixture.points.entries()) {
      for (const [actual, expected] of [[currents[index], ic], [voltages[index], vc]]) {
        expect(Number.isFinite(actual)).toBe(true);
        expect(Number.isFinite(expected)).toBe(true);
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 + 1e-6 * Math.abs(expected));
      }
      worstCurrent = Math.max(worstCurrent, Math.abs(currents[index] - ic) / Math.abs(ic));
      worstVoltage = Math.max(worstVoltage, Math.abs(voltages[index] - vc) / Math.abs(vc));
    }
    console.info(fixture.name, { worstCurrent, worstVoltage });
  });

  it('keeps epi parameters inert when RCO=0', async () => {
    const baseline = await simulate(oracle[0].deck.replace('RCO=50 VO=10 GAMMA=1e-11', ''));
    const disabled = await simulate(oracle[0].deck.replace('RCO=50 VO=10 GAMMA=1e-11',
      'RCO=0 VO=0 GAMMA=-1'));
    expect(disabled.dcSweep!.current('VCE')).toEqual(baseline.dcSweep!.current('VCE'));
  });

  it.each(['.tran 1n 10n', '.noise v(c) VBE dec 1 1 10'])(
    'rejects unsupported %s with a typed analysis-specific error', async analysis => {
      const deck = oracle[0].deck.replace('.dc VCE 0 5 0.05', analysis);
      await expect(simulate(deck)).rejects.toBeInstanceOf(UnsupportedModelParameterError);
      await expect(simulate(deck)).rejects.toThrow(new RegExp(analysis.split(' ')[0].slice(1)));
    },
  );
});
