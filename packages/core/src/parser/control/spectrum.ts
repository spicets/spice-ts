/**
 * Numerical kernels of the ngspice-47 `linearize`, `fft` and `psd` control
 * commands (frontend/linear.c, frontend/interp.c, maths/poly/interpolate.c,
 * frontend/com_fft.c, maths/fft/fftext.c).
 *
 * ngspice-47 as distributed (Homebrew, Linux packages) links FFTW3, so `fft`
 * and `psd` follow the HAVE_LIBFFTW3 branch: an unpadded real DFT of the
 * actual sample count, `length / 2 + 1` output bins and a bin spacing of
 * `1 / span`. Any length is transformed exactly (radix-2 when the length is a
 * power of two, Bluestein's chirp-z otherwise), never zero-padded.
 */

/**
 * fftext.c fft_windows: the window weights for samples at `time`, or
 * undefined for an unknown window name. Windows end at `maxt` and span `span`.
 */
export function spectrumWindow(
  window: string, time: ArrayLike<number>, maxt: number, span: number, order: number,
): Float64Array | undefined {
  const length = time.length;
  const win = new Float64Array(length);
  const outside = (index: number): boolean => maxt - time[index] > span;
  const cosine = (index: number, harmonic: number): number => Math.cos((harmonic * 2 * Math.PI * (time[index] - maxt)) / span);
  switch (window) {
    case 'none':
      win.fill(1);
      return win;
    case 'rectangular':
      for (let i = 0; i < length; i++) win[i] = outside(i) ? 0 : 1;
      return win;
    case 'triangle': case 'bartlet': case 'bartlett':
      for (let i = 0; i < length; i++) {
        if (outside(i)) win[i] = 0;
        else if (maxt - time[i] < span / 2) win[i] = (4.0 * (maxt - time[i])) / span;
        else win[i] = 4.0 - (4.0 * (maxt - time[i])) / span;
      }
      return win;
    case 'hann': case 'hanning': case 'cosine':
      for (let i = 0; i < length; i++) win[i] = outside(i) ? 0 : 1.0 - cosine(i, 1);
      return win;
    case 'hamming':
      for (let i = 0; i < length; i++) win[i] = outside(i) ? 0 : 1.0 - (0.46 / 0.54) * cosine(i, 1);
      return win;
    case 'blackman':
      for (let i = 0; i < length; i++) {
        if (outside(i)) continue;
        let value = 1.0;
        value -= (0.50 / 0.42) * cosine(i, 1);
        value += (0.08 / 0.42) * cosine(i, 2);
        win[i] = value;
      }
      return win;
    case 'blackmanharris':
      for (let i = 0; i < length; i++) {
        if (outside(i)) continue;
        let value = 1.0;
        value -= (0.48829 / 0.35875) * cosine(i, 1);
        value += (0.14128 / 0.35875) * cosine(i, 2);
        value -= (0.01168 / 0.35875) * cosine(i, 3);
        win[i] = value;
      }
      return win;
    case 'flattop':
      for (let i = 0; i < length; i++) {
        if (outside(i)) continue;
        let value = 1.0;
        value -= 1.93 * cosine(i, 1);
        value += 1.29 * cosine(i, 2);
        value -= 0.388 * cosine(i, 3);
        value += 0.032 * cosine(i, 4);
        win[i] = value;
      }
      return win;
    case 'gaussian': {
      const sigma = 1.0 / order;
      const scale = 0.83 / sigma;
      for (let i = 0; i < length; i++) {
        win[i] = outside(i) ? 0 : scale * Math.exp(-0.5 * ((time[i] - maxt / 2) / ((sigma * maxt) / 2)) ** 2);
      }
      return win;
    }
    default:
      return undefined;
  }
}

/** Forward DFT of real data: bins 0 .. floor(n/2) (FFTW r2c, unnormalized, e^{-2πi jk/n}). */
export function realDft(input: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const { re, im } = complexDft(input);
  const bins = Math.floor(input.length / 2) + 1;
  return { re: re.slice(0, bins), im: im.slice(0, bins) };
}

/** Unnormalized forward complex DFT, sharing the command's arbitrary-length kernels. */
export function complexDft(input: ArrayLike<number>, imaginary?: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = input.length;
  const re = Float64Array.from(input);
  const im = imaginary ? Float64Array.from(imaginary) : new Float64Array(n);
  if (n > 1) {
    if ((n & (n - 1)) === 0) radix2(re, im);
    else bluestein(re, im);
  }
  return { re, im };
}

