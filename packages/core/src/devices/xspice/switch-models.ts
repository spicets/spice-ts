/**
 * ngspice-47 XSPICE switch code models of the xtradev library (pswitch and
 * aswitch), the devices ngspice's PSpice compatibility mode
 * (frontend/inpcompat.c) turns PSpice `VSWITCH` and `ISWITCH` switches into.
 */
import { InvalidCircuitError } from '../../errors.js';
import { STATIC, flag, real, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

/** mifload.c MIFauto_partial input step for voltage and conductance ports. */
const AUTO_PARTIAL_EPSILON = 1.0e-6;

/**
 * ngspice-47 src/xspice/icm/xtradev/pswitch/cfunc.mod:172-282 (cm_pswitch):
 * https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/src/xspice/icm/xtradev/pswitch/cfunc.mod
 * A resistor between the `out` ports
 * whose value moves from r_off to r_on as the control voltage crosses from
 * cntl_off to cntl_on, log-linearly by a cubic (log = TRUE) or linearly, plus
 * an r_cntl_in load on the control port.
 *
 * ngspice computes the DC/TRAN partials with cm_analog_auto_partial, finite
 * differences of the outputs, reproduced here. In AC, ngspice-47 loads
 * AC_GAIN = -1/r (and -d(I)/d(cntl) without the 1/(cntl_on - cntl_off) factor),
 * so a pswitch there acts as a negative resistor; spice-ts instead linearises
 * the operating point (the partials), the small-signal model of a resistor.
 */
function pswitch(params: ResolvedXspiceParams): CodeModelBehavior {
  // Minimum 'ON' and maximum 'OFF' resistance.
  const rOn = Math.max(real(params, 'r_on'), 1.0e-3);
  const rOff = Math.min(real(params, 'r_off'), 1.0e12);
  const rCntlIn = real(params, 'r_cntl_in');
  const log = flag(params, 'log');

  // INIT: separate coincident thresholds.
  let cntlOn = real(params, 'cntl_on');
  let cntlOff = real(params, 'cntl_off');
  if (Math.abs(cntlOn - cntlOff) < 1.0e-12) {
    cntlOn += 0.001;
    cntlOff -= 0.001;
  }

  // Log mode works on the control value normalised to [0, 1] (cntl_diff = +-1).
  const logmean = Math.log(Math.sqrt(rOn * rOff));
  const logratio = Math.log(rOn / rOff);
  const logDiff = cntlOn > cntlOff ? 1 : -1;
  const c1 = 1.5 * logratio / logDiff;
  const c3 = 2.0 * logratio / (logDiff * logDiff * logDiff);
  // Linear mode.
  const linearDiff = cntlOn - cntlOff;
  const intermediate = (rOn - rOff) / linearDiff;

  /** The switch resistance at control value `cntl` (the body of cm_pswitch). */
  const resistance = (cntl: number): number => {
    let r: number;
    if (log) {
      if (cntlOn > cntlOff) {
        if (cntl > cntlOn) return rOn;
        if (cntl < cntlOff) return rOff;
        const inmean = (cntl - cntlOff) / (cntlOn - cntlOff) - 0.5;
        r = Math.exp(logmean + c1 * inmean - c3 * inmean * inmean * inmean);
      } else {
        if (cntl < cntlOn) return rOn;
        if (cntl > cntlOff) return rOff;
        const inmean = (cntlOn - cntl) / (cntlOn - cntlOff) - 0.5;
        r = Math.exp(logmean + c1 * inmean - c3 * inmean * inmean * inmean);
      }
      return r < rOn ? rOn : r; // minimum resistance limiter
    }
    if (linearDiff >= 0 ? cntl < cntlOff : cntl > cntlOff) r = rOff;
    else if (linearDiff >= 0 ? cntl > cntlOn : cntl < cntlOn) r = rOn;
    else r = cntl * intermediate + (rOff * cntlOn - rOn * cntlOff) / linearDiff;
    return r <= 1.0e-9 ? 1.0e-9 : r; // minimum resistance limiter
  };

  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      // Ports in order: cntl_in (input 0, output 0), out (input 1, output 1).
      const cntl = inputs[0];
      const vout = inputs[1];
      const r = resistance(cntl);
      outputs[0] = cntl / rCntlIn;
      outputs[1] = vout / r;
      // cm_analog_auto_partial (mifload.c MIFauto_partial): forward differences
      // with a 1 uV step on each (conductance) input.
      partials[0] = ((cntl + AUTO_PARTIAL_EPSILON) / rCntlIn - outputs[0]) / AUTO_PARTIAL_EPSILON;
      partials[1] = 0;
      partials[2] = (vout / resistance(cntl + AUTO_PARTIAL_EPSILON) - outputs[1]) / AUTO_PARTIAL_EPSILON;
      partials[3] = ((vout + AUTO_PARTIAL_EPSILON) / r - outputs[1]) / AUTO_PARTIAL_EPSILON;
    },
  };
}

