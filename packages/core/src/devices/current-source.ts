import type { ACRHSContribution, DeviceModel, StampContext, TransientBreakpointSink } from './device.js';
import type { SourceWaveform } from '../types.js';
import { TransientNoiseContext, type NoiseHandle } from './transient-noise.js';
import {
  effectivePulse, evaluateAm, evaluateExp, evaluatePulse, evaluatePwl, evaluateSffm, evaluateSin,
  PulseBreakpointSchedule, PwlBreakpointSchedule, initialPulseBreakpoints, pwlBreakpoints, requireStopTimeForDefaults,
} from './voltage-source.js';

export class CurrentSource implements DeviceModel {
  readonly branches: number[] = [];
  readonly isNonlinear = false;
  private transientTimestep = 0;
  /** Transient TSTOP (ngspice CKTfinalTime), used by SFFM/AM frequency defaults. */
  private transientStopTime: number | undefined;
  /** Current at the last load: ngspice ISRCcurrent, the `@i[current]` readout (undefined before any load). */
  lastCurrent: number | undefined;
  /** TRNOISE/TRRANDOM state (ngspice ISRCtrnoise_state/ISRCtrrandom_state). */
  private readonly noise?: NoiseHandle;
  /** Present for noisy sources and accept-time PULSE/PWL breakpoint scheduling. */
  readonly acceptTransientStep?: (ctx: StampContext, breakpoints?: TransientBreakpointSink) => void;
  /**
   * False for PULSE/PWL: their accept hooks only schedule breakpoints,
   * so it must not put its nodes under the node-voltage LTE.
   */
  readonly storesCharge?: boolean;
  /** ngspice accept-time PWL corners (isrcacct.c). */
  private readonly pwlSchedule?: PwlBreakpointSchedule;
  private readonly pulseSchedule?: PulseBreakpointSchedule;

  /**
   * @param noiseContext - shared random stream of the circuit's TRNOISE and
   *   TRRANDOM sources; a private one is created when absent.
   * @param multiplier - ngspice `m` (ISRCmValue): isrcload.c and isrcacld.c
   *   scale the DC, transient and AC loads by it; cktdisto.c does not.
   */
  constructor(
    readonly name: string,
    readonly nodes: number[],
    public waveform: SourceWaveform,
    noiseContext?: TransientNoiseContext,
    public multiplier = 1,
  ) {
    if (waveform.type === 'trnoise' || waveform.type === 'trrandom') {
      const noise = (noiseContext ?? new TransientNoiseContext()).register('I', name, waveform);
      this.noise = noise;
      this.acceptTransientStep = (ctx, breakpoints) => noise.accept(ctx.time, breakpoints);
    } else if (waveform.type === 'pulse') {
      const schedule = new PulseBreakpointSchedule();
      this.pulseSchedule = schedule;
      this.storesCharge = false;
      this.acceptTransientStep = (ctx, breakpoints) => {
        if (this.waveform.type !== 'pulse') return;
        const next = schedule.next(effectivePulse(this.waveform, this.transientTimestep), ctx.time,
          this.transientStopTime ?? Infinity, this.transientTimestep);
        if (next !== undefined) breakpoints?.schedule(next);
      };
    } else if (waveform.type === 'pwl') {
      const schedule = new PwlBreakpointSchedule(waveform);
      this.pwlSchedule = schedule;
      this.storesCharge = false;
      this.acceptTransientStep = (ctx, breakpoints) => {
        const next = schedule.next(ctx.time, this.transientStopTime ?? Infinity, this.transientTimestep);
        if (next !== undefined) breakpoints?.schedule(next);
      };
    }
  }

  stamp(ctx: StampContext): void {
    const [nPlus, nMinus] = this.nodes;
    const current = this.multiplier * this.getValue(ctx) * ctx.sourceScale;
    this.lastCurrent = current;

    // SPICE defines positive current from the first node to the second.
    if (nPlus >= 0) ctx.stampB(nPlus, -current);
    if (nMinus >= 0) ctx.stampB(nMinus, current);
  }

  getCurrentAtTime(time: number): number {
    switch (this.waveform.type) {
      case 'dc':
        return this.waveform.value;
      case 'pulse':
        return evaluatePulse(this.waveform, time, this.transientTimestep);
      case 'sin':
        return evaluateSin(this.waveform, time);
      case 'pwl':
        return evaluatePwl(this.waveform, time);
      case 'exp':
        return evaluateExp(this.waveform, time, this.transientTimestep);
      case 'sffm':
        return evaluateSffm(this.waveform, time, this.transientStopTime);
      case 'am':
        return evaluateAm(this.waveform, time, this.transientStopTime);
      case 'trnoise':
      case 'trrandom':
        // ngspice-47 isrcload.c adds the DC value when one is given.
        return (this.waveform.dc ?? 0) + this.noise!.value(time);
      case 'ac':
        return this.waveform.dc ?? 0;
    }
  }

  private getValue(ctx: StampContext): number {
    if (ctx.useDcSourceValue && this.waveform.type !== 'dc' && this.waveform.dc !== undefined) {
      return this.waveform.dc;
    }
    return this.getCurrentAtTime(ctx.time);
  }

  getACExcitation(): ACRHSContribution | null {
    const excitation = this.waveform.type === 'ac' ? this.waveform : this.waveform.ac;
    if (!excitation) return null;
    const [positiveNode, negativeNode] = this.nodes;
    return {
      kind: 'node-pair',
      positiveNode,
      negativeNode,
      magnitude: this.multiplier * excitation.magnitude,
      phase: excitation.phase,
    };
  }

  setTransientTimestep(timestep: number, stopTime?: number): void {
    requireStopTimeForDefaults(this.name, this.waveform, stopTime);
    this.transientTimestep = timestep;
    this.transientStopTime = stopTime;
  }

  getBreakpoints(stopTime: number): number[] {
    if (this.waveform.type === 'pulse') {
      return initialPulseBreakpoints(effectivePulse(this.waveform, this.transientTimestep), stopTime, this.transientTimestep);
    }
    if (this.waveform.type === 'pwl') {
      return pwlBreakpoints(this.waveform, stopTime, this.transientTimestep);
    }
    if (this.noise) return this.noise.breakpoints(stopTime);
    return [];
  }

  resetTransient(): void {
    this.noise?.resetTransient();
    this.pwlSchedule?.reset();
    this.pulseSchedule?.reset();
  }
}
