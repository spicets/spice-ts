import { describe, expect, it } from 'vitest';
import { parseTitleless as parse } from '../parser/index.js';
import { simulate } from '../simulate.js';

// Original MIT deck. The three output variants and ngspice-47 references are
// documented byte-for-byte in benchmarks/diode-differential-noise.md.
const deck = (output: string) => `* MIT original differential diode noise #2212
V1 in 0 DC 1 AC 1
R1 in outp 1k
R2 outn 0 1k
D1 outp outn DMOD
.model DMOD D(IS=1e-14 N=1 KF=1e-10 AF=1)
.noise v(${output}) V1 dec 3 100 10k
.end
`;
const differentialOutput = [1.742231870194275e-6, 1.186969004486104e-6, 8.086729342544092e-7, 5.509429927272854e-7, 3.753538784191613e-7, 2.557267755687641e-7, 1.742263195007093e-7];
const differentialInput = [2.783314531554931e-5, 1.896250513614509e-5, 1.291901019428876e-5, 8.801627750875790e-6, 5.996491753781644e-6, 4.085380727588565e-6, 2.783364574725535e-6];
const groundOutput = [8.711206922196405e-7, 5.934914847205039e-7, 4.043467159282667e-7, 2.754865393116149e-7, 1.876990184954151e-7, 1.278957933974562e-7, 8.716071726848260e-8];
const groundInput = [1.639609101967337e-6, 1.117059953894994e-6, 7.610547673908646e-7, 5.185162530967859e-7, 3.532840189701551e-7, 2.407233679910461e-7, 1.640524747532609e-7];

// Same corpus rule for every vector, including integrated totals: maximum
// absolute error divided by max(reference peak, 1e-12), bounded by 1%.
function expectCorpusMatch(actual: number[], reference: number[]) {
  expect(actual).toHaveLength(reference.length);
  const maxError = Math.max(...actual.map((value, index) => Math.abs(value - reference[index])));
  expect(maxError / Math.max(1e-12, ...reference.map(Math.abs))).toBeLessThanOrEqual(0.01);
}

describe('differential diode noise', () => {
  it.each([
    ['outp,outn', differentialOutput, differentialInput, 3.738784321513111e-5, 5.972920660243001e-4],
    ['outn,outp', differentialOutput, differentialInput, 3.738784321513111e-5, 5.972920660243001e-4],
    ['outp,0', groundOutput, groundInput, 1.869611608321786e-5, 3.518952353591076e-5],
  ])('matches ngspice-47 for %s', async (output, out, input, outTotal, inputTotal) => {
    const result = (await simulate(deck(output))).noise!;
    expectCorpusMatch(result.outputNoiseDensity, out);
    expectCorpusMatch(result.inputNoiseDensity, input);
    expectCorpusMatch([result.integratedOutputNoise!], [outTotal]);
    expectCorpusMatch([result.integratedInputNoise!], [inputTotal]);
  });

  it('preserves output and input noise when terminals are swapped', async () => {
    const forward = (await simulate(deck('outp,outn'))).noise!;
    const reverse = (await simulate(deck('outn,outp'))).noise!;
    expect(reverse.outputNoiseDensity).toEqual(forward.outputNoiseDensity);
    expect(reverse.inputNoiseDensity).toEqual(forward.inputNoiseDensity);
    expect(reverse.integratedOutputNoise).toBe(forward.integratedOutputNoise);
    expect(reverse.integratedInputNoise).toBe(forward.integratedInputNoise);
  });

  it('matches single-ended output when the reference is ground', async () => {
    const grounded = (await simulate(deck('outp,0'))).noise!;
    const single = (await simulate(deck('outp'))).noise!;
    expect(grounded.outputNoiseDensity).toEqual(single.outputNoiseDensity);
    expect(grounded.inputNoiseDensity).toEqual(single.inputNoiseDensity);
    expect(grounded.integratedOutputNoise).toBe(single.integratedOutputNoise);
    expect(grounded.integratedInputNoise).toBe(single.integratedInputNoise);
  });

  it('returns zero for the same output node', async () => {
    const result = await simulate(deck('outp,outp'));
    expect(result.warnings[0]?.code).toBe('noise-degenerate-output');
    expect(result.noise!.outputNoiseDensity).toEqual(Array(7).fill(0));
    expect(result.noise!.inputNoiseDensity).toEqual(Array(7).fill(0));
    expect(result.noise!.integratedOutputNoise).toBe(0);
    expect(result.noise!.integratedInputNoise).toBe(0);
  });

  it('matches the analytical differential diode shot-noise transfer', async () => {
    const shotDeck = deck('outp,outn').replace('R1 in outp 1k', 'R1 in outp 1k noisy=0')
      .replace('R2 outn 0 1k', 'R2 outn 0 1k noisy=0')
      .replace(' KF=1e-10 AF=1', '');
    const result = (await simulate(shotDeck)).noise!;
    // Solve 1 V = diode voltage + 2k * diode current independently.
    const vt = 1.38064852e-23 / 1.6021766208e-19 * 300.15;
    let voltage = 0.6;
    for (let i = 0; i < 30; i++) {
      const exponential = Math.exp(voltage / vt);
      voltage -= (voltage + 2000e-14 * (exponential - 1) - 1)
        / (1 + 2000e-14 * exponential / vt);
    }
    const current = 1e-14 * (Math.exp(voltage / vt) - 1);
    const impedance = 1 / (1 / 2000 + (current + 1e-14) / vt);
    const expected = Math.sqrt(2 * 1.602176634e-19 * current) * impedance;
    expectCorpusMatch(result.outputNoiseDensity, Array(7).fill(expected));
  });

  it('continues rejecting diode series-resistance noise', async () => {
    await expect(simulate(deck('outp,outn').replace('IS=1e-14', 'IS=1e-14 RS=10')))
      .rejects.toThrow(".noise does not support diode series-resistance noise for 'D1'");
  });

  it('continues rejecting current noise output and invalid input sources', async () => {
    expect(() => parse('.noise i(V1) V1 dec 3 100 10k')).toThrow('Unsupported .noise form');
    await expect(simulate(deck('outp,outn').replace(' V1 dec', ' missing dec')))
      .rejects.toThrow(".noise input source 'missing' is not an independent voltage or current source");
  });
});
