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
    const result = await simulate(deck('file="missing.s1p"'));
    expect(result.ac!.voltage('out')[0].magnitude).toBe(0);
  });
  it('selects columns across continuation lines and stops at two-port noise data', () => {
    expect(touchstone('# KHz S RI R 50\n1 11 12 21 22 31\n32 41 42\n2 1 2 3 4\n', 9, 5))
      .toEqual({ table: [1, 31, 32], r_i: true, db: false });
  });
  it.each(['! no option line', '# Hz S RI R 50\n! empty'])('rejects invalid file content', async text => {
    await expect(simulate(deck('file="bad.s1p"'), { resolveInclude: async () => text })).rejects.toThrow(/xfer/i);
  });
});
