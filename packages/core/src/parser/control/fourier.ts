import type { FourierResult } from '../../results.js';
import { ngspiceLinearInterpolate } from './spectrum.js';

/** ngspice-47 frontend/fourier.c:69-152, 292-362. The grid excludes the last endpoint. */
export function ngspiceFourier(
  vector: string, time: Float64Array, values: Float64Array, fundamental: number,
  nfreqs: number, gridSize: number, degree: number, periods: number,
): FourierResult {
  let data = values;
  if (degree > 0) {
    const span = periods / fundamental;
    const end = time[time.length - 1];
    if (end - time[0] < span) throw new Error(`(${periods} * wavelength) longer than time span`);
    if (degree >= time.length) throw new Error("too few points to calculate polynomial");
    gridSize *= periods;
    const grid = Float64Array.from({ length: gridSize }, (_, i) => end - span + i * span / gridSize);
    const interpolated = degree === 1 ? ngspiceLinearInterpolate(values, time, grid) : polynomialInterpolate(values, time, grid, degree);
    if (!interpolated) throw new Error("can't interpolate");
    data = interpolated;
  } else {
    gridSize = values.length;
  }
  const harmonics: FourierResult['harmonics'] = [];
  let distortion = 0;
  for (let harmonic = 0; harmonic < nfreqs; harmonic++) {
    let sine = 0;
    let cosine = 0;
    for (let i = 0; i < data.length; i++) {
      const angle = harmonic * 2 * Math.PI * periods * i / data.length;
      sine += data[i] * Math.sin(angle);
      cosine += data[i] * Math.cos(angle);
    }
    const magnitude = harmonic === 0 ? cosine / data.length : Math.hypot(2 * sine / data.length, 2 * cosine / data.length);
    const phase = harmonic === 0 ? 0 : Math.atan2(cosine, sine) * 180 / Math.PI;
    const normalizedMagnitude = harmonic === 0 ? 0 : magnitude / (harmonic === 1 ? magnitude : harmonics[1].magnitude);
    const normalizedPhase = harmonic < 2 ? 0 : phase - harmonics[1].phase;
    harmonics.push({ harmonic, frequency: harmonic * fundamental, magnitude, phase, normalizedMagnitude, normalizedPhase });
    if (harmonic > 1) distortion += normalizedMagnitude ** 2;
  }
  return { vector, fundamental, gridSize, degree, periods, harmonics, thd: 100 * Math.sqrt(distortion) };
}

/** Sliding windows follow maths/poly/interpolate.c:74-188; Newton form avoids ill-conditioned absolute-time powers. */
function polynomialInterpolate(data: Float64Array, time: Float64Array, grid: Float64Array, degree: number): Float64Array {
  const output = new Float64Array(grid.length);
  const middle = Math.floor((degree + 1) / 2);
  let start = 0;
  while (start < time.length - degree - 1 && time[start + middle] < grid[0]) start++;
  const x = Array.from(time.slice(start, start + degree + 1));
  const y = Array.from(data.slice(start, start + degree + 1));
  let last = start + degree;
  // ngspice turns duplicate-scale vertical edges into short ramps.
  for (let i = 1; i <= degree; i++) {
    if (x[i] === x[i - 1]) {
      if (i === 1) throw new Error("can't interpolate duplicate initial scale");
      x[i - 1] -= (x[i - 1] - x[i - 2]) * 1e-3;
    }
  }
  for (let k = 0; k < grid.length; k++) {
    while (x[middle] < grid[k] && last < time.length - 1) {
      const out = x.shift()!;
      y.shift();
      x.push(time[++last]);
      y.push(data[last]);
      if (x[degree] === x[degree - 1]) x[degree - 1] -= (x[degree - 1] - (degree > 1 ? x[degree - 2] : out)) * 1e-3;
    }
    const coefficients = y.slice();
    for (let order = 1; order <= degree; order++) {
      for (let i = degree; i >= order; i--) coefficients[i] = (coefficients[i] - coefficients[i - 1]) / (x[i] - x[i - order]);
    }
    let value = coefficients[degree];
    for (let i = degree - 1; i >= 0; i--) value = value * (grid[k] - x[i]) + coefficients[i];
    output[k] = value;
  }
  return output;
}
