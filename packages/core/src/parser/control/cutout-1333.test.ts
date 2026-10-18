import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

async function run(commands: string) {
  return simulate(`* cutout semantics
V1 1 0 PWL(0 0 4 4)
R1 1 0 1k
.control
tran 1 4
linearize np=5
${commands}
.endc
.end`);
}

describe('ngspice-47 cutout (#1333)', () => {
  it('runs the byte-identical corpus-f cutout1.cir and exports both cut plots', async () => {
    const bytes = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/various/cutout1.cir', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('407a1bf3bf156844d8dd72d780d1b387b0ebaae3ce450c39d03cbc7a072bcabd');
    const result = await simulate(bytes.toString('utf8'));
    const runs = result.control!.runs;
    expect(runs.map(run => run.plot)).toEqual(['tran1', 'tran2', 'tran3']);
    expect(runs.map(run => run.result.transient!.time.length)).toEqual([1008, 200, 400]);
    expect(runs[1].result.transient!.time[0]).toBeGreaterThan(0.002);
    expect(runs[1].result.transient!.time.at(-1)).toBeLessThanOrEqual(0.004);
    expect(runs[2].result.transient!.time[0]).toBeGreaterThan(0.006);
    expect(runs[2].result.transient!.time.at(-1)).toBeLessThan(0.01);
  });

  it('cuts every full-length vector, changes plot, and preserves qualified original vectors', async () => {
    const result = await run(`let extra = 2 * v(1)
let cut-tstart = 1
let cut-tstop = 3
cutout
echo $curplot
echo $&time
echo $&extra
echo $&tran2.v(1)
setplot tran1
echo $curplot`);
    expect(result.control!.output).toEqual(['tran3', '2 3', '4 6', '0 1 2 3 4', 'tran1']);
    const runs = result.control!.runs;
    expect(runs.map(run => run.plot)).toEqual(['tran1', 'tran2', 'tran3']);
    expect(runs[2].result.transient!.time).toEqual([2, 3]);
    expect(runs[2].result.transient!.voltage('1')).toEqual([2, 3]);
    runs[2].result.transient!.current('v1').forEach((value, index) => {
      expect(value).toBeCloseTo([-0.002, -0.003][index], 14);
    });
    expect(runs[1].result.transient!.time).toEqual([0, 1, 2, 3, 4]);
  });

  it('defaults to the scale endpoints but excludes the last sample, including on repeated copies', async () => {
    const result = await run('cutout\necho $&time\ncutout\necho $&time');
    expect(result.control!.output).toEqual(['0 1 2 3', '0 1 2']);
  });

  it('clamps an out-of-range stop to the last index and supports selected vectors', async () => {
    const result = await run('let cut-tstart = 1\nlet cut-tstop = 12\ncutout v(1)\necho $&time');
    expect(result.control!.output).toEqual(['2 3']);
    expect([...result.control!.runs.at(-1)!.result.transient!.currents]).toEqual([]);
  });

  it('warns on an invalid window without changing the current plot', async () => {
    const result = await run('let cut-tstart = 3\nlet cut-tstop = 1\ncutout\necho $curplot');
    expect(result.control!.output).toEqual(['tran2']);
    expect(result.warnings?.map(warning => warning.message)).toContain('cutout: bad parameters -- start = 3, stop = 1');
  });

  it('retains tran1 qualified access and skips short vectors in the new plot', async () => {
    const result = await run(`setplot tran1
let cut-tstart = 1
let cut-tstop = 3
cutout
let full = length(tran1.v(1))
echo $&full
echo $curplot`);
    expect(result.control!.output).toEqual([String(result.control!.runs[0].result.transient!.time.length), 'tran3']);
    expect(result.control!.runs.at(-1)!.result.transient!.time.every(time => time > 1 && time <= 3)).toBe(true);
  });

  it('copies complex vectors with the chosen real scale and warns for missing selections', async () => {
    const result = await run(`let z = v(1) + j(v(1))
cutout z missing
echo $&real(z)
echo $&imag(z)`);
    expect(result.control!.output).toEqual(['0 1 2 3', '0 1 2 3']);
    expect(result.warnings?.map(warning => warning.message)).toContain('cutout: no such vector missing');
  });
});
