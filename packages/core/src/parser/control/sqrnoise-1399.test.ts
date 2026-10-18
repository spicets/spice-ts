import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const rc = `sqrnoise RC reference
V1 in 0 dc 0 ac 1
R1 in out 1k
C1 out 0 1u`;

async function run(setting = '') {
  return simulate(`${rc}
.control
${setting}
set numdgt=17
noise v(out) V1 dec 10 1 1000
print onoise_total inoise_total
echo $&onoise_total $&inoise_total
setplot noise1
let first_out = onoise_spectrum[0]
let first_in = inoise_spectrum[0]
echo $&first_out $&first_in
.endc
.end`);
}

describe('set sqrnoise (#1399)', () => {
  it('squares both spectra and integrated totals, including the structured result', async () => {
    const normal = await run();
    const squared = await run('set sqrnoise');
    for (const key of ['outputNoiseDensity', 'inputNoiseDensity'] as const) {
      squared.noise![key].forEach((value, index) => {
        expect(Math.abs(value / normal.noise![key][index] ** 2 - 1)).toBeLessThan(1e-12);
      });
    }
    for (const key of ['integratedOutputNoise', 'integratedInputNoise'] as const) {
      expect(Math.abs(squared.noise![key]! / normal.noise![key]! ** 2 - 1)).toBeLessThan(1e-12);
    }
    expect(squared.control!.runs[0].result.noise).toBe(squared.noise);
    expect(squared.noise!.squared).toBe(true);
    expect(normal.noise!.squared).toBe(false);
    expect(squared.control!.output[0].split(' ').map(Number)).toEqual([
      squared.noise!.integratedOutputNoise, squared.noise!.integratedInputNoise,
    ]);
    expect(squared.control!.output[1].split(' ').map(Number)).toEqual([
      squared.noise!.outputNoiseDensity[0], squared.noise!.inputNoiseDensity[0],
    ]);
  });

  it('matches ngspice-47 integrated power on the identical RC deck', async () => {
    const { noise } = await run('set sqrnoise');
    // ngspice-47 -b on this exact deck; power totals (V^2), not RMS amplitudes.
    // Allow the existing sub-ppm Boltzmann-constant difference (core uses SI 2019).
    expect(Math.abs(noise!.integratedOutputNoise! / 3.70198711269562977e-15 - 1)).toBeLessThan(5e-7);
    expect(Math.abs(noise!.integratedInputNoise! / 1.98147319167149431e-14 - 1)).toBeLessThan(5e-7);
  });

  it('unset restores amplitude units without changing an earlier plot', async () => {
    const result = await simulate(`${rc}
.control
set sqrnoise
noise v(out) V1 dec 10 1 1000
unset sqrnoise
noise v(out) V1 dec 10 1 1000
setplot noise2
echo $&onoise_total
setplot noise4
echo $&onoise_total
.endc
.end`);
    const [power, amplitude] = result.control!.runs.map(run => run.result.noise!);
    expect(Math.abs(power.integratedOutputNoise! / amplitude.integratedOutputNoise! ** 2 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(Number(result.control!.output[0]) / power.integratedOutputNoise! - 1)).toBeLessThan(1e-5);
    expect(Math.abs(Number(result.control!.output[1]) / amplitude.integratedOutputNoise! - 1)).toBeLessThan(1e-5);
  });

  it('supports current-input power units and a zero-width sweep without totals', async () => {
    const deck = `current-input sqrnoise
I1 in 0 dc 0 ac 1
R1 in out 1k
R2 in 0 2k
C1 out 0 1u`;
    const solve = (setting: string) => simulate(`${deck}
.control
${setting}
noise v(out) I1 dec 1 10 10
echo $curplottitle
.endc
.end`);
    const normal = (await solve('')).noise!;
    const result = await solve('set sqrnoise');
    expect(result.noise!.integratedOutputNoise).toBeUndefined();
    expect(result.noise!.integratedInputNoise).toBeUndefined();
    expect(result.noise!.inputNoiseDensity[0]).toBe(normal.inputNoiseDensity[0] ** 2);
    expect(result.noise!.outputNoiseDensity[0]).toBe(normal.outputNoiseDensity[0] ** 2);
    expect(result.control!.output).toEqual(['Noise Spectral Density Curves - (V^2 or A^2)/Hz']);
  });

  it('applies to run and the deck’s implicit batch run', async () => {
    const result = await simulate(`${rc}
.noise v(out) V1 dec 10 1 1000
.control
set sqrnoise
run
.endc
.end`);
    const run = result.control!.runs[0].result;
    expect(run.noise!.squared).toBe(true);
    expect(result.noise!.squared).toBe(true);
    expect(result.noise!.integratedOutputNoise).toBe(run.noise!.integratedOutputNoise);
  });
});
