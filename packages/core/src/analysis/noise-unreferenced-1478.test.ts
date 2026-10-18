import { describe, expect, it } from 'vitest';
import { InvalidCircuitError, ParseError } from '../errors.js';
import { simulate } from '../simulate.js';

// ngspice-47, identical deck bytes: ngspice -b -r reference.raw minimal.cir.
// inp2dot.c:53-65 inserts both output terminals, even without any device.
// noisean.c:439-446 floors the squared gain at N_MINGAIN, including zero.
const deck = `Unreferenced noise output
V1 in 0 AC 1
R1 in out 1k
R2 out 0 1k
.noise v(missing) V1 lin 3 100 300
.end
`;

describe('.noise unreferenced output terminals (#1478)', () => {
  it.each(['v(missing)', 'v(missing,absent)', 'v(out,out)', 'v(0)'])('matches ngspice-47 zero noise for %s', async output => {
    const noise = (await simulate(deck.replace('v(missing)', output))).noise!;
    expect(noise.frequencies).toEqual([100, 200, 300]);
    expect(noise.outputNoiseDensity).toEqual([0, 0, 0]);
    expect(noise.inputNoiseDensity).toEqual([0, 0, 0]);
    expect(noise.integratedOutputNoise).toBe(0);
    expect(noise.integratedInputNoise).toBe(0);
  });

  it.each(['v(out,missing)', 'v(missing,out)'])('preserves the connected contribution for %s', async output => {
    const noise = (await simulate(deck.replace('v(missing)', output))).noise!;
    const relative = (actual: number, expected: number) => Math.abs(actual - expected) / expected;
    for (let index = 0; index < 3; index++) {
      expect(relative(noise.outputNoiseDensity[index], 2.8788944172303367e-9)).toBeLessThan(2e-6);
      expect(relative(noise.inputNoiseDensity[index], 5.757788834460673e-9)).toBeLessThan(2e-6);
    }
    expect(relative(noise.integratedOutputNoise!, 4.07137152948733e-8)).toBeLessThan(2e-6);
    expect(relative(noise.integratedInputNoise!, 8.14274305897466e-8)).toBeLessThan(2e-6);
  });

  it('keeps structured errors for invalid output specs and input sources', async () => {
    await expect(simulate(deck.replace('v(missing)', 'i(V1)'))).rejects.toBeInstanceOf(ParseError);
    await expect(simulate(deck.replace(') V1 lin', ') absent lin')))
      .rejects.toEqual(new InvalidCircuitError(
        ".noise input source 'absent' is not an independent voltage or current source",
      ));
  });
});
