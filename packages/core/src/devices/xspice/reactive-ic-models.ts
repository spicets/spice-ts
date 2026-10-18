import { real, type BehaviorFactory, type CodeModelBehavior, type CodeModelCall, type ResolvedXspiceParams } from './models.js';
import type { XspiceCodeModelSpec } from './spec.js';

/** ngspice xtradev/{capacitor,inductor}/ifspec.ifs: a single differential inout port. */
export const REACTIVE_IC_SPECS: readonly XspiceCodeModelSpec[] = [
  { name: 'capacitoric', port: 'cap', type: 'hd', parameter: 'c' },
  { name: 'inductoric', port: 'ind', type: 'gd', parameter: 'l' },
].map(({ name, port, type, parameter }) => ({
  name,
  connections: [{ name: port, direction: 'inout', defaultType: type, allowedTypes: [type], vector: false, nullAllowed: false }],
  params: [
    { name: parameter, type: 'real', vector: false, nullAllowed: false },
    { name: 'ic', type: 'real', defaultValue: [0], vector: false, nullAllowed: true },
  ],
}));

/**
 * Public Domain ngspice-47 xtradev/{capacitor,inductor}/cfunc.mod:
 * https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/xtradev
 * Both use cm_analog_integrate:
 * TRAP is right-endpoint integration (including order 2); GEAR uses BDF2.
 * The inductor's AC_GAIN is j*omega*l in ngspice, despite its transient integral.
 */
function reactive(params: ResolvedXspiceParams, capacitor: boolean): CodeModelBehavior {
  const value = real(params, capacitor ? 'c' : 'l');
  const ic = real(params, 'ic');
  const history = [0, 0, 0];
  let count = 0;
  let rampTime = 0;
  const ramp = (call: CodeModelCall): number => rampTime > 0 ? Math.min(1, call.time / rampTime) : 1;
  const evaluate = (call: CodeModelCall): { out: number; partial: number } => {
    const factor = ramp(call);
    if (call.analysis === 'dc' || call.time === 0 || factor < 1) return { out: ic * factor, partial: 0 };
    const integration = call.integration;
    if (integration?.method === 'gear2' && integration.prevDt !== undefined && count >= 2) {
      const dt = integration.dt;
      const alpha = integration.prevDt / dt;
      const a1 = (2 + alpha) / ((1 + alpha) * dt);
      const a2 = (1 + alpha) / (alpha * dt);
      const a3 = 1 / (alpha * (1 + alpha) * dt);
      return { out: (call.inputs[0] / value + a2 * history[0] - a3 * history[1]) / a1, partial: 1 / (a1 * value) };
    }
    return { out: history[0] + call.delta * call.inputs[0] / value, partial: call.delta / value };
  };
  return {
    stateful: true,
    ac: capacitor ? { kind: 'integrator', gain: 1 / value } : { kind: 'differentiator', gain: value },
    setRampTime(time) { rampTime = time; },
    load(call) {
      const { out, partial } = evaluate(call);
      call.outputs[0] = out;
      call.partials[0] = partial;
    },
    accept(call) {
      const { out } = evaluate(call);
      history[2] = history[1]; history[1] = history[0]; history[0] = out;
      count = Math.min(count + 1, 3);
    },
    truncate(call, truncation) {
      if (call.analysis !== 'tran' || !call.integration || ramp(call) < 1) return Infinity;
      const order = truncation.order ?? (call.integration.method === 'euler' ? 1 : 2);
      if (count < order + 1) return Infinity;
      const { deltas, reltol, abstol, chgtol, trtol } = truncation;
      const trial = evaluate(call).out;
      const tolerance = Math.max(abstol + reltol * Math.abs(trial - history[0]) / deltas[0],
        reltol * Math.max(Math.abs(trial), Math.abs(history[0]), chgtol) / deltas[0]);
      const diff = [trial, ...history];
      const span = [...deltas];
      for (let j: number = order; ; j--) {
        for (let i = 0; i <= j; i++) diff[i] = (diff[i] - diff[i + 1]) / span[i];
        if (j === 0) break;
        for (let i = 0; i < j; i++) span[i] = span[i + 1] + deltas[i];
      }
      const coefficient = call.integration.method === 'gear2' ? [0.5, 2 / 9][order - 1] : [0.5, 1 / 12][order - 1];
      const bound = trtol * tolerance / Math.max(abstol, coefficient * Math.abs(diff[0]));
      return order === 2 ? Math.sqrt(bound) : bound;
    },
    reset() { history.fill(0); count = 0; },
  };
}

export const REACTIVE_IC_BEHAVIORS: ReadonlyMap<string, BehaviorFactory> = new Map([
  ['capacitoric', params => reactive(params, true)],
  ['inductoric', params => reactive(params, false)],
]);
