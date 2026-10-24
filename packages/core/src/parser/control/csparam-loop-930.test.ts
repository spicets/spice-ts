import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse, parseAsync, parseTitleless, parseTitlelessAsync } from '../index.js';

const receipt = new URL('../../../../../benchmarks/control-loop-scalars-20261013/minimal.cir', import.meta.url);

describe('.csparam control constants (#930)', () => {
  it('makes deck constants visible after selecting a new plot, like ngspice-47', async () => {
    const result = await simulate(readFileSync(receipt, 'utf8'));
    expect(result.control?.output).toEqual(['bounds 1000 100 -50']);
    expect(result.control?.runs).toHaveLength(1);
  });

  it('already preserves let constants across new plots without .csparam', async () => {
    const deck = readFileSync(receipt, 'utf8')
      .replace(/\.csparam[^\n]*\n/g, '')
      .replace('.control\n', '.control\nlet start = 1k\nlet end = 0.1k\nlet delta = 0.05k\n');
    const result = await simulate(deck);
    expect(result.control?.output).toEqual(['bounds 1000 100 -50']);
    expect(result.control?.runs).toHaveLength(1);
  });

  it('threads evaluated constants through all four parse entry points', async () => {
    const body = `.param base = 7
.func twice(x) {2*x}
.csparam VALUE = {twice(base)}
.control
echo $&value
.endc
.end`;
    const circuits = [parse(`title\n${body}`), parseTitleless(body),
      await parseAsync(`title\n${body}`), await parseTitlelessAsync(body)];
    for (const circuit of circuits) expect(circuit.controlScript?.constants).toEqual({ value: 14 });
  });

  it('retains include evaluation, selected branches and last selected definition', async () => {
    const circuit = await parseAsync(`title
.include constants.inc
.if (enabled)
.csparam answer = {base+1}
.else
.csparam answer = {missing}
.endif
.control
echo $&answer
.endc
.end`, async () => '.param enabled = 1 base = 4\n.csparam answer = {base}');
    expect(circuit.controlScript?.constants).toEqual({ answer: 5 });
  });

  it('preserves assignment to an existing const vector across plot destruction (ngspice-47)', async () => {
    const result = await simulate(`title
R1 n1 0 1k
V1 n1 0 1
.csparam value = 3
.control
set curplot = new
let value = 9
echo $&value $&const.value
destroy $curplot
echo $&value
quit
.endc
.end`);
    expect(result.control?.output).toEqual(['9 9', '9']);
  });

  it('does not expose .param values as control vectors and diagnoses false conditions', async () => {
    const result = await simulate(`title
.param hidden = 7
.csparam visible = {hidden}
.control
if hidden < visible
echo bad
end
.endc
.end`);
    expect(result.control?.output).toEqual([]);
    expect(result.warnings?.map(warning => warning.message).join('\n')).toContain("no such vector 'hidden'");
  });

  it('keeps bad .csparam expression diagnostics at the source card', () => {
    expect(() => parse('title\n.csparam value = {missing}\n.end')).toThrow(/line 2/);
  });

  it.each(['instance-loop', 'loop-instance'])('executes all 19 OPs of unchanged %s', async name => {
    const path = new URL(`../../../../../benchmarks/corpus/corpus-f/fixtures/examples/loops/${name}.cir`, import.meta.url);
    const result = await simulate(readFileSync(path, 'utf8'));
    expect(result.control?.runs).toHaveLength(19);
    expect(result.control?.runs.every(run => run.analysis === 'op')).toBe(true);
  });
});
