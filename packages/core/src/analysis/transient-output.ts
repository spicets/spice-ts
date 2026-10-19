import { TransientResult } from '../results.js';
import type { TransientAnalysis } from '../types.js';

interface OutputPoint { time: number; fraction: number }

/** Output-only state. Never feeds the accepted-point driver or its breakpoints. */
export class TransientOutputGrid {
  private next: number;
  private previous = 0;

  constructor(private readonly analysis: TransientAnalysis) {
    this.next = (analysis.startTime ?? 0) + analysis.timestep;
  }

  accept(time: number): OutputPoint | undefined {
    // ngspice-47 src/frontend/outitf.c:1506-1544,1653-1699:
    // origin = TSTART + TSTEP; retain exact TSTART/TSTOP, not breakpoints.
    // Emit at most ONE grid point per accepted point, even with TMAX > TSTEP.
    // Repeated addition (not index*TSTEP) preserves the oracle's roundoff.
    let point: OutputPoint | undefined;
    if (time === (this.analysis.startTime ?? 0) || time >= this.analysis.stopTime) {
      point = { time, fraction: 1 };
    } else if (time >= this.next) {
      point = { time: this.next, fraction: time === this.next ? 1 : (this.next - this.previous) / (time - this.previous) };
      this.next += this.analysis.timestep;
    }
    // outitf.c:1731-1746,1776 keeps the last ACCEPTED value/time, even
    // when that point was discarded; never interpolate from a saved grid value.
    this.previous = time;
    return point;
  }
}

export function interpolateOutputValue(previous: number, current: number, fraction: number): number {
  return fraction === 1 ? current : previous + fraction * (current - previous);
}

/** Both raw-file and in-memory plots use INTERP (outitf.c:664-677), so
 * callers must transform before exposing vectors to .meas or .control. */
export function interpolateTransientOutput(result: TransientResult, analysis: TransientAnalysis): TransientResult {
  const grid = new TransientOutputGrid(analysis);
  const points: { index: number; time: number; fraction: number }[] = [];
  result.time.forEach((time, index) => {
    const point = grid.accept(time);
    if (point) points.push({ index, ...point });
  });
  const resample = (values: ArrayLike<number>): number[] => points.map(({ index, fraction }) =>
    interpolateOutputValue(index === 0 ? 0 : values[index - 1], values[index], fraction));
  return new TransientResult(
    points.map(point => point.time),
    new Map([...result.voltages].map(([name, values]) => [name, resample(values)])),
    new Map([...result.currents].map(([name, values]) => [name, resample(values)])),
    result.digitalNodes,
    new Map([...result.deviceVectors].map(([name, values]) => [name, Float64Array.from(resample(values))])),
  );
}
