import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { ControlScriptError } from './errors.js';

const deck = (script: string) => `goto tests\nV1 1 0 1\nR1 1 0 1k\n.control\n${script}\n.endc\n.end`;
const run = (script: string) => simulate(deck(script));

// ngspice-47 src/frontend/control.c: findlabel searches siblings only;
// doblock propagates unresolved jumps outward, never into a nested block.
describe('ngspice label/goto (#1459)', () => {
  it('jumps backward from an if to an enclosing label', async () => {
    const result = await run('let n = 0\nlabel again\nlet n = n + 1\nif n < 3\ngoto again\nend\necho $&n');
    expect(result.control?.output).toEqual(['3']);
  });

  it('jumps forward, substituting the goto target and skipping commands', async () => {
    const result = await run('set target = done\ngoto $target\necho skipped\nlabel done\necho reached');
    expect(result.control?.output).toEqual(['reached']);
  });

  it('reports an unknown label as a structured runtime error', async () => {
    await expect(run('goto missing')).rejects.toMatchObject({
      name: 'ControlScriptError', code: 'CONTROL_SCRIPT_ERROR', line: 5, context: 'goto missing',
      message: expect.stringContaining('label missing not found'),
    });
  });

  it.each([
    'goto inside\nif 1\nlabel inside\nend',
    'if 1\ngoto sibling\nelse\nlabel sibling\nend',
    'label lower\ngoto LOWER',
  ])('does not jump into a nested/sibling branch or fold label case: %s', async script => {
    await expect(run(script)).rejects.toBeInstanceOf(ControlScriptError);
  });

  it.each(['while 1', 'dowhile 1', 'repeat 3', 'foreach value a b'])('jumps out of %s without running the rest of it', async opening => {
    const result = await run(`${opening}\ngoto done\necho skipped\nend\nlabel done\necho reached`);
    expect(result.control?.output).toEqual(['reached']);
  });

  it('resolves the nearest label and the first duplicate in a block', async () => {
    const result = await run('if 1\ngoto same\nlabel same\necho inner\nend\ngoto same\nlabel same\necho outer\ngoto done\nlabel same\necho skipped\nlabel done');
    expect(result.control?.output).toEqual(['inner', 'outer']);
  });

  it.each(['goto', 'label'])('rejects a missing %s name with a structured error', async command => {
    await expect(run(command)).rejects.toBeInstanceOf(ControlScriptError);
  });

  it('guards a backward jump loop with the existing iteration limit', async () => {
    await expect(run('label forever\ngoto forever')).rejects.toThrow('loop exceeded 1000000 iterations');
  }, 15_000);
});
