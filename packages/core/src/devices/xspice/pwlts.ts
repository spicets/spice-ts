import { InvalidCircuitError } from '../../errors.js';
import { flag, real, reals, smoothCorner, STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

/** ngspice-47 src/xspice/icm/analog/pwlts/cfunc.mod:197-253,273-362. */
export function pwlts(params: ResolvedXspiceParams): CodeModelBehavior {
  const xs = reals(params, 'x_array');
  const ys = reals(params, 'y_array');
  const fraction = flag(params, 'fraction');
  const domain = real(params, 'input_domain');
  if (xs.length !== ys.length || xs.some((x, i) => !Number.isFinite(x) || (i > 0 && x <= xs[i - 1]))
    || ys.some(y => !Number.isFinite(y))) {
    throw new InvalidCircuitError('XSPICE pwlts requires equal-length arrays with strictly increasing finite times and finite values');
  }
  if (!fraction && xs.some((x, i) => i > 0 && x - xs[i - 1] < 0.999999999 * 2 * domain)) {
    throw new InvalidCircuitError('XSPICE pwlts input_domain exceeds half a time segment');
  }
  const x = [2 * xs[0] - xs[1], ...xs, 2 * xs.at(-1)! - xs.at(-2)!];
  const y = [flag(params, 'limit') ? ys[0] : 2 * ys[0] - ys[1], ...ys,
    flag(params, 'limit') ? ys.at(-1)! : 2 * ys.at(-1)! - ys.at(-2)!];
  const width = (i: number) => fraction ? domain * Math.min(x[i] - x[i - 1], x[i + 1] - x[i]) : domain;
  const slope = (i: number) => (y[i + 1] - y[i]) / (x[i + 1] - x[i]);
  // cfunc.mod:231-253 skips the entire corner if its lower boundary is nonpositive.
  const corners = xs.flatMap((_, j) => {
    const i = j + 1;
    const d = width(i);
    return x[i] - d > 0 ? [x[i] - d, x[i], x[i] + d] : [];
  });
  return {
    stateful: false,
    ac: STATIC,
    breakpoints: () => corners,
    load({ time, outputs }) {
      if (time <= (x[0] + x[1]) / 2) {
        outputs[0] = y[0] + (time - x[0]) * slope(0);
      } else if (time >= (x.at(-2)! + x.at(-1)!) / 2) {
        outputs[0] = y.at(-1)! + (time - x.at(-1)!) * slope(x.length - 2);
      } else {
        for (let i = 1; i < x.length - 1; i++) {
          if (time >= (x[i] + x[i + 1]) / 2) continue;
          const d = width(i);
          outputs[0] = time < x[i] - d ? y[i] + (time - x[i]) * slope(i - 1)
            : time < x[i] + d ? smoothCorner(time, x[i], y[i], d, slope(i - 1), slope(i)).y
              : y[i] + (time - x[i]) * slope(i);
          break;
        }
      }
    },
  };
}
