import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

// Reference: ngspice-47 (Homebrew/FFTW3), ngspice -b on these identical decks.
function fftDeck(control: string): string {
  return `* fft vector function probe
v1 1 0 0
r1 1 0 1k
.control
set numdgt=17
tran 1 7
linearize
let v = cos(2*pi*vector(8)/8+pi/6)
${control}
.endc
.end`;
}

const expressions = [
  'length(y)', 'fft_scale[1]', 'real(y[1])', 'imag(y[1])', 'mag(y)[1]', 'ph(y)[1]',
];
function echoes(expressions: string[]): string {
  return expressions.map((expression, index) => `let p${index} = ${expression}\necho $&p${index}`).join('\n');
}

async function probe(control: string, expressionsToPrint = expressions): Promise<number[]> {
  const result = await simulate(fftDeck(`${control}\n${echoes(expressionsToPrint)}`));
  return result.control!.output.slice(-expressionsToPrint.length).map(Number);
}

function close(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value, `index ${i}`).toBeCloseTo(expected[i], 12));
}

describe('fft() vector function (#1446)', () => {
  it('returns real-input single-sided magnitude, phase and fft_scale without changing plots (ngspice-47)', async () => {
    close(await probe('let y = fft(v)'), [5, 1 / 7, 0.8660254037844387, 0.4999999999999998, 1, 0.5235987755982986]);
  });

  it('retains both halves for complex input and inverts them with ifft() (ngspice-47)', async () => {
    close(await probe('let y = fft(v+j(0))\nlet z = ifft(y)', [
      ...expressions, 'real(y[7])', 'imag(y[7])', 'length(z)', 'real(z[0])', 'imag(z[0])', 'ifft_scale[1]',
    ]), [8, 1 / 7, 0.4330127018922194, 0.2499999999999999, 0.5, 0.5235987755982986,
      0.4330127018922194, -0.2499999999999999, 8, 0.8660254037844387, 0, 1]);
  });

  it('honours specwindow=hanning using the function span (ngspice-47)', async () => {
    close(await probe('set specwindow=hanning\nlet y = fft(v)'), [
      5, 1 / 7, 0.8093290554952043, 0.4513146102082156, 0.9266598067555067, 0.5086902602307372,
    ]);
  });

  it('transforms nonzero imaginary input on an odd, unpadded grid', async () => {
    const deck = fftDeck(`let v = exp(j(2*pi*vector(7)/7))
let y = fft(v)
let z = ifft(y)
${echoes(['length(y)', 'fft_scale[1]', 'real(y[1])', 'imag(y[1])', 'real(y[6])', 'real(z[0])', 'imag(z[0])'])}`)
      .replace('tran 1 7', 'tran 1 6');
    const result = await simulate(deck);
    close(result.control!.output.slice(-7).map(Number), [7, 1 / 6, 1, 0, 0, 1, 0]);
  });

  it('rejects unknown windows, real inverse input and mismatched forward scales', async () => {
    await expect(simulate(fftDeck('set specwindow=invalid\nlet y=fft(v)'))).rejects.toThrow('unknown window type invalid');
    await expect(simulate(fftDeck('let y=ifft(v)'))).rejects.toThrow('ifft() needs complex input');
    await expect(simulate(fftDeck('let y=fft(vector(3))'))).rejects.toThrow('matching plot scale');
  });

  it('uses the inverse input length on a time plot, even after a real-input fft()', async () => {
    close(await probe('let y=fft(v)\nlet z=ifft(y)', ['length(z)', 'ifft_scale[4]']), [5, 4]);
  });

  it('runs the identical unmodified corpus-f FFT_Leakage.cir', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/various/FFT_Leakage.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.control!.output.some(line => line.includes('THD_percent='))).toBe(true);
  });
});
