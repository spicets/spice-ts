import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const circuit = 'unary not\nV1 1 0 1\nR1 1 0 1k';

// ngspice-47 batch-mode results. endif is a built-in alias for end (cpitf.c).
describe('control unary not (#1455)', () => {
  it.each([
    ['not $?batchmode', 'false'],
    ['not 0', 'true'],
    ['!(1)', 'false'],
    ['!0', 'true'],
    ['not not 1', 'true'],
    ['not 1 + 1', 'false'],
    ['1 != 0', 'true'],
  ])('evaluates if %s with endif', async (condition, expected) => {
    const result = await simulate(`${circuit}\n.control
if ${condition}
  echo true
else
  echo false
endif
.endc\n.end`);
    expect(result.control!.output).toEqual([expected]);
  });

  it('matches nested if/else/endif with mixed not spellings and end', async () => {
    const result = await simulate(`${circuit}\n.control
if not 0
  if !(1)
    echo wrong
  else
    if not $?batchmode
      echo wrong-batch
    else
      echo nested
    endif
  end
else
  echo wrong-outer
endif
if !0
  echo after
endif
.endc\n.end`);
    expect(result.control!.output).toEqual(['nested', 'after']);
  });

  it('evaluates symbolic not in let and while through the shared expression path', async () => {
    const result = await simulate(`${circuit}\n.control
let done = 0
while !done
  let done = !0
end
echo $&done
.endc\n.end`);
    expect(result.control!.output).toEqual(['1']);
  });
});
