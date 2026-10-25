import { InvalidCircuitError } from '../../errors.js';
import { hyst } from './limiter-models.js';
import { real, reals, flag, smoothCorner, STATIC, type BehaviorFactory, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

/** ngspice-47 xtradev/lcouple/cfunc.mod:182-235 (backward difference, not CKT integration). */
function lcouple(params: ResolvedXspiceParams): CodeModelBehavior {
  const turns = real(params, 'num_turns');
  let flux = 0;
  return {
    stateful: true,
    // ngspice's AC sign is positive, unlike the transient partial (lines 243-249).
    ac: { kind: 'differentiator', gain: turns, input: 1, output: 0 },
    load(call) {
      call.outputs[1] = turns * call.inputs[0];
      call.partials[2] = turns;
      const slope = call.time === 0 ? 0 : -turns / call.delta;
      call.outputs[0] = slope * (call.inputs[1] - flux);
      call.partials[1] = slope;
    },
    accept(call) { flux = call.inputs[1]; },
    reset() { flux = 0; },
    // The DC flux is the previous-timepoint flux at the start of transient.
    beginTransient() {},
  };
}

/** ngspice-47 xtradev/core/cfunc.mod: mode=1 PWL, mode=2 unscaled hysteresis. */
function core(params: ResolvedXspiceParams): CodeModelBehavior {
  const mode = real(params, 'mode');
  if (mode === 2) return hyst(params);
  if (mode !== 1) throw new InvalidCircuitError(`XSPICE core supports only mode=1 or mode=2; got mode=${mode}`);
  const h = reals(params, 'h_array');
  const b = reals(params, 'b_array');
  const area = real(params, 'area');
  const length = real(params, 'length');
  const domain = real(params, 'input_domain');
  const fraction = flag(params, 'fraction');
  if (h.length !== b.length || h.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= h[i - 1])) || b.some(v => !Number.isFinite(v))) {
    throw new InvalidCircuitError('XSPICE core requires equal-sized H/B arrays and strictly increasing finite H values');
  }
  if (!(length > 0) || !Number.isFinite(length) || !(area > 0) || !Number.isFinite(area)) {
    throw new InvalidCircuitError('XSPICE core area and length must be finite and positive');
  }
  if (!fraction && h.some((v, i) => i > 0 && v - h[i - 1] < 2 * domain)) {
    throw new InvalidCircuitError('XSPICE core input_domain exceeds half an H segment');
  }
  const slope = (i: number): number => (b[i + 1] - b[i]) / (h[i + 1] - h[i]);
  return {
    stateful: false, ac: STATIC,
    load(call) {
      const x = call.inputs[0] / length;
      let y: number;
      let derivative: number;
      if (x <= (h[0] + h[1]) / 2) {
        derivative = slope(0);
        y = b[0] + (x - h[0]) * derivative;
      } else if (x >= (h.at(-2)! + h.at(-1)!) / 2) {
        derivative = slope(h.length - 2);
        y = b.at(-1)! + (x - h.at(-1)!) * derivative;
      } else {
        let i = 1;
        while (x >= (h[i] + h[i + 1]) / 2) i++;
        const width = fraction ? domain * Math.min(h[i] - h[i - 1], h[i + 1] - h[i]) : domain;
        if (x < h[i] - width) {
          derivative = slope(i - 1);
          y = b[i] + (x - h[i]) * derivative;
        } else if (x < h[i] + width) {
          const smooth = smoothCorner(x, h[i], b[i], width, slope(i - 1), slope(i));
          y = smooth.y;
          derivative = smooth.dydx;
        } else {
          derivative = slope(i);
          y = b[i] + (x - h[i]) * derivative;
        }
      }
      call.outputs[0] = y * area;
      call.partials[0] = derivative * area / length;
    },
  };
}

export const MAGNETIC_BEHAVIORS: ReadonlyMap<string, BehaviorFactory> = new Map([
  ['lcouple', lcouple], ['core', core],
]);
