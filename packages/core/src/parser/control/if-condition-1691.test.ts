import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

describe('ngspice-47 condition recovery (#1691)', () => {
  it('reports a bare if and executes else without aborting the script', async () => {
    const result = await simulate(`bare if
V1 1 0 42
R1 1 0 1k
.control
if
  echo wrong
else
  echo false
end
op
.endc
.end`);
    expect(result.control!.output).toEqual(['false']);
    expect(result.warnings?.map(warning => warning.message)).toContain('Error: missing if condition.');
    expect(result.dc!.voltage('1')).toBe(42);
  });
  it.each([
    ['empty string', 'set flag=""', '$flag', 'false'],
    ['boolean variable', 'set flag', '$flag', 'TRUE'],
    ['missing variable', '', '$missing', 'false'],
    ['unavailable vector', '', 'missing = 3.3', 'false'],
    ['unequal vector', 'let flag = 3.5', 'flag = 3.3', 'false'],
    ['equal vector', 'let flag = 3.5', 'flag = 3.5', 'true'],
  ])('evaluates %s like cp_istrue and continues', async (_, setup, condition, expected) => {
    const result = await simulate(`condition
V1 1 0 42
R1 1 0 1k
.control
${setup}
if ${condition}
  echo ${expected === 'TRUE' ? '$flag' : 'true'}
else
  echo false
end
op
.endc
.end`);
    expect(result.control!.output).toEqual([expected]);
    expect(result.dc!.voltage('1')).toBe(42);
    const diagnostics = result.warnings?.map(warning => warning.message) ?? [];
    if (condition.includes('missing')) {
      expect(diagnostics.join('\n')).toContain(condition === '$missing' ? 'no such variable' : 'no such vector');
    } else {
      expect(diagnostics).toEqual([]);
    }
  });

  it('matches all echo lines of the unchanged corpus-f if-test-1 deck', async () => {
    const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/control_structs/if-test-1.cir', import.meta.url), 'utf8');
    const result = await simulate(deck);
    // ngspice-47 -b on identical bytes, excluding headers and analysis/print output.
    expect(result.control!.output).toEqual([
      'expect Error: missing if condition', 'nonetheless evaluated as FALSE', '',
      'expect |false|', '|false|', '',
      'expect testvar_c=|TRUE|', 'testvar_c=|TRUE|', '',
      'expect Error: testvar_d: no such variable.', 'nonetheless evaluated as FALSE', '',
      'expect Error(parse.c--checkvalid): testvar_e: no such vector.', 'nonetheless evaluated as FALSE', '',
      'expect |false|', '|false|', '', 'expect |true|', '|true|', '',
    ]);
    expect(result.dc!.voltage('1')).toBe(42);
  });

  it('still rejects failed expressions outside conditions and unsupported conditions', async () => {
    for (const command of ['let x = missing', 'echo $missing', 'if unsupported_function(1)\nend']) {
      await expect(simulate(`strict\nV1 1 0 1\nR1 1 0 1k\n.control\n${command}\n.endc\n.end`)).rejects.toThrow();
    }
  });
});
