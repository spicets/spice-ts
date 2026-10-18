/** ngspice-47 src/xspice/icm/xtradev/seegenerator (Public Domain).
 * cfunc.mod:252-255,282-321: start/peak breakpoints, rising-control restart,
 * double exponential and sequential outputs. Trial loads never commit state.
 */
import { InvalidCircuitError } from '../../errors.js';
import { flag, real, reals, STATIC, type BehaviorFactory } from './models.js';
import { portIndices } from './limiter-models.js';
import type { XspiceCodeModelSpec } from './spec.js';

export const SEEGEN_SPEC: XspiceCodeModelSpec = {
  name: 'seegen',
  connections: [
    { name: 'ctrl', direction: 'in', defaultType: 'v', allowedTypes: ['v', 'vd', 'i', 'id'], vector: false, nullAllowed: true },
    { name: 'mon', direction: 'out', defaultType: 'v', allowedTypes: ['v'], vector: false, nullAllowed: true },
    { name: 'out', direction: 'out', defaultType: 'i', allowedTypes: ['i', 'id'], vector: true, vectorBounds: [1, undefined], nullAllowed: false },
  ],
  params: [
    ...Object.entries({ tfall: 500e-12, trise: 20e-12, tdelay: 0, inull: 0, tperiod: 0, ctrlthres: 0.5, let: 10, cdepth: 1, angle: 0 }).map(([name, value]) => ({
      name, type: 'real' as const, defaultValue: [value], vector: false, nullAllowed: true,
      ...(name === 'angle' ? { limits: [0, 1.57079] as const } : {}),
    })),
    { name: 'perlim', type: 'boolean', defaultValue: [true], vector: false, nullAllowed: true },
    ...['scaling', 'scdelay'].map(name => ({ name, type: 'real' as const, defaultValue: [], vector: true, nullAllowed: true,
      limits: [0, name === 'scaling' ? 1 : undefined] as const })),
  ],
};

export const seegen: BehaviorFactory = (params, context) => {
  const ports = portIndices(context);
  const control = ports.input.get('ctrl');
  const monitor = ports.output.get('mon');
  const first = ports.output.get('out')!;
  const count = context.connections.find(c => c.name === 'out')!.ports.length;
  const fall = real(params, 'tfall');
  const rise = real(params, 'trise');
  const delay = real(params, 'tdelay');
  const period = real(params, 'tperiod');
  const threshold = real(params, 'ctrlthres');
  const amplitude = real(params, 'inull') || 1.035e-14 * real(params, 'let') * real(params, 'cdepth') / Math.cos(real(params, 'angle')) / (fall - rise);
  const peakTime = fall * rise * Math.log(rise / fall) / (rise - fall);
  const scaling = reals(params, 'scaling');
  const delays = reals(params, 'scdelay');
  const scaled = scaling.length > 0 && delays.length > 0;
  const sum = scaling.reduce((a, b) => a + b, 0);
  if (scaled && (scaling.length !== count || delays.length !== count || sum === 0)) {
    throw new InvalidCircuitError('seegen: scaling/scdelay must match output count and scaling must have a nonzero sum');
  }
  if (!scaled && 5 * (rise + fall) > period) {
    throw new InvalidCircuitError('seegen: tperiod should be at least 5 times the sum of trise and tfall');
  }
  type State = { start: number; port: number; control: number | undefined; outputs: Float64Array };
  const initial = (): State => ({ start: control === undefined ? delay : 1e12, port: 0, control: undefined, outputs: new Float64Array(first + count) });
  let accepted = initial();
  let trial = initial();
  const pulse = (time: number, start: number): number => time < start ? 0 : amplitude * (Math.exp(-(time - start) / fall) - Math.exp(-(time - start) / rise));
  return {
    stateful: false,
    ac: STATIC,
    load(call) {
      if (call.analysis === 'ac') return;
      trial = { ...accepted, outputs: accepted.outputs.slice() };
      const ctrl = control === undefined ? 1 : call.inputs[control];
      if (call.analysis === 'dc') {
        trial = initial();
        trial.control = ctrl;
      } else if (scaled) {
        for (let i = 0; i < count; i++) {
          const value = pulse(call.time, delay + delays[i]) * scaling[i] / sum;
          trial.outputs[first + i] = value;
          if (monitor !== undefined) trial.outputs[monitor] = value;
        }
      } else {
        if (accepted.control !== undefined && accepted.control < threshold && ctrl >= threshold) {
          trial.start = call.time + delay;
          trial.port = 0;
        }
        trial.control = ctrl;
        const value = pulse(call.time, trial.start);
        // cfunc.mod:300-320 advances before assigning out. Other ports retain
        // their last assigned value, including the preceding pulse's tiny tail.
        if (call.time > trial.start + period * 0.9) {
          trial.start += period;
          trial.port++;
          if (trial.port >= count) {
            if (!flag(params, 'perlim')) trial.port = 0;
            else trial.start = 1e12;
          }
        }
        if (trial.port < count) {
          trial.outputs[first + trial.port] = value;
          if (monitor !== undefined) trial.outputs[monitor] = value;
        }
      }
      call.outputs.set(trial.outputs);
    },
    accept() { accepted = trial; },
    breakpoints() {
      const starts = scaled ? delays.map(d => delay + d) : [accepted.start];
      return starts.flatMap(start => [start, start + peakTime]);
    },
    reset() { accepted = initial(); trial = initial(); },
  };
};
