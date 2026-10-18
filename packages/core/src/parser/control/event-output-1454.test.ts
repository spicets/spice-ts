import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { ControlScriptError } from './errors.js';

const circuit = [
  'event output', 'v1 1 0 PULSE(0 1 1n 1n 1n 5n 20n)', 'r1 1 0 1k',
  'a1 [1] [DIN] adc', '.model adc adc_bridge (in_low=0.3 in_high=0.7)',
  'a2 din DOUT inv', '.model inv d_inverter (rise_delay=1n fall_delay=1n)',
];
const deck = (...commands: string[]) => [...circuit, '.control', ...commands, '.endc', '.end'].join('\n');
const rows = (output: string[]) => output.join('\n').split('\n')
  .filter(line => /^(DCOP|\d\.\d+e[+-]\d+)/.test(line)).map(line => line.trim().split(/\s+/));

describe('event output (#1454)', () => {
  it('prints DCOP and the merged timeline, retaining unchanged node values and drive strengths', async () => {
    const result = await simulate(deck('tran 1n 10n', 'eprint DIN DOUT'));
    const output = result.control!.output;
    expect(output.join('\n')).toContain('**** Results Data ****\n\nTime or Step\nDIN\nDOUT');
    const histories = ['DIN', 'DOUT'].map(node => result.transient!.digital(node));
    const actual = rows(output);
    expect(actual[0]).toEqual(['DCOP', '0s', '1s']);
    const times = [...new Set(histories.flatMap(history => history.slice(1).map(event => event.time)))].sort((a, b) => a - b);
    expect(actual).toHaveLength(times.length + 1);
    times.forEach((time, index) => {
      expect(Number(actual[index + 1][0])).toBeCloseTo(time, 18);
      expect(actual[index + 1].slice(1)).toEqual(histories.map(history => {
        const event = history.filter(event => event.time <= time).at(-1)!;
        return event.state + event.strength;
      }));
    });
    expect(output.join('\n')).not.toContain('Statistics');
  });

  it('lists event nodes and their digital type', async () => {
    const result = await simulate(deck('tran 1n 10n', 'edisplay'));
    expect(result.control!.output.join('\n')).toMatch(/DIN\s+: digital,\s+\d+/);
    expect(result.control!.output.join('\n')).toMatch(/DOUT\s+: digital,\s+\d+/);
  });

  it('uses the latest transient event history, not the selected plot', async () => {
    const result = await simulate(deck('tran 1n 3n', 'tran 1n 10n', 'setplot tran1', 'eprint dout'));
    const data = rows(result.control!.output);
    expect(data.length).toBeGreaterThan(2);
    expect(Number(data.at(-1)![0])).toBeGreaterThan(3e-9);
    expect(data[0]).toEqual(['DCOP', '1s']);
  });

  it('reports unknown event nodes with command and line context', async () => {
    await expect(simulate(deck('tran 1n 10n', 'eprint missing'))).rejects.toMatchObject({
      name: 'ControlScriptError', code: 'CONTROL_SCRIPT_ERROR', context: 'eprint missing',
    });
    await expect(simulate(deck('tran 1n 10n', 'eprint 1'))).rejects.toThrow(/not an event node/);
  });

  it('requires an event history instead of silently succeeding', async () => {
    await expect(simulate(deck('eprint DIN'))).rejects.toBeInstanceOf(ControlScriptError);
  });

  it('prints eprint usage without operands', async () => {
    const result = await simulate(deck('tran 1n 10n', 'eprint'));
    expect(result.control!.output.join('\n')).toContain('Usage: eprint <node1> <node2> ...');
  });

  it('enforces the ngspice 32-node argument limit', async () => {
    await expect(simulate(deck('tran 1n 10n', `eprint ${Array(33).fill('DIN').join(' ')}`)))
      .rejects.toThrow(/limited to 32 arguments/);
  });
});
