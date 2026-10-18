/**
 * Variable-step BDF3 derivative weights at the trial point, newest first.
 * Differentiate the cubic Lagrange interpolant (ngspice NIcomCof).
 * Steps are positive accepted intervals; callers bootstrap before using this.
 */
export function gear3Coefficients(dt: number, prevDt: number, prevPrevDt: number): readonly [number, number, number, number] {
  // Normalise by dt to avoid products of tiny physical timesteps.
  const b = 1 + prevDt / dt;
  const c = b + prevPrevDt / dt;
  return [
    (1 + 1 / b + 1 / c) / dt,
    -b * c / ((b - 1) * (c - 1) * dt),
    c / (b * (b - 1) * (c - b) * dt),
    -b / (c * (c - 1) * (c - b) * dt),
  ];
}
