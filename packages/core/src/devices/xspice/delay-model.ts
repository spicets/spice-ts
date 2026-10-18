import { STATIC, type CodeModelBehavior, type ResolvedXspiceParams } from './models.js';

/**
 * ngspice-47 analog/delay/cfunc.mod:107-185 (allocation/defaults), 193-255
 * (TSTEP sampling, rounded delay and control clamp); ifspec.ifs:30-75.
 * Source revision 3ef069fb1f04177a153f342a32d941fc20ff047e, BSD-3-Clause.
 * Despite its interpolation comment, upstream uses a sampled circular buffer,
 * not linear interpolation (cfunc.mod:206-215,243-255). Keep that quantization.
 * Stage writes until accept so rejected trials cannot corrupt the buffer.
 */
export function delay(params: ResolvedXspiceParams): CodeModelBehavior {
  const value = (key: string, fallback: number): number => params.get(key)?.[0] as number | undefined ?? fallback;
  const controlled = params.get('has_delay_cnt')?.[0] === true;
  const constant = Math.max(0, value('delay', 0));
  let step = 0;
  let stop = 0;
  let buffer = new Float64Array(1);
  let count = 0;
  let start = 0;
  const reset = () => { buffer.fill(0); count = 0; start = 0; };
  const writes = (time: number) => step > 0 && time >= count * step;
  return {
    stateful: true, ac: STATIC,
    setTransientTimestep(timestep, stopTime) {
      step = timestep;
      stop = stopTime ?? 0;
      buffer = new Float64Array(Math.max(1, value('buffer_size', Math.floor(stop / step) + 1)));
      reset();
    },
    load(call) {
      call.partials.fill(0); // upstream supplies neither PARTIAL nor AC_GAIN
      if (call.analysis !== 'tran' || step === 0) {
        call.outputs[0] = call.inputs[0];
        return;
      }
      let lag = constant < step ? 0 : constant;
      if (controlled) {
        const min = Math.min(stop, Math.max(0, value('delmin', 0)));
        const max = Math.max(min, Math.min(stop, value('delmax', stop)));
        lag = min + Math.min(1, Math.max(0, call.inputs[1] ?? 0)) * (max - min);
      }
      if (call.time < lag) call.outputs[0] = start;
      else if (lag === 0) call.outputs[0] = call.inputs[0];
      else {
        const pending = writes(call.time);
        const index = ((count - Math.floor((lag + 0.5 * step) / step)) % buffer.length + buffer.length) % buffer.length;
        call.outputs[0] = pending && index === count % buffer.length ? call.inputs[0] : buffer[index];
      }
    },
    accept(call) {
      if (call.analysis === 'ac') return;
      if (call.analysis === 'dc') { reset(); start = call.inputs[0]; }
      if (call.analysis === 'dc' || writes(call.time)) {
        buffer[count % buffer.length] = call.inputs[0];
        count++;
      }
    },
    reset,
  };
}
