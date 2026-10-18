import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { delay } from './delay-model.js';
import type { CodeModelCall, ResolvedXspiceParams } from './models.js';

function call(input: number, time: number, control = 0, analysis: CodeModelCall['analysis'] = 'tran'): CodeModelCall {
  return { inputs: Float64Array.of(input, control), outputs: new Float64Array(1), partials: new Float64Array(2),
    time, delta: 0.00001, analysis, init: false, notConverged() {} };
}
function model(extra: Record<string, number | boolean> = {}) {
  const params: ResolvedXspiceParams = new Map(Object.entries({ delay: 0.1, has_delay_cnt: false, ...extra }).map(([k, v]) => [k, [v]]));
  const behavior = delay(params);
  behavior.setTransientTimestep?.(0.00001, 1);
  const dc = call(0, 0, 0, 'dc'); behavior.load(dc); behavior.accept?.(dc);
  return behavior;
}

describe('XSPICE analog delay (#1335)', () => {
  it('delays a sine with less than 1e-3 peak-relative error', () => {
    const m = model();
    let error = 0;
    for (let i = 1; i <= 30000; i++) {
      const time = i * 0.00001;
      const c = call(Math.sin(2 * Math.PI * time), time);
      m.load(c); m.accept?.(c);
      const expected = time < 0.1 ? 0 : Math.sin(2 * Math.PI * (time - 0.1));
      error = Math.max(error, Math.abs(c.outputs[0] - expected));
    }
    expect(error).toBeLessThan(1e-3);
  });

  it.each([-1, 0, 0.5, 1, 2])('maps and clamps control %s between delmin and delmax', control => {
    const m = model({ has_delay_cnt: true, delmin: 0.02, delmax: 0.08 });
    for (let i = 1; i <= 10000; i++) {
      const c = call(i * 0.00001, i * 0.00001, control);
      m.load(c); m.accept?.(c);
      if (i === 10000) expect(c.outputs[0]).toBeCloseTo(0.1 - (0.02 + Math.min(1, Math.max(0, control)) * 0.06), 4);
    }
  });

  it('does not store rejected trials or Newton iterates, and resets history', () => {
    const m = model();
    const first = call(2, 0.01); m.load(first); m.accept?.(first);
    m.load(call(999, 0.5));
    const next = call(3, 0.02); m.load(next); m.load(next); m.accept?.(next);
    const output = call(4, 0.11); m.load(output);
    expect(output.outputs[0]).not.toBe(999);
    m.reset?.();
    const restarted = call(7, 0, 0, 'dc'); m.load(restarted);
    expect(restarted.outputs[0]).toBe(7);
    expect(Array.from(restarted.partials)).toEqual([0, 0]);
  });

  it('registers optional control, DC passthrough and zero AC gain', async () => {
    const result = await simulate('delay OP\nv1 in 0 dc 2 ac 1\na1 in out null line\n.model line delay(delay=1m)\nr1 out 0 1k\n.op\n.ac lin 1 1 1\n.end');
    expect(result.dc!.voltage('out')).toBe(2);
    expect(result.ac!.voltage('out')[0].magnitude).toBe(0);
  });

  it('runs unchanged corpus-f analog-delay1.cir', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/xspice/delay/analog-delay1.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.transient!.time.length).toBeGreaterThan(1000);
    for (let i = 1; i <= 5; i++) expect(Array.from(result.transient!.voltage(`out${i}`)).every(Number.isFinite)).toBe(true);
  });
});
