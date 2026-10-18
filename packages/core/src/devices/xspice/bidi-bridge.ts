/**
 * ngspice-47 src/xspice/icm/digital/bidi_bridge/cfunc.mod (line references below).
 * https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/bidi_bridge/cfunc.mod
 */
import { InvalidCircuitError } from '../../errors.js';
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import {
  HI_IMPEDANCE, ONE, STRONG, UNDETERMINED, UNKNOWN, ZERO,
  type DigitalValue, type EventBehavior, type EventInstanceView,
} from './event-network.js';
import { smoothDiscontinuity } from './limiter-models.js';
import { real, STATIC, type CodeModelBehavior, type CodeModelCall } from './models.js';

interface DigitalState {
  input: DigitalValue;
  next: number;
  output: DigitalValue;
  changed: number;
}
interface AnalogState { input: DigitalValue; svoc: number; output: number }
const same = (a: DigitalValue, b: DigitalValue): boolean => a.state === b.state && a.strength === b.strength;

export const bidiBridge: DigitalModelFactory = (params, context) => {
  const count = (name: string): number => context.connections.find(c => c.name === name)!.ports.length;
  const size = count('a');
  if (count('d') !== size) throw new InvalidCircuitError('bidi_bridge requires equal analog and digital vector sizes');
  const dirSize = Math.min(size, count('dir'));
  const direction = real(params, 'direction');
  const strength = real(params, 'strength');
  const tRise = real(params, 't_rise'), tFall = real(params, 't_fall');
  const riseDelay = real(params, 'rise_delay'), fallDelay = real(params, 'fall_delay');
  const low = real(params, 'in_low'), high = real(params, 'in_high');
  const outLow = real(params, 'out_low'), outHigh = real(params, 'out_high');
  const driveLow = real(params, 'drive_low'), driveHigh = real(params, 'drive_high');
  const rStl = real(params, 'r_stl'), rSth = real(params, 'r_sth');
  const rLow = real(params, 'r_low'), rHigh = real(params, 'r_high');
  const smooth = real(params, 'smooth');
  const dir = (input: (port: number) => number, i: number): number => direction !== UNKNOWN
    ? direction : i < dirSize ? input(size + i) : UNKNOWN;
  const event: EventBehavior<DigitalState[]> = {
    // cfunc.mod:55-69: sentinel forces the first ADC output, initial DAC is off.
    createState: () => Array.from({ length: size }, () => ({
      input: { state: UNKNOWN, strength: UNDETERMINED }, next: UNKNOWN,
      output: { state: UNKNOWN + 1, strength: HI_IMPEDANCE }, changed: -1,
    })),
    event(call) {
      for (let i = 0; i < size; i++) {
        const d = call.state[i], out = call.outputs[i];
        out.load = real(params, 'input_load');
        const atod = dir(call.inputState, i);
        const input = call.inputValue(i);
        // cfunc.mod:391-407: watch resolved input changes (including strength).
        if (atod !== ONE && !same(input, d.input)) {
          d.input = input;
          d.changed = call.time;
          call.setTemporaryBreakpoint(call.time);
          const transition = input.state === ZERO ? tFall : input.state === ONE ? tRise : Math.min(tRise, tFall);
          call.setBreakpoint(call.time + transition * 1.0001);
        }
        // cfunc.mod:412-440: DAC-only releases its digital driver.
        if (atod === ZERO) {
          if (d.output.strength === HI_IMPEDANCE) out.changed = false;
          else {
            d.output = { state: UNKNOWN, strength: HI_IMPEDANCE };
            out.delay = Math.max(riseDelay, fallDelay);
          }
        } else if (d.output.state !== d.next) {
          d.output = { state: d.next, strength };
          out.delay = d.next === ZERO ? fallDelay : d.next === ONE ? riseDelay : Math.min(riseDelay, fallDelay);
        } else out.changed = false;
        if (call.init && !out.changed) {
          out.changed = true;
          out.state = UNKNOWN;
          out.strength = HI_IMPEDANCE;
        } else {
          out.state = d.output.state;
          out.strength = d.output.strength;
        }
      }
    },
  };
  const analog = (view: EventInstanceView<DigitalState[]>): CodeModelBehavior => {
    const initial = (): AnalogState[] => Array.from({ length: size }, () => ({
      input: { state: UNKNOWN, strength: HI_IMPEDANCE }, svoc: 0, output: 0,
    }));
    let accepted = initial(), current = initial();
    const evaluate = (call: CodeModelCall): void => {
      if (!view.initialized) return;
      current = initial();
      for (let i = 0; i < size; i++) {
        const d = view.state[i], old = accepted[i], a = current[i];
        const atod = dir(port => view.inputState(port), i);
        const input = call.inputs[i];
        // cfunc.mod:121-140: strict thresholds, reversed thresholds give hysteresis.
        if (atod !== ZERO) {
          const next = high < low
            ? input > low ? ONE : input < high ? ZERO : d.output.state
            : input < low ? ZERO : input > high ? ONE : UNKNOWN;
          if (next !== d.next) { d.next = next; view.queue(call.time); }
        }
        if (atod === ONE) {
          a.input = { ...old.input };
          a.svoc = .5;
          call.outputs[i] = 0;
          continue;
        }
        // cfunc.mod:156-165: exclude our ADC output, otherwise a tristate release
        // latches its own previous analog reading and never releases the wire.
        const drive = atod === UNKNOWN ? view.probeExternal(i) : view.inputValue(i);
        a.input = drive;
        let out = old.output, svoc = old.svoc, partial = 0;
        // cfunc.mod:169-191: split current slew at the first event in the step.
        const iota = call.delta * 1e-6, t1 = call.time - call.delta;
        let first: number, intervals: number[];
        if (call.time - d.changed < iota) { first = 0; intervals = [call.delta]; }
        else if (d.changed - t1 < iota) { first = 1; intervals = [0, call.delta]; }
        else { first = 0; intervals = [d.changed - t1, call.time - d.changed]; }
        for (let step = first; step < intervals.length; step++) {
          const dp = step === 0 ? old.input : drive;
          // cfunc.mod:207-245 intentionally uses the WHOLE delta for svoc on
          // both sides of a split. Preserve the repeated > comparison at 228:
          // asymmetric strong-U with drive_high < drive_low targets .5, not 0.
          if (dp.state === ZERO) svoc = Math.max(0, svoc - call.delta / tFall);
          else if (dp.state === ONE) svoc = Math.min(1, svoc + call.delta / tRise);
          else if (dp.strength === HI_IMPEDANCE) svoc = .5;
          else {
            const tv = dp.strength === STRONG ? driveHigh > driveLow ? 1 : .5 : rLow / (rLow + rHigh);
            svoc = svoc < tv ? Math.min(tv, svoc + call.delta / tRise) : Math.max(tv, svoc - call.delta / tFall);
          }
          let voc = smooth > 0 ? smoothDiscontinuity(svoc, 0, 0, 1, 1).y : svoc;
          let maxHigh = Math.max(0, driveHigh * (voc - .3) / .7);
          let maxLow = Math.max(0, driveLow * (.7 - voc) / .7);
          if (smooth > 1) {
            maxHigh = smoothDiscontinuity(maxHigh, 0, 0, driveHigh, driveHigh).y;
            maxLow = smoothDiscontinuity(maxLow, 0, 0, driveLow, driveLow).y;
          }
          voc = outLow + (outHigh - outLow) * voc;
          let target = 0, range: number;
          // cfunc.mod:280-355: sink-positive g port, tapered strong drive,
          // one-sided resistive pull, U drives both, Z drives neither.
          if (dp.strength === STRONG) {
            range = driveHigh + driveLow;
            partial = dp.state === ZERO ? 1 / rStl : dp.state === ONE ? 1 / rSth : 1 / rStl + 1 / rSth;
            target = (input - voc) * partial;
            if (target > maxLow) { target = maxLow; partial = 0; }
            else if (target < -maxHigh) { target = -maxHigh; partial = 0; }
          } else if (dp.strength !== HI_IMPEDANCE) {
            range = outHigh / rHigh + outLow / rLow;
            if (dp.state === ZERO) {
              if (input >= voc) { partial = 1 / rLow; target = (input - voc) / rLow; }
            } else if (dp.state === ONE) {
              if (input <= voc) { partial = 1 / rHigh; target = (input - voc) / rHigh; }
            } else if (input < outLow) { partial = 1 / rHigh; target = (input - outHigh) / rHigh; }
            else if (input >= outHigh) { partial = 1 / rLow; target = (input - outLow) / rLow; }
            else { partial = 1 / rLow + 1 / rHigh; target = (input - voc) * partial; }
          } else range = Math.max(driveHigh, driveLow);
          // cfunc.mod:359-373: slew OUTPUT CURRENT, not voltage. The source
          // retains the target partial even while current is slewing.
          const delta = Math.abs((target - out) * ((target > out ? tRise : tFall) / range));
          out = delta > intervals[step] ? out + (target - out) * intervals[step] / delta : target;
        }
        a.output = call.outputs[i] = out;
        a.svoc = svoc;
        call.partials[i * size + i] = partial;
      }
    };
    return {
      stateful: true, ac: STATIC, load: evaluate,
      accept(call) { evaluate(call); accepted = structuredClone(current); },
      reset() { accepted = initial(); current = initial(); },
      // Analog allocated history is copied at MODEINITTRAN, not zeroed.
      beginTransient() {},
    };
  };
  return { event, analog } as DigitalModel<unknown>;
};
