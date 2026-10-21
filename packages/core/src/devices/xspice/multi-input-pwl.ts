import { InvalidCircuitError } from '../../errors.js';
import { reals, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

/** ngspice-47 analog/multi_input_pwl: min/max selection, clamped linear table. */
export function multiInputPwl(params: ResolvedXspiceParams): CodeModelBehavior {
  const x = reals(params, 'x'), y = reals(params, 'y');
  const mode = params.get('model')![0];
  const fail = (message: string): never => { throw new InvalidCircuitError(`XSPICE multi_input_pwl: ${message}`); };
  if (x.length !== y.length) fail("'x' and 'y' input vectors are not the same size");
  if (mode !== 'and' && mode !== 'or') fail('supported model types are "and" and "or"');
  if (x.some((value, i) => !Number.isFinite(value) || (i > 0 && value <= x[i - 1])) || y.some(value => !Number.isFinite(value))) {
    fail('requires finite y and finite, strictly increasing x');
  }
  let inputCount = 0;
  return {
    stateful: false,
    // ngspice-47 does not set AC_GAIN (or PARTIAL); preserve its zero AC response.
    ac: { kind: 'static' },
    acGains: () => Array.from({ length: inputCount }, () => ({ real: 0, imaginary: 0 })),
    load({ inputs, outputs, partials }) {
      inputCount = inputs.length;
      let selected = 0;
      for (let i = 1; i < inputs.length; i++) {
        if (mode === 'and' ? inputs[i] < inputs[selected] : inputs[i] > inputs[selected]) selected = i;
      }
      const value = inputs[selected];
      partials.fill(0);
      if (value <= x[0]) outputs[0] = y[0];
      else if (value >= x[x.length - 1]) outputs[0] = y[y.length - 1];
      else {
        let upper = 1;
        while (value > x[upper]) upper++;
        const slope = (y[upper] - y[upper - 1]) / (x[upper] - x[upper - 1]);
        outputs[0] = slope * value + (y[upper] - slope * x[upper]);
        // Exact Jacobian for the active input; first input wins ties.
        partials[selected] = slope;
      }
    },
  };
}
