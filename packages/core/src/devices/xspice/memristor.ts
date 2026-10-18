import { integrator, real, STATIC, type CodeModelBehavior, type CodeModelCall, type ResolvedXspiceParams } from './models.js';

/** ngspice-47 xtradev/memristor: Pershin/Di Ventra threshold resistance model. */
export function memristor(params: ResolvedXspiceParams): CodeModelBehavior {
  const rmin = real(params, 'rmin');
  const rmax = real(params, 'rmax');
  const rinit = real(params, 'rinit');
  const alpha = real(params, 'alpha');
  const beta = real(params, 'beta');
  const vt = real(params, 'vt');
  const integral = integrator(new Map([
    ['in_offset', [0]], ['gain', [1]], ['out_ic', [rinit]],
    ['out_lower_limit', [-Infinity]], ['out_upper_limit', [Infinity]], ['limit_range', [0]],
  ]));
  let acceptedResistance = rinit;
  const inputs = new Float64Array(1);
  const outputs = new Float64Array(1);
  const partials = new Float64Array(1);
  const initialize = (): void => {
    integral.reset!();
    integral.accept!({ analysis: 'dc', init: true, time: 0, delta: 0,
      inputs, outputs, partials, notConverged() {} });
    acceptedResistance = rinit;
  };
  initialize();

  const integralCall = (call: CodeModelCall): { call: CodeModelCall; slope: number } => {
    const v = call.inputs[0];
    const rate = beta * v + 0.5 * (alpha - beta) * (Math.abs(v + vt) - Math.abs(v - vt));
    // The window stops outward motion, not overshoot. Do not clamp R to the bounds.
    const moving = (rate > 0 && acceptedResistance < rmax) || (rate < 0 && acceptedResistance > rmin);
    inputs[0] = moving ? rate : 0;
    const slope = moving ? beta + 0.5 * (alpha - beta) * (Math.sign(v + vt) - Math.sign(v - vt)) : 0;
    return { call: { ...call, inputs, outputs, partials }, slope };
  };

  return {
    stateful: true,
    ac: STATIC,
    load(call) {
      const inner = integralCall(call);
      integral.load(inner.call);
      const r = outputs[0];
      call.outputs[0] = call.inputs[0] / r;
      // Differentiate the actual current, not ngspice's questionable bare integration coefficient.
      call.partials[0] = 1 / r - call.inputs[0] * partials[0] * inner.slope / (r * r);
    },
    accept(call) {
      const inner = integralCall(call).call;
      integral.load(inner);
      integral.accept!(inner);
      acceptedResistance = outputs[0];
    },
    truncate(call, truncation) { return integral.truncate!(integralCall(call).call, truncation); },
    reset: initialize,
  };
}
