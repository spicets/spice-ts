import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { InvalidCircuitError } from '../../errors.js';

// ngspice src/xspice/mif/mifnoise.c:262-321,340-364 (not gain/cfunc.mod):
// voltage noise is output-referred; current noise is injected at the input.
const deck = (params: string, input = 'Vin in 0 ac 1', ports = 'in out') => [
  'gain noise', input, `a1 ${ports} amp`, `.model amp gain(gain=5 ${params})`,
  '.noise v(out) Vin dec 1 200 20000', '.end',
].join('\n');

function relative(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-6);
}

describe('XSPICE declarative gain noise', () => {
  it('matches output voltage white and flicker noise below, at and above the corner', async () => {
    const { noise } = await simulate(deck('noise_voltage=1u noise_corner=2k noise_exponent=2'));
    expect(noise).toBeDefined();
    noise!.frequencies.forEach((f, i) => {
      const expected = 1e-6 * Math.sqrt(1 + (2000 / f) ** 2);
      relative(noise!.outputNoiseDensity[i], expected);
      relative(noise!.inputNoiseDensity[i], expected / 5);
    });
    // Independent white/flicker integrations, not log integration of their sum.
    const power = 1e-12 * (20000 - 200 + 2000 ** 2 * (1 / 200 - 1 / 20000));
    relative(noise!.integratedOutputNoise!, Math.sqrt(power));
    relative(noise!.integratedInputNoise!, Math.sqrt(power) / 5);
  });

  it('injects noise_current at the input with the same corner law', async () => {
    // Noiseless source resistance isolates gain's current noise.
    const input = 'Vin src 0 ac 1\nRsrc src in 1k noisy=0';
    const { noise } = await simulate(deck('noise_current=1n noise_corner=2k noise_exponent=2', input));
    noise!.frequencies.forEach((f, i) => {
      const expected = 1e-9 * 1000 * Math.sqrt(1 + (2000 / f) ** 2);
      relative(noise!.outputNoiseDensity[i], expected * 5);
      relative(noise!.inputNoiseDensity[i], expected);
    });
    const power = 1e-12 * (20000 - 200 + 2000 ** 2 * (1 / 200 - 1 / 20000));
    relative(noise!.integratedOutputNoise!, Math.sqrt(power) * 5);
    relative(noise!.integratedInputNoise!, Math.sqrt(power));
  });

  it('handles differential voltage output and white-only voltage noise', async () => {
    const { noise } = await simulate(deck('noise_voltage=1u', 'Vin in 0 ac 1', 'in %vd(out ref)')
      .replace('.noise v(out)', 'Rref ref 0 1k noisy=0\n.noise v(out,ref)'));
    noise!.outputNoiseDensity.forEach(value => relative(value, 1e-6));
  });

  it('keeps a gain without noise parameters noiseless', async () => {
    const { noise } = await simulate(deck(''));
    expect(noise!.outputNoiseDensity).toEqual([0, 0, 0]);
  });

  it('adds independent voltage and current noise powers, including at negative gain', async () => {
    const { noise } = await simulate(deck('noise_voltage=1u noise_current=1n',
      'Vin src 0 ac 1\nRsrc src in 1k noisy=0').replace('gain=5', 'gain=-5'));
    noise!.outputNoiseDensity.forEach(value => relative(value, Math.sqrt(26) * 1e-6));
    noise!.inputNoiseDensity.forEach(value => relative(value, Math.sqrt(26) * 1e-6 / 5));
  });

  it('does not attach declarative voltage noise to a current output (ngspice port rule)', async () => {
    const { noise } = await simulate(deck('noise_voltage=1u', 'Vin in 0 ac 1', 'in %i(out)')
      .replace('.noise v(out)', 'Rload out 0 1k noisy=0\n.noise v(out)'));
    expect(noise!.outputNoiseDensity).toEqual([0, 0, 0]);
  });

  it('keeps unsupported XSPICE noise analyses typed', () => {
    expect(() => parse(deck('').replace('gain(gain=5 )', 's_xfer(num_coeff=[1] den_coeff=[1 1])')).compile())
      .toThrow(InvalidCircuitError);
  });
});