/** In-place iterative radix-2 forward FFT; the length must be a power of two. */
function radix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Twiddles computed directly (not by recurrence) to keep round-off at a few ulp.
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let k = 0; k < n >> 1; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = -Math.sin((2 * Math.PI * k) / n);
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** In-place forward DFT of any length via Bluestein's chirp-z transform. */
function bluestein(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  // Chirp w_k = exp(-iπ k²/n); k² is reduced mod 2n in exact integer
  // arithmetic (k² < 2^53 for any length a control vector can have).
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  const period = 2 * n;
  for (let k = 0; k < n; k++) {
    const phase = (k * k) % period;
    chirpRe[k] = Math.cos((Math.PI * phase) / n);
    chirpIm[k] = -Math.sin((Math.PI * phase) / n);
  }
  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    aRe[k] = re[k] * chirpRe[k] - im[k] * chirpIm[k];
    aIm[k] = re[k] * chirpIm[k] + im[k] * chirpRe[k];
  }
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);
  bRe[0] = chirpRe[0];
  bIm[0] = -chirpIm[0];
  for (let k = 1; k < n; k++) {
    bRe[k] = bRe[m - k] = chirpRe[k];
    bIm[k] = bIm[m - k] = -chirpIm[k];
  }
  radix2(aRe, aIm);
  radix2(bRe, bIm);
  for (let k = 0; k < m; k++) {
    const r = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    const i = aRe[k] * bIm[k] + aIm[k] * bRe[k];
    // Conjugate so a second forward transform performs the inverse.
    aRe[k] = r;
    aIm[k] = -i;
  }
  radix2(aRe, aIm);
  for (let k = 0; k < n; k++) {
    const r = aRe[k] / m;
    const i = -aIm[k] / m;
    re[k] = r * chirpRe[k] - i * chirpIm[k];
    im[k] = r * chirpIm[k] + i * chirpRe[k];
  }
}

/** A computed spectrum: frequency scale and one complex vector per input. */
export interface Spectrum {
  frequency: Float64Array;
  vectors: { re: Float64Array; im: Float64Array }[];
}

/**
 * com_fft (FFTW branch): windowed, unpadded DFT scaled to single-sided
 * amplitudes. The span includes one extra last time step.
 */
export function ngspiceFft(time: ArrayLike<number>, inputs: ArrayLike<number>[], window: Float64Array): Spectrum {
  const length = time.length;
  const span = time[length - 1] - time[0] + time[length - 1] - time[length - 2];
  const fpts = Math.trunc(length / 2) + 1;
  const scale = length / 2.0;
  const frequency = Float64Array.from({ length: fpts }, (_, i) => (i * 1.0) / span);
  const vectors = inputs.map(input => {
    const out = realDft(Array.from({ length }, (_, j) => input[j] * window[j]));
    const re = new Float64Array(fpts);
    const im = new Float64Array(fpts);
    re[0] = out.re[0] / scale / 2.0;
    for (let j = 1; j < fpts; j++) {
      re[j] = out.re[j] / scale;
      im[j] = out.im[j] / scale;
    }
    if (length % 2 === 0) {
      re[fpts - 1] = out.re[fpts - 1] / scale / 2.0;
      im[fpts - 1] = 0;
    }
    return { re, im };
  });
  return { frequency, vectors };
}

/**
 * com_psd (FFTW branch): windowed power spectrum normalized by length²,
 * smoothed with a rectangular moving average of `smooth` bins and scaled to
 * V²/Hz (`* fpts / f_max`). The span is the plain time range.
 */
