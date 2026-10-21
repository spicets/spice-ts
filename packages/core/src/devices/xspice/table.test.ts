import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { tableModel } from './table.js';

const axes = [0, 1, 2, 3];
export function tableData(dim: number, shape = 'quadratic'): string {
  const rows = [];
  for (const z of dim === 3 ? axes : [0]) for (const y of axes) {
    rows.push(axes.map(x => 1 + (shape === 'quadratic' ? x * x : x) + 2 * y + x * y + 3 * z + y * z).join(' '));
  }
  return [...Array<string>(dim).fill('4'), ...Array<string>(dim).fill(axes.join(' ')), ...rows].join('\n') + '\n';
}
export function tableDeck(dim: number, analysis = '.op'): string {
  return ['lookup table', 'vx x 0 dc 0.5 PWL(0 0.5 1m 2.5)', 'vy y 0 1.25', 'vz z 0 0.75',
    `a1 x y ${dim === 3 ? 'z ' : ''}%v(out) m`, `.model m table${dim}d(file="table.txt" offset=2 gain=0.5)`,
    'r1 out 0 1k', analysis, '.end'].join('\n');
}

describe('ngspice-47 file-driven lookup tables (#1683)', () => {
  it.each([2, 3])('table%dd runs OP, DC and transient', async dim => {
    const result = await simulate(tableDeck(dim, '.op\n.dc vx -0.5 3.5 0.25\n.tran 0.1m 1m'), {
      resolveInclude: async path => { expect(path).toBe('table.txt'); return tableData(dim); },
    });
    const value = (x: number) => {
      x = Math.max(0, Math.min(3, x));
      const i = Math.min(2, Math.floor(x));
      const square = i * i + (x - i) * (2 * i + 1);
      return 2 + 0.5 * (1 + square + 2 * 1.25 + x * 1.25 + (dim === 3 ? 3 * 0.75 + 1.25 * 0.75 : 0));
    };
    expect(result.dc!.voltage('out')).toBeCloseTo(value(0.5), 10);
    result.dcSweep!.voltage('out').forEach((v, i) => expect(v).toBeCloseTo(value(-0.5 + i * 0.25), 10));
    // Check the constitutive relation at the actual solved input, not an ideal
    // source evaluated at a rounded output timestamp (PWL breakpoint epsilon).
    result.transient!.voltage('out').forEach((v, i) => {
      const expected = value(result.transient!.voltage('x')[i]);
      // A quasi-Newton ENO partial is not the derivative of the output
      // interpolant; transient solutions retain the default solver residual.
      expect(Math.abs(v - expected)).toBeLessThan(1e-3 * Math.abs(expected) + 1e-6);
    });
  });
  it('retains table bytes across nested subcircuit reset', async () => {
    const deck = tableDeck(2, '.control\nop\nreset\nop\n.endc')
      .replace('a1 x y %v(out) m', 'x1 x y out sub\n.subckt sub x y out\na1 x y %v(out) m')
      .replace('r1 out', '.ends\nr1 out');
    let reads = 0;
    const result = await simulate(deck, { resolveInclude: async () => { reads++; return tableData(2); } });
    expect(reads).toBe(1);
    expect(result.control!.runs.map(run => run.result.dc!.voltage('out'))).toEqual([4.3125, 4.3125]);
  });
  it('reports missing resolver and malformed axes as structured errors', async () => {
    await expect(simulate(tableDeck(2))).rejects.toMatchObject({ name: 'InvalidCircuitError' });
    await expect(simulate(tableDeck(2), { resolveInclude: async () => tableData(2).replace('0 1 2 3', '0 1 1 3') }))
      .rejects.toMatchObject({ name: 'InvalidCircuitError', message: expect.stringMatching(/increasing/) });
  });
  it.skipIf(process.env.NGSPICE_TABLE_REFERENCE !== '1').each([[2, 'affine'], [3, 'affine'], [2, 'quadratic'], [3, 'quadratic']] as const)(
    'table%dd ngspice-47 DC oracle (%s), including known nonlinear loss', async (dim, shape) => {
    const directory = mkdtempSync(join(tmpdir(), 'spice-table-'));
    try {
      expect(spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout).toMatch(/ngspice-47\b/);
      const data = tableData(dim, shape);
      const deck = tableDeck(dim, '.control\nset numdgt=17\ndc vx -0.5 3.5 0.25\nwrdata sweep.txt v(out)\nrusage all\n.endc');
      writeFileSync(join(directory, 'deck.cir'), deck);
      writeFileSync(join(directory, 'table.txt'), data);
      const ng = spawnSync('ngspice', ['-b', 'deck.cir'], { cwd: directory, encoding: 'utf8' });
      expect(ng.error).toBeUndefined();
      expect(ng.stdout + ng.stderr).not.toMatch(/Error|fatal/i);
      const points = readFileSync(join(directory, 'sweep.txt'), 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const result = await simulate(deck, { resolveInclude: async () => data });
      const sweep = result.control!.runs[0].result.dcSweep!;
      expect(sweep.voltage('out').length).toBe(points.length);
      const errors = points.map((point, i) => Math.abs(sweep.voltage('out')[i] - point[1]) / Math.abs(point[1]));
      const maximum = Math.max(...errors);
      console.log(`table${dim}d ${shape}: points=${points.length} maxRelativeError=${maximum}; ngspice ${ng.stdout.split('\n').filter(line => /iterations/i.test(line)).join('; ')}; spice-ts ${JSON.stringify(result.convergence)}`);
      if (shape === 'affine') expect(maximum).toBeLessThanOrEqual(1e-9);
      else {
        // Keep the failing nonlinear oracle visible: ngspice accepts an
        // output 2.5mV below the exact interpolant at x=0.5 with defaults.
        // Do not tune either solver or exclude that point from the metric.
        expect(maximum).toBeGreaterThan(1e-9);
        const middle = points.findIndex(point => point[0] === 0.5);
        expect(sweep.voltage('out')[middle] - points[middle][1]).toBeCloseTo(0.0025, 12);
      }
      // On unit-spaced axes order=3 gives the quadratic x derivative, not
      // the piecewise-linear output slope. Check all Newton input columns.
      const behavior = tableModel(dim, new Map([['__file_data', [tableData(dim)]], ['gain', [0.5]]]));
      const call = { analysis: 'dc' as const, time: 0, delta: 0, init: true,
        inputs: Float64Array.from([0.5, 1.25, 0.75].slice(0, dim)),
        outputs: new Float64Array(1), partials: new Float64Array(dim), notConverged() {} };
      behavior.load(call);
      expect([...call.partials]).toEqual(dim === 2 ? [1.125, 1.25] : [1.125, 1.625, 2.125]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
