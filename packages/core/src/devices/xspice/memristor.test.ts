import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { memristor } from './memristor.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';
import type { CodeModelCall } from './models.js';

function model(overrides: Record<string, number> = {}) {
  return memristor(new Map(Object.entries({ rmin: 10, rmax: 100, rinit: 50, alpha: 2, beta: 10, vt: 1, ...overrides }).map(([key, value]) => [key, [value]])));
}
function call(voltage: number, time = 1, delta = 1): CodeModelCall {
  return { analysis: time === 0 ? 'dc' : 'tran', init: false, time, delta,
    inputs: Float64Array.of(voltage), outputs: new Float64Array(1), partials: new Float64Array(1), notConverged() {} };
}
function resistance(behavior: ReturnType<typeof model>, point: CodeModelCall): number {
  behavior.load(point);
  return point.inputs[0] / point.outputs[0];
}

describe('ngspice XSPICE memristor', () => {
  it('advertises the gd port and upstream parameter defaults', () => {
    const spec = XSPICE_CODE_MODEL_SPECS.get('memristor')!;
    expect(spec.connections[0].allowedTypes).toEqual(['gd']);
    expect(spec.params.map(p => p.defaultValue?.[0])).toEqual([10, 10000, 7000, 0, 1, 0]);
  });
  it.each([[0.5, 51], [2, 62], [-2, 38]])('integrates the threshold function at %s V', (voltage, expected) => {
    expect(resistance(model(), call(voltage))).toBeCloseTo(expected, 12);
  });
  it('does not commit rejected loads and resets accepted history', () => {
    const behavior = model();
    const point = call(2);
    expect(resistance(behavior, point)).toBe(62);
    expect(resistance(behavior, point)).toBe(62);
    behavior.accept!(point);
    expect(resistance(behavior, call(2, 2))).toBe(74);
    behavior.reset!();
    expect(resistance(behavior, point)).toBe(62);
  });
  it.each([[100, 2, 100, -2, 88], [10, -2, 10, 2, 22]])('blocks outward motion at R=%s but permits reversal', (rinit, outward, bound, inward, reversed) => {
    const behavior = model({ rinit });
    const point = call(outward);
    expect(resistance(behavior, point)).toBe(bound);
    behavior.accept!(point);
    expect(resistance(behavior, call(inward, 2))).toBe(reversed);
  });
  it('preserves ngspice directional-window overshoot rather than clipping', () => {
    const behavior = model({ rinit: 99 });
    const point = call(2);
    expect(resistance(behavior, point)).toBe(111);
    behavior.accept!(point);
    expect(resistance(behavior, call(2, 2))).toBe(111);
  });
  it('uses rinit in DC and AC', async () => {
    const deck = 'memristor\nv1 p 0 DC 2 AC 1\na1 p 0 m\n.model m memristor(rmin=10 rmax=100 rinit=50 alpha=2 beta=10 vt=1)\n.op\n.ac lin 1 1 1\n.end';
    const result = await simulate(deck);
    expect(result.dc!.current('v1')).toBeCloseTo(-0.04, 10);
    expect(result.ac!.current('v1')[0].magnitude).toBeCloseTo(0.02, 10);
  });
  it('runs the unchanged corpus-f control deck', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/memristor/memristor_x.sp', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.transient).toBeDefined();
    expect(result.control!.runs.map(run => run.plot)).toEqual(['op1', 'ac1', 'tran1', 'tran2', 'tran3']);
    const transients = result.control!.runs.filter(run => run.analysis === 'tran');
    for (const [index, run] of transients.entries()) {
      const time = run.result.transient!.time;
      // $& substitution uses ngspice's six-significant-digit control formatting.
      expect(time.at(-1)).toBe([1e-8, 8.33333e-9, 7.14286e-9][index]);
    }
  });
});