export function ngspicePsd(
  time: ArrayLike<number>, inputs: ArrayLike<number>[], window: Float64Array, smooth: number,
): Spectrum & { totalPower: number[] } {
  const length = time.length;
  const span = time[length - 1] - time[0];
  const fpts = Math.trunc(length / 2) + 1;
  const frequency = Float64Array.from({ length: fpts }, (_, i) => (i * 1.0) / span);
  const totalPower: number[] = [];
  const vectors = inputs.map(input => {
    const out = realDft(Array.from({ length }, (_, j) => input[j] * window[j]));
    const intres = length * length;
    const power = new Float64Array(fpts);
    power[0] = (out.re[0] * out.re[0]) / intres;
    let noipower = power[0];
    for (let j = 1; j < fpts; j++) {
      power[j] = (2.0 * (out.re[j] * out.re[j] + out.im[j] * out.im[j])) / intres;
      noipower += power[j];
      if (!Number.isFinite(noipower)) break;
    }
    if (length % 2 === 0) power[fpts - 1] = (out.re[fpts - 1] * out.re[fpts - 1]) / intres;
    // ngspice adds the last bin a second time to the printed total.
    noipower += power[fpts - 1];
    totalPower.push(noipower);

    const reald = new Float64Array(fpts);
    const hsmooth = smooth >> 1;
    for (let j = 0; j < hsmooth; j++) {
      let sum = 0;
      for (let jj = 0; jj < hsmooth + j; jj++) sum += power[jj];
      reald[j] = sum / (hsmooth + j);
    }
    for (let j = hsmooth; j < fpts - hsmooth; j++) {
      let sum = 0;
      for (let jj = 0; jj < smooth; jj++) sum += power[j - hsmooth + jj];
      reald[j] = sum / smooth;
    }
    for (let j = fpts - hsmooth; j < fpts; j++) {
      let sum = 0;
      for (let jj = 0; jj < fpts + hsmooth - j - 1; jj++) sum += power[j - hsmooth + jj + 1];
      reald[j] = sum / (fpts + hsmooth - j - 1);
    }
    const re = Float64Array.from(reald, value => (value * fpts) / frequency[fpts - 1]);
    return { re, im: new Float64Array(fpts) };
  });
  return { frequency, vectors, totalPower };
}

const EDGE_FACTOR = 1e-3;

/**
 * maths/poly/interpolate.c ft_interpolate with degree 1, as `linearize`
 * (interp.c lincopy) calls it: a piecewise-linear fit through consecutive old
 * points, with vertical edges (repeated scale values) nudged by 1e-3 of the
 * previous interval. Grid points past the last old point stay 0 except the
 * final one, which takes the last old value. Returns undefined when either
 * vector has fewer than two points.
 */
export function ngspiceLinearInterpolate(
  data: ArrayLike<number>, oscale: ArrayLike<number>, nscale: ArrayLike<number>,
): Float64Array | undefined {
  const olen = oscale.length;
  const nlen = nscale.length;
  if (olen < 2 || nlen < 2) return undefined;
  const ndata = new Float64Array(nlen);
  let sign = 1;
  for (let i = 0; i < olen - 1; i++) {
    if (oscale[i + 1] < oscale[i]) {
      sign = -1;
      break;
    } else if (oscale[i + 1] > oscale[i]) {
      sign = 1;
      break;
    }
  }

  const xdata = [0, 0];
  const ydata = [0, 0];
  let l = 0;
  let i = 0;
  if (sign > 0) {
    while (l < olen - 1 && oscale[l + 1] < nscale[0]) l++;
  } else {
    while (l < olen - 1 && oscale[l + 1] > nscale[0]) l++;
  }
  ydata[0] = data[l];
  xdata[0] = oscale[l];
  do {
    if (oscale[l + 1] === oscale[l]) {
      // i is always 0 here for degree 1: ignore the first point of the edge.
      ydata[0] = data[++l];
    }
    xdata[++i] = oscale[++l];
    ydata[i] = data[l];
  } while (i < 1 && l < olen - 1);

  // ft_polyfit degree 1 fast path, evaluated by ft_peval.
  let c0 = 0;
  let c1 = 0;
  const fit = (): void => {
    c0 = (xdata[1] * ydata[0] - xdata[0] * ydata[1]) / (xdata[1] - xdata[0]);
    c1 = (ydata[1] - ydata[0]) / (xdata[1] - xdata[0]);
  };
  const putinterval = (last: number, oval: number): number => {
    let end = last + 1;
    for (; end < nlen; end++) if (nscale[end] * sign > oval * sign) break;
    end--;
    for (let k = last + 1; k <= end; k++) {
      let y = c1;
      y *= nscale[k];
      y += c0;
      ndata[k] = y;
    }
    return end;
  };

  fit();
  let lastone = putinterval(-1, xdata[1]);
  for (++l; l < olen && lastone < nlen - 1; l++) {
    const out = xdata[0];
    xdata[0] = xdata[1];
    ydata[0] = ydata[1];
    ydata[1] = data[l];
    xdata[1] = oscale[l];
    if (oscale[l] === xdata[0]) {
      const diff = xdata[0] - out;
      xdata[0] -= sign * diff * EDGE_FACTOR;
    }
    if (l < olen - 1) {
      if (sign > 0 && xdata[1] < nscale[lastone + 1]) continue;
      if (sign < 0 && xdata[1] > nscale[lastone + 1]) continue;
    }
    fit();
    lastone = putinterval(lastone, xdata[1]);
  }
  lastone = putinterval(lastone, oscale[olen - 1]);
  if (lastone < nlen - 1) ndata[nlen - 1] = data[olen - 1];
  return ndata;
}
