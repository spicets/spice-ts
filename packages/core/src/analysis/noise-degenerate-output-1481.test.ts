import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const deck = `Unreferenced noise output
V1 in 0 AC 1
R1 in out 1k
R2 out 0 1k
.noise v(out,out) V1 lin 3 100 300
.end
`;

const withOutput = (output: string) => simulate(deck.replace('v(out,out)', output));

describe('.noise degenerate output warning (#1481)', () => {
  it.each([
    ['v(out,out)', 'out', 'out'],
    ['v(out,OUT)', 'out', 'OUT'],
    ['v(0,0)', '0', '0'],
    ['v(0)', '0', '0'],
    ['v(missing,missing)', 'missing', 'missing'],
  ])('warns once and preserves zero spectra and totals for %s', async (output, positive, negative) => {
    const result = await withOutput(output);
    expect(result.warnings).toEqual([{
      type: 'noise',
      code: 'noise-degenerate-output',
      node: positive,
      message: `.noise output nodes '${positive}' and '${negative}' resolve to the same node; output and input noise spectra and totals are zero.`,
    }]);
    expect(result.noise!.frequencies).toEqual([100, 200, 300]);
    expect(result.noise!.outputNoiseDensity).toEqual([0, 0, 0]);
    expect(result.noise!.inputNoiseDensity).toEqual([0, 0, 0]);
    expect(result.noise!.integratedOutputNoise).toBe(0);
    expect(result.noise!.integratedInputNoise).toBe(0);
  });

  it('keeps single-ended and explicit-ground controls unchanged without warnings', async () => {
    const single = await withOutput('v(out)');
    const differential = await withOutput('v(out,0)');
    expect(single.warnings).toEqual([]);
    expect(differential.warnings).toEqual([]);
    expect(differential.noise!.outputNoiseDensity).toEqual(single.noise!.outputNoiseDensity);
    expect(differential.noise!.inputNoiseDensity).toEqual(single.noise!.inputNoiseDensity);
    expect(differential.noise!.integratedOutputNoise).toBe(single.noise!.integratedOutputNoise);
    expect(differential.noise!.integratedInputNoise).toBe(single.noise!.integratedInputNoise);
    // Same-byte deck references from ngspice-47 (#1481); both controls have gain 1/2.
    const relative = (actual: number, expected: number) => Math.abs(actual - expected) / expected;
    for (let index = 0; index < 3; index++) {
      expect(relative(single.noise!.outputNoiseDensity[index], 2.8788944172303367e-9)).toBeLessThan(2e-6);
      expect(relative(single.noise!.inputNoiseDensity[index], 5.757788834460673e-9)).toBeLessThan(2e-6);
    }
    expect(relative(single.noise!.integratedOutputNoise!, 4.07137152948733e-8)).toBeLessThan(2e-6);
    expect(relative(single.noise!.integratedInputNoise!, 8.14274305897466e-8)).toBeLessThan(2e-6);
  });

  it.each(['v(missing,absent)', 'v(out,missing)'])('does not conflate distinct unreferenced terminals for %s', async output => {
    expect((await withOutput(output)).warnings).toEqual([]);
  });
});
