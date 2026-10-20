import { describe, expect, it } from 'vitest';
import { parseAsync } from '../../parser/index.js';
import { simulate } from '../../simulate.js';

const data = '# Hz S RI R 50\n10 2 0 4 0\n30 0 2 0 4\n';
const model = '.model f xfer(file="data.s1p" span=5 offset={column})';
const analysis = '.ac lin 3 10 30';

function deck(scope: 'top' | 'local' | 'nested', command = analysis): string {
  const body = ['a1 in out f', model];
  const cards = scope === 'top' ? body : [
    'x1 in out outer', '.subckt outer in out',
    ...(scope === 'nested' ? ['x2 in out inner', '.subckt inner in out', ...body, '.ends inner'] : body),
    '.ends outer',
  ];
  return ['subcircuit xfer files', '.param column=1', 'v1 in 0 dc 2 ac 1', ...cards,
    'r1 out 0 1k', command, '.end'].join('\n');
}

describe('subcircuit-local xfer files (#1561)', () => {
  it.each(['local', 'nested'] as const)('matches top-level AC through parseAsync: %s', async scope => {
    const paths: string[] = [];
    const circuit = await parseAsync(deck(scope), async path => { paths.push(path); return data; });
    const actual = (await simulate(circuit)).ac!.voltage('out');
    const expected = (await simulate(deck('top'), { resolveInclude: async () => data })).ac!.voltage('out');
    expect(paths).toEqual(['data.s1p']);
    actual.forEach((value, index) => {
      expect(Math.abs(value.magnitude - expected[index].magnitude) / expected[index].magnitude).toBeLessThan(1e-12);
      expect(value.phase).toBeCloseTo(expected[index].phase, 12);
    });
    // Compilation must not replace the resolved model with a raw local card.
    expect((await simulate(circuit)).ac!.voltage('out')).toEqual(actual);
  });

  it('shares the resolver cache across global and multiple nested instances', async () => {
    const paths: string[] = [];
    const text = deck('nested').replace('r1 out', 'x3 in other outer column=3\nr3 other 0 1k\nr1 out')
      .replace('.subckt outer in out', '.subckt outer in out params: column=1')
      .replace(analysis, `${model}\n${analysis}`);
    const result = await simulate(text, { resolveInclude: async path => { paths.push(path); return data; } });
    expect(result.ac!.voltage('out')[0].magnitude).toBeCloseTo(2, 12);
    expect(result.ac!.voltage('other')[0].magnitude).toBeCloseTo(4, 12);
    expect(paths).toEqual(['data.s1p']);
  });

  it('retains nested bytes across reset while reevaluating local parameters', async () => {
    const paths: string[] = [];
    const result = await simulate(deck('nested', [
      '.control', 'ac lin 1 10 10', 'alterparam column=3', 'reset', 'ac lin 1 10 10', '.endc',
    ].join('\n')), { resolveInclude: async path => { paths.push(path); return data; } });
    expect(result.control!.runs.map(run => run.result.ac!.voltage('out')[0].magnitude)).toEqual([2, 4]);
    expect(paths).toEqual(['data.s1p']);
  });

  it.each(['local', 'nested'] as const)('matches top-level missing-file diagnostics and zero output: %s', async scope => {
    const options = { resolveInclude: async () => { throw new Error('ENOENT'); } };
    const expected = await simulate(deck('top'), options);
    const actual = await simulate(deck(scope), options);
    expect(actual.warnings).toEqual(expected.warnings);
    expect(actual.ac!.voltage('out')).toEqual(expected.ac!.voltage('out'));
    expect(actual.ac!.voltage('out').map(value => value.magnitude)).toEqual([0, 0, 0]);
  });

  it.each(['top', 'local', 'nested'] as const)('preserves the structured no-resolver error: %s', async scope => {
    await expect(simulate(deck(scope))).rejects.toMatchObject({
      name: 'InvalidCircuitError', message: 'XSPICE xfer: file requires async parsing with a resolver',
    });
  });
});