/**
 * xtradev/aswitch/cfunc.mod cm_aswitch: a resistor between the `out` ports
 * whose value moves from r_off to r_on as the control input (a voltage or, for
 * a translated PSpice ISWITCH, the current of a `%vnam` voltage source) crosses
 * from cntl_off to cntl_on, exponentially (log = TRUE) or linearly. With
 * limit = TRUE r is clamped to [r_on, r_off]; otherwise only to >= 1e-9 ohm.
 *
 * The partials are cm_aswitch's analytic ones, including its quirk of keeping
 * the unclamped d/d(cntl) term where the limiter holds r constant. In AC
 * ngspice-47 loads AC_GAIN = -(partials), a negative resistor; spice-ts
 * linearises the operating point instead (as for pswitch).
 *
 * @throws {@link InvalidCircuitError} when |cntl_on - cntl_off| < 1e-12, where
 *   cm_aswitch only reports "CONTROL voltage delta less than 1.0e-12" and loads nothing
 */
function aswitch(params: ResolvedXspiceParams): CodeModelBehavior {
  const cntlOn = real(params, 'cntl_on');
  const cntlOff = real(params, 'cntl_off');
  const rOn = Math.max(real(params, 'r_on'), 1.0e-3); // minimum 'ON' resistance
  const rOff = real(params, 'r_off');
  const log = flag(params, 'log');
  const limit = flag(params, 'limit');
  if (Math.abs(cntlOn - cntlOff) < 1.0e-12) {
    throw new InvalidCircuitError(
      `aswitch: cntl_on and cntl_off differ by less than 1e-12 (ngspice-47 "CONTROL voltage delta less than 1.0e-12")`,
    );
  }
  const intermediate = log
    ? Math.log(rOff / rOn) / (cntlOn - cntlOff)
    : (rOn - rOff) / (cntlOn - cntlOff);
  const offset = (rOff * cntlOn - rOn * cntlOff) / (cntlOn - cntlOff);

  return {
    stateful: false,
    ac: STATIC,
    load({ inputs, outputs, partials }) {
      // Ports in order: cntl_in (input 0), out (input 1, output 0).
      const cntl = inputs[0];
      const vout = inputs[1];
      let r = log ? rOn * Math.exp(intermediate * (cntlOn - cntl)) : cntl * intermediate + offset;
      if (limit) {
        if (r < rOn) r = rOn; // minimum resistance limiter
        if (r > rOff) r = rOff; // maximum resistance limiter
      } else if (r <= 1.0e-9) {
        r = 1.0e-9; // minimum resistance limiter
      }
      outputs[0] = vout / r;
      partials[0] = log ? intermediate * vout / r : -intermediate * vout / (r * r);
      partials[1] = 1.0 / r;
    },
  };
}

export const SWITCH_BEHAVIORS = new Map([['pswitch', pswitch], ['aswitch', aswitch]] as const);
