/**
 * Vector values of the ngspice control language (`let`, `if`, `$&name`, ...).
 *
 * A vector is a real or complex array with an optional scale (the plot's
 * independent variable: `time`, `frequency`, `v-sweep`). Scalars are vectors
 * of length 1.
 */
export interface ControlVector {
  /** Vector name, lower-cased (ngspice names are case-insensitive). */
  name: string;
  /** Real parts. */
  re: Float64Array;
  /** Imaginary parts, present only for complex vectors. */
  im?: Float64Array;
  /** Row-major dimensions; absent means a one-dimensional vector. */
  dims?: number[];
  /** Scale vector (independent variable) when the vector came from an analysis. */
  scale?: ControlVector;
}

export function realVector(name: string, values: ArrayLike<number>, scale?: ControlVector): ControlVector {
  return { name: name.toLowerCase(), re: Float64Array.from(values), ...(scale ? { scale } : {}) };
}

export function complexVector(
  name: string,
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  scale?: ControlVector,
): ControlVector {
  return {
    name: name.toLowerCase(),
    re: Float64Array.from(re),
    im: Float64Array.from(im),
    ...(scale ? { scale } : {}),
  };
}

export function scalar(value: number, name = 'constant'): ControlVector {
  return realVector(name, [value]);
}

export function isComplex(vector: ControlVector): boolean {
  return vector.im !== undefined;
}

/** Copy a vector under a new name (assignments never alias the source data). */
export function renamed(vector: ControlVector, name: string): ControlVector {
  return {
    name: name.toLowerCase(),
    re: Float64Array.from(vector.re),
    ...(vector.im ? { im: Float64Array.from(vector.im) } : {}),
    ...(vector.scale ? { scale: vector.scale } : {}),
    ...(vector.dims ? { dims: [...vector.dims] } : {}),
  };
}

/** ngspice truth value: true when any element is non-zero. */
export function isTrue(vector: ControlVector): boolean {
  for (let index = 0; index < vector.re.length; index++) {
    if (vector.re[index] !== 0) return true;
    if (vector.im && vector.im[index] !== 0) return true;
  }
  return false;
}

/**
 * Format a number like C `printf("%.*g", digits, value)`, which ngspice uses
 * for `$&vector` substitution (`printnum`, 6 significant digits by default).
 */
export function formatNumber(value: number, digits = 6): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const precision = Math.max(1, Math.min(digits, 21));
  const exponent = Math.floor(Math.log10(Math.abs(Number(value.toPrecision(precision)))));
  if (exponent < -4 || exponent >= precision) {
    const [mantissa, power] = value.toExponential(precision - 1).split('e');
    const sign = power.startsWith('-') ? '-' : '+';
    const magnitude = power.replace(/^[+-]/, '').padStart(2, '0');
    return `${stripTrailingZeros(mantissa)}e${sign}${magnitude}`;
  }
  return stripTrailingZeros(value.toFixed(Math.max(0, precision - 1 - exponent)));
}

function stripTrailingZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** `$&name` text of a vector: its real parts, space separated (as ngspice prints them). */
export function formatVector(vector: ControlVector, digits = 6): string {
  return Array.from(vector.re, value => formatNumber(value, digits)).join(' ');
}
