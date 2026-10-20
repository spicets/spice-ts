import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { touchstone } from './xfer.js';

const deck = (params: string, analysis = '.ac lin 3 10 30') => [
  'xfer contract', 'v1 in 0 dc 2 ac 1', 'a1 in out f', `.model f xfer(${params})`,
  'r1 out 0 1k', analysis, '.end',
].join('\n');

describe('ngspice-47 xfer', () => {
  it('interpolates Cartesian components, not magnitude and phase', async () => {
    const result = await simulate(deck('table=[10 0 0 30 0 90]'));
    const values = result.ac!.voltage('out');
    expect(values[0].magnitude).toBeCloseTo(1, 10);
    expect(values[1].magnitude).toBeCloseTo(Math.SQRT1_2, 10);
    expect(values[1].phase).toBeCloseTo(45, 10);
    expect(values[2].phase).toBeCloseTo(90, 10);
  });
  it('clamps endpoints and selects span/offset columns in RI format', async () => {
    const result = await simulate(deck('table=[10 99 99 2 3 20 99 99 4 5] span=5 offset=3 r_i=true', '.ac lin 3 1 31'));
    const values = result.ac!.voltage('out');
    expect(values[0].magnitude).toBeCloseTo(Math.hypot(2, 3), 10);
    expect(values[1].magnitude).toBeCloseTo(Math.hypot(3.2, 4.2), 10);
    expect(values[2].magnitude).toBeCloseTo(Math.hypot(4, 5), 10);
  });
  it('supports linear magnitude and radian phase', async () => {
    const result = await simulate(deck('table=[10 2 1.5707963267948966] db=false rad=true'));
    expect(result.ac!.voltage('out')[0].magnitude).toBeCloseTo(2, 10);
    expect(result.ac!.voltage('out')[0].phase).toBeCloseTo(90, 10);
  });
  it('uses the first real component for DC and transient', async () => {
    const params = 'table=[10 3 4] r_i=true';
    expect((await simulate(deck(params, '.op'))).dc!.voltage('out')).toBeCloseTo(6, 8);
    const result = await simulate(deck(params, '.tran 1u 3u'));
    expect(result.transient!.voltage('out').at(-1)).toBeCloseTo(6, 8);
  });
  it.each([
    'table=[10 1 0 20]','table=[20 1 0 10 1 0]',
    'table=[-1 1 0 10 1 0]', 'table=[1 1 0] span=3 offset=2',
    'file="a.s1p" table=[1 1 0]',
  ])('rejects malformed parameters: %s', params => {
    expect(() => parse(deck(params)).compile()).toThrow(/xfer/i);
  });
  it('loads Touchstone through the existing async resolver', async () => {
    const result = await simulate(deck('file="test.s1p"'), {
      resolveInclude: async path => {
        expect(path).toBe('test.s1p');
        return '! source\n# Hz S RI R 50\n10 2 0\n30 0 2\n';
      },
    });
    expect(result.ac!.voltage('out')[1].magnitude).toBeCloseTo(Math.SQRT2, 10);
    expect(result.ac!.voltage('out')[1].phase).toBeCloseTo(45, 10);
  });
  it('lets explicit format flags override Touchstone options', async () => {
    const result = await simulate(deck('file="test.s1p" r_i=false db=false rad=true'), {
      resolveInclude: async () => '# Hz S RI R 50\n10 2 1.5707963267948966\n',
    });
    expect(result.ac!.voltage('out')[0].magnitude).toBeCloseTo(2, 10);
    expect(result.ac!.voltage('out')[0].phase).toBeCloseTo(90, 10);
  });
  it('preserves zero output for a missing file rather than inventing table data', async () => {
    const result = await simulate(deck('file="missing.s1p"'), {
      resolveInclude: async () => { throw new Error('ENOENT'); },
    });
    expect(result.ac!.voltage('out')[0].magnitude).toBe(0);
  });
  it('retains loaded files across control AC, alter, and reset reparses', async () => {
    const paths: string[] = [];
    const result = await simulate(deck('file="test.s1p"', [
      '.control', 'ac lin 3 10 30', 'alter v1 acmag=2', 'ac lin 3 10 30',
      'reset', 'ac lin 3 10 30', '.endc',
    ].join('\n')), {
      resolveInclude: async path => {
        paths.push(path);
        return '# Hz S RI R 50\n10 2 0\n30 0 2\n';
      },
    });
    const runs = result.control!.runs.map(run => run.result.ac!.voltage('out'));
    expect(runs).toHaveLength(3);
    for (const [index, scale] of [1, 2, 1].entries()) {
      expect(runs[index][1].magnitude).toBeCloseTo(scale * Math.SQRT2, 10);
      expect(runs[index][1].phase).toBeCloseTo(45, 10);
    }
    expect(paths).toEqual(['test.s1p']);
  });
  it('warns and continues control AC reruns when a file is missing', async () => {
    const result = await simulate(deck('file="missing.s1p"', [
      '.temp 27', '.control', 'ac lin 3 10 30', 'alter v1 acmag=2', 'ac lin 3 10 30',
      'reset', 'ac lin 3 10 30', '.endc',
    ].join('\n')), { resolveInclude: async () => { throw new Error('ENOENT'); } });
    expect(result.control!.runs).toHaveLength(3);
    for (const run of result.control!.runs) {
      expect(run.result.ac!.voltage('out').map(value => value.magnitude)).toEqual([0, 0, 0]);
    }
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('Can not open file missing.s1p') }),
    ]));
  });
  it('fails closed without a resolver', async () => {
    await expect(simulate(deck('file="test.s1p"'))).rejects.toThrow(/resolver/i);
  });
  it('reapplies retained bytes with altered format parameters after reset', async () => {
    const result = await simulate(deck('file="test.s1p" r_i=true offset={column} span=5', [
      '.param column=1', '.control', 'ac lin 1 10 10',
      'alterparam column=3', 'reset', 'ac lin 1 10 10', '.endc',
    ].join('\n')), { resolveInclude: async () => '# Hz S RI R 50\n10 2 0 4 0\n' });
    expect(result.control!.runs.map(run => run.result.ac!.voltage('out')[0].magnitude)).toEqual([2, 4]);
  });
  it('selects columns across continuation lines and stops at two-port noise data', () => {
    expect(touchstone('# KHz S RI R 50\n1 11 12 21 22 31\n32 41 42\n2 1 2 3 4\n', 9, 5))
      .toEqual({ table: [1, 31, 32], r_i: true, db: false });
  });
  it.each(['! no option line', '# Hz S RI R 50\n! empty'])('rejects invalid file content', async text => {
    await expect(simulate(deck('file="bad.s1p"'), { resolveInclude: async () => text })).rejects.toThrow(/xfer/i);
  });
});
