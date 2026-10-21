import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { multiInputPwl } from './multi-input-pwl.js';
import type { ResolvedXspiceParams } from './models.js';

const fixture = (name: string) => readFileSync(new URL(`../../../../../benchmarks/xspice-multi-input-pwl/${name}.cir`, import.meta.url), 'utf8');
const transfer = (x: number) => x <= -1 ? -2 : x <= 0 ? 2 * x : x <= 1 ? 3 * x : x < 2 ? x + 2 : 4;

describe('ngspice-47 multi_input_pwl min/max', () => {
  it.each(['and', 'or'])('stamps the active-input Jacobian for %s, including ties and clamps', mode => {
    const params: ResolvedXspiceParams = new Map([
      ['x', [-1, 0, 1, 2]], ['y', [-2, 0, 3, 4]], ['model', [mode]],
    ]);
    const model = multiInputPwl(params);
    const evaluate = (inputs: number[]) => {
      const outputs = new Float64Array(1), partials = new Float64Array(inputs.length);
      model.load({ analysis: 'dc', init: false, time: 0, delta: 0,
        inputs: Float64Array.from(inputs), outputs, partials, notConverged() {} });
      return { output: outputs[0], partials: Array.from(partials) };
    };
    const inputs = mode === 'and' ? [0.25, 0.6, 0.8] : [0.25, 0.6, 0.1];
    const result = evaluate(inputs);
    for (let i = 0; i < inputs.length; i++) {
      const perturbed = [...inputs];
      perturbed[i] += 1e-6;
      expect((evaluate(perturbed).output - result.output) / 1e-6).toBeCloseTo(result.partials[i], 8);
    }
    expect(evaluate([0.5, 0.5]).partials).toEqual([3, 0]);
    expect(evaluate([-3, -3]).partials).toEqual([0, 0]);
    expect(evaluate([3, 3]).partials).toEqual([0, 0]);
    expect(model.acGains!(1)).toEqual([{ real: 0, imaginary: 0 }, { real: 0, imaginary: 0 }]);
  });

  it('supports non-ground differential inputs and output, and defaults to and', async () => {
    const result = await simulate(`differential ports
vref ref 0 10
v1 a ref 0.25
v2 b ref 0.6
a1 [a ref b ref] out ref m
.model m multi_input_pwl(x=[0 1] y=[0 3])
.op
.end`);
    expect(result.dc!.voltage('out')).toBeCloseTo(10.75, 10);
  });

  it('keeps the ngspice-47 zero AC gain despite the DC Jacobian', async () => {
    const deck = fixture('dc').replace('dc 0\n', 'dc 0.25 ac 1\n').replace('.dc v1 -2 3 0.05', '.ac lin 1 1 1');
    const result = await simulate(deck);
    expect(result.ac!.voltage('low')[0].magnitude).toBe(0);
    expect(result.ac!.voltage('high')[0].magnitude).toBe(0);
  });

  it('converges with a controlling input in a resistive feedback loop', async () => {
    const result = await simulate(`feedback
v1 in 0 2
a1 [in 0 fb 0] out 0 m
r1 out fb 1k
r2 fb 0 1k
.model m multi_input_pwl(x=[-10 10] y=[11 -9])
.op
.end`);
    expect(result.dc!.voltage('out')).toBeCloseTo(2 / 3, 10);
    expect(result.dc!.voltage('fb')).toBeCloseTo(1 / 3, 10);
  });

  it.each(['model="nand"', 'model="nor"', 'model="xor"', 'x=[0 0 1 2]'])('rejects unsupported or invalid parameters: %s', invalid => {
    const deck = fixture('dc').replace(invalid.startsWith('model') ? 'model="and"' : 'x=[-1 0 1 2]', invalid);
    return expect(simulate(deck)).rejects.toMatchObject({ name: 'InvalidCircuitError' });
  });

  it('runs both two-input models over a DC sweep including clamps and corners', async () => {
    const sweep = (await simulate(fixture('dc'))).dcSweep!;
    const low = sweep.voltage('low'), high = sweep.voltage('high');
    for (let i = 0; i < low.length; i++) {
      const x = -2 + i * 0.05;
      expect(low[i]).toBeCloseTo(transfer(Math.min(x, 0.6)), 9);
      expect(high[i]).toBeCloseTo(transfer(Math.max(x, 0.6)), 9);
    }
    expect(low).toHaveLength(101);
  });

  it('runs PULSE/SIN inputs in transient', async () => {
    const tran = (await simulate(fixture('tran'))).transient!;
    const a = tran.voltage('in1'), b = tran.voltage('in2');
    const low = tran.voltage('low'), high = tran.voltage('high');
    expect(tran.time.length).toBeGreaterThan(1000);
    for (let i = 0; i < tran.time.length; i++) {
      expect(low[i]).toBeCloseTo(transfer(Math.min(a[i], b[i])), 7);
      expect(high[i]).toBeCloseTo(transfer(Math.max(a[i], b[i])), 7);
    }
  });

  it('reports mismatched lengths rather than ngspice-47 diagnostic + truncation', async () => {
    // ngspice-47 cfunc.mod logs "not the same size" and reduces PARAM_SIZE(x)
    // when x is longer. Reject safely instead of silently changing the table.
    await expect(simulate(fixture('dc').replace('y=[-2 0 3 4]', 'y=[-2 0 3]')))
      .rejects.toMatchObject({ name: 'InvalidCircuitError', message: expect.stringMatching(/multi_input_pwl.*same size/) });
  });
});
