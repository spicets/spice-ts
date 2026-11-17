import { describe, expect, it } from 'vitest';

import { UnsupportedCodeModelError } from './parser/xspice-parser.js';
import { simulate } from './simulate.js';

const models = [
  '.model adc adc_bridge (in_low=.2 in_high=.8)',
  '.model inv d_inverter (rise_delay=1n fall_delay=2n)',
  '.model dac dac_bridge (out_low=0 out_high=1 t_rise=1n t_fall=1n)',
];
const body = (prefix: string, input: string, output: string, modelPrefix = prefix) => [
  `a${prefix}adc %v [${input}] %d [${prefix}din] ${modelPrefix}adc`,
  `a${prefix}inv %d ~${prefix}din %d ${prefix}dout ${modelPrefix}inv`,
  `a${prefix}dac [${prefix}dout] [${output}] ${modelPrefix}dac`,
];
const stimulus = [
  'v1 in1 0 pulse(0 1 3n 1n 1n 7n 16n)',
  'v2 in2 0 pulse(1 0 5n 1n 1n 9n 20n)',
  'r1 out1 0 1k', 'r2 out2 0 1k',
];

describe('digital XSPICE cards in subcircuits (#1283)', () => {
  it('scopes vector/scalar ports, inversion and local models independently for two instances', async () => {
    const scoped = [
      'scoped digital',
      // An incompatible global model must not override either local model.
      '.model inv d_buffer',
      '.subckt logic in out', ...body('', 'in', 'out'), ...models, '.ends',
      ...stimulus, 'x1 in1 out1 logic', 'x2 in2 out2 logic', '.tran 1n 35n', '.end',
    ].join('\n');
    const flat = [
      'flat digital', ...stimulus,
      ...body('x1.', 'in1', 'out1', 'x1:'), ...body('x2.', 'in2', 'out2', 'x2:'),
      ...['x1:', 'x2:'].flatMap(prefix => models.map(model => model.replace('.model ', `.model ${prefix}`))),
      '.tran 1n 35n', '.end',
    ].join('\n');
    const actual = (await simulate(scoped)).transient!;
    const expected = (await simulate(flat)).transient!;
    expect(actual.time).toEqual(expected.time);
    for (const output of ['out1', 'out2']) {
      expect(actual.voltage(output)).toEqual(expected.voltage(output));
      expect(Math.max(...actual.voltage(output))).toBeGreaterThan(.9);
      expect(Math.min(...actual.voltage(output))).toBeLessThan(.1);
    }
    for (const node of ['x1.din', 'x1.dout', 'x2.din', 'x2.dout']) {
      expect(actual.digital(node)).toEqual(expected.digital(node));
      expect(actual.digital(node).length).toBeGreaterThan(2);
    }
  });

  it('scopes implemented analog A-cards with a root model (#1434)', async () => {
    const result = await simulate([
      'analog subcircuit', '.model amp gain (gain=2)',
      '.subckt cell in out', 'a1 in out amp', '.ends',
      'v1 in 0 1', 'x1 in out cell', 'r1 out 0 1k', '.op', '.end',
    ].join('\n'));
    expect(result.dc!.voltage('out')).toBeCloseTo(2, 10);
  });

  it('keeps the typed error for an unimplemented code model in a subcircuit', async () => {
    await expect(simulate([
      'unsupported model', '.subckt cell in out',
      '.model unknown d_process', 'a1 in out unknown', '.ends',
      'x1 in out cell', '.op', '.end',
    ].join('\n'))).rejects.toThrow(UnsupportedCodeModelError);
  });
});
