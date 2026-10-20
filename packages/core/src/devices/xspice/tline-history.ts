/**
 * Ceiling-sampled history shared by ngspice XSPICE mlin and cpline.
 * tline_common.c:get_state/find_cpline_state select the FIRST record at or
 * after the delayed time, including the first Newton guess at that time.
 * Stage that guess until acceptance so rejected trials cannot enter history.
 */
export class TlineHistory<T extends { time: number }> {
  private readonly points: T[] = [];
  private trial: T | undefined;

  stage(point: T): void {
    if (this.trial?.time !== point.time) this.trial = point;
  }

  find(time: number): T | undefined {
    return this.points.find(point => point.time >= time);
  }

  accept(point: T, delay: number): void {
    while (this.points.length && this.points[this.points.length - 1].time >= point.time) this.points.pop();
    this.points.push(this.trial?.time === point.time ? this.trial : point);
    this.trial = undefined;
    while (this.points.length > 1 && this.points[0].time < point.time - 1.2 * delay) this.points.shift();
  }

  reset(): void {
    this.points.length = 0;
    this.trial = undefined;
  }
}
