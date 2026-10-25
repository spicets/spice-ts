import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { InvalidCircuitError } from '../../errors.js';
import { readFileSync } from 'node:fs';
import { MAGNETIC_BEHAVIORS } from './magnetic-models.js';
import type { CodeModelCall, ResolvedXspiceParams } from './models.js';

const core = '.model c core(h_array=[-2 -1 1 2] b_array=[-3 -1 1 3] area=2 length=0.5 input_domain=0.1)';
// Reference values checked with Homebrew ngspice-47 on these same decks.
const winding = ['winding', 'i1 0 1 DC 0.2', 'i2 2 0 DC 0 PWL(0 0 1 1) AC 1', 'a1 (1 0) (2 0) winding', '.model winding lcouple(num_turns=10)'];

describe('XSPICE magnetic models', () => {
  it('runs the unchanged Transformer with the 59-point ngspice grid (no artificial magnetic LTE)', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-i/fixtures/esim/Examples/Transformer/Transformer.cir.out', import.meta.url), 'utf8');
    const result = await simulate(deck);
    expect(result.transient!.time).toHaveLength(59);
    expect(result.transient!.time.at(-1)).toBeCloseTo(0.1, 14);
  });
  it.each([[-1, 6], [-0.5, 2.05], [0, 0], [0.5, -2.05], [1, -6]])('core PWL at %s V', async (v, current) => {
    const result = await simulate(['core', `v1 1 0 ${v}`, 'a1 1 0 c', core, '.op', '.end'].join('\n'));
    expect(result.dc!.current('v1')).toBeCloseTo(current, 8);
  });

  it('couples winding current into magnetomotive force', async () => {
    const result = await simulate(['winding', 'i1 0 1 0.2', 'a1 (1 0) (2 0) winding', '.model winding lcouple(num_turns=10)', 'r2 2 0 1k', '.op', '.end'].join('\n'));
    expect(result.dc!.voltage('2')).toBeCloseTo(2, 10);
    expect(result.dc!.voltage('1')).toBeCloseTo(0, 10);
  });

  it.each([3, 0, -1])('rejects unsupported core mode=%s with a typed error', async mode => {
    await expect(simulate(['core', 'v1 1 0 0', 'a1 1 0 c', core.replace('input_domain=0.1', `mode=${mode}`), '.op', '.end'].join('\n'))).rejects.toThrow(InvalidCircuitError);
  });

  it('traces repeated core mode=2 hysteresis loops without geometry scaling', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/xspice-core-hysteresis/loop.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    const tran = result.transient!;
    const input = tran.voltage('mmf');
    const current = tran.current('vdrive');
    // ngspice core mode=2 uses the input directly, not H=MMF/length or flux=B*area.
    const lower = -2;
    const upper = 3;
    const slope = 2.5;
    const width = 0.2; // fraction * (in_high - in_low)
    const ramp = (x: number, start: number, end: number): number => {
      if (x <= start - width) return lower;
      if (x <= start + width) return lower + slope * (x - start + width) ** 2 / (4 * width);
      if (x <= end - width) return lower + slope * (x - start);
      if (x <= end + width) return upper - slope * (end + width - x) ** 2 / (4 * width);
      return upper;
    };
    expect(tran.time.at(-1)).toBeCloseTo(0.007, 12);
    expect(Math.min(...current)).toBeCloseTo(-upper, 9);
    expect(Math.max(...current)).toBeCloseTo(-lower, 9);
    for (let i = 0; i < tran.time.length; i++) {
      const time = tran.time[i];
      const rising = time <= 0.001 || (time > 0.003 && time <= 0.005);
      const shift = rising ? 0.3 : -0.3;
      expect(current[i], `core current at t=${time}`).toBeCloseTo(-ramp(input[i], -1 + shift, 1 + shift), 8);
    }
  });

  it('commits only accepted mode=2 transient legs, preserves the OP leg and resets', () => {
    const params: ResolvedXspiceParams = new Map<string, readonly (number | boolean)[]>([
      ['mode', [2]], ['in_low', [-1]], ['in_high', [1]], ['hyst', [0.3]],
      ['out_lower_limit', [-2]], ['out_upper_limit', [3]],
      ['input_domain', [0.1]], ['fraction', [true]],
    ]);
    // No PWL arrays or geometry are needed in mode=2.
    const model = MAGNETIC_BEHAVIORS.get('core')!(params, {
      connections: [], netlist: { capacitance: () => 0, inductance: () => 0 },
    });
    const call = (input: number, analysis: CodeModelCall['analysis'] = 'tran'): CodeModelCall => ({
      analysis, init: false, time: analysis === 'dc' ? 0 : 1e-5, delta: 1e-5,
      inputs: new Float64Array([input]), outputs: new Float64Array(1), partials: new Float64Array(1),
      notConverged() {},
    });
    const output = (input: number): number => {
      const trial = call(input);
      model.load(trial);
      return trial.outputs[0];
    };
    model.load(call(2, 'dc'));
    model.beginTransient!();
    expect(output(0)).toBeCloseTo(1.25, 12); // falling leg carried from OP
    expect(output(-2)).toBe(-2); // rejected trial must not switch the committed leg
    expect(output(0)).toBeCloseTo(1.25, 12);
    model.accept!(call(-2));
    expect(output(0)).toBeCloseTo(-0.25, 12); // accepted trial switches to rising
    model.accept!(call(2));
    expect(output(0)).toBeCloseTo(1.25, 12);
    model.reset!();
    expect(output(0)).toBeCloseTo(-0.25, 12); // INIT chooses rising again
  });

  it('differentiates flux with the ngspice backward difference and sign', async () => {
    const result = await simulate([...winding, '.tran .1 1', '.end'].join('\n'));
    const tran = result.transient!;
    expect(tran.voltage('1')[0]).toBe(0);
    for (let i = 1; i < tran.time.length; i++) {
      expect(tran.voltage('1')[i]).toBeCloseTo(10, 7);
      expect(tran.voltage('2')[i]).toBeCloseTo(2, 10);
    }
  });

  it('stamps only the flux-to-winding AC pair with the ngspice AC sign', async () => {
    const result = await simulate([...winding, '.ac lin 1 1 1', '.end'].join('\n'));
    const point = result.ac!.voltage('1')[0];
    expect(point.magnitude).toBeCloseTo(62.83185307179586, 10);
    expect(point.phase).toBeCloseTo(-90, 10);
    expect(result.ac!.voltage('2')[0].magnitude).toBeCloseTo(0, 10);
  });

  it.each([
    core.replace('b_array=[-3 -1 1 3]', 'b_array=[-1 1]'),
    core.replace('h_array=[-2 -1 1 2]', 'h_array=[-2 1 -1 2]'),
    core.replace('length=0.5', 'length=0'),
    core.replace('input_domain=0.1', 'input_domain=0.5 fraction=false').replace('h_array=[-2 -1 1 2]', 'h_array=[-2 -1.5 1 2]'),
  ])('rejects invalid core parameters', async model => {
    await expect(simulate(['core', 'v1 1 0 0', 'a1 1 0 c', model, '.op', '.end'].join('\n'))).rejects.toThrow(InvalidCircuitError);
  });
});
