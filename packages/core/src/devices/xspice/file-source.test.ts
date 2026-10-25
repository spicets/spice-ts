import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const fixture = new URL('../../../../../benchmarks/xspice-file-source/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, fixture), 'utf8');
const deck = (params = '', ports = 'out') => `file source regression\na1 %v([${ports}]) src\n.model src file_source(file="table.txt" ${params})\nr1 out 0 1k\n${ports.includes('other') ? 'r2 other 0 2k\n' : ''}.tran 10u 800u\n.end\n`;
const data = '0 1 4\n200u 3 2\n400u -1 6\n1m 2 8\n';

describe('XSPICE file_source', () => {
  it('runs a host-resolved time table (unsupported on main)', async () => {
    const result = await simulate(deck(), { resolveInclude: async path => { expect(path).toBe('table.txt'); return data; } });
    expect(result.transient!.voltage('out')[0]).toBeCloseTo(1, 12);
  });
  it('reports missing resolver and unresolvable file as structured errors', async () => {
    await expect(simulate(deck())).rejects.toMatchObject({ name: 'InvalidCircuitError' });
    await expect(simulate(deck(), { resolveInclude: async () => { throw new Error('missing'); } }))
      .rejects.toMatchObject({ name: 'InvalidCircuitError', message: expect.stringMatching(/cannot open file/) });
  });
  it('supports two outputs, per-channel transforms and relative time', async () => {
    const result = await simulate(deck('timerelative=true amplscale=[2 3] amploffset=[1 -1]', 'out other'), {
      resolveInclude: async () => '0 1 4\n200u 3 2\n200u -1 6\n1m 2 8\n',
    });
    const tran = result.transient!;
    expect(tran.voltage('out')[0]).toBeCloseTo(3, 12);
    expect(tran.voltage('other')[0]).toBeCloseTo(11, 12);
    const i = tran.time.findIndex(t => t >= 300e-6);
    const f = (tran.time[i] - 200e-6) / 200e-6;
    expect(tran.voltage('out')[i]).toBeCloseTo(7 - 8 * f, 10);
    expect(tran.voltage('other')[i]).toBeCloseTo(5 + 12 * f, 10);
  });
  it('uses the default filename and identity transforms on remaining channels', async () => {
    const input = deck('amplscale=[2] amploffset=[1]', 'out other').replace('file="table.txt" ', '');
    const result = await simulate(input, { resolveInclude: async path => { expect(path).toBe('filesource.txt'); return data; } });
    expect(result.transient!.voltage('out')[0]).toBeCloseTo(3, 12);
    expect(result.transient!.voltage('other')[0]).toBeCloseTo(4, 12);
  });
  it('keeps the previous step value at a corner and holds the last value past EOF', async () => {
    const input = deck('amplstep=true').replace('.tran 10u 800u', '.tran 10u 200u');
    const corner = await simulate(input, { resolveInclude: async () => data });
    expect(corner.transient!.voltage('out').at(-1)).toBeCloseTo(1, 12);
    const end = await simulate(deck('amplstep=true'), { resolveInclude: async () => '0 1\n200u 3\n' });
    expect(end.transient!.voltage('out').at(-1)).toBeCloseTo(3, 12);
  });
  it.each(['', '0 1\n0 2', '0 NaN\n1 2', '0 1\n1', '0 1\n-1 2'])('rejects malformed table %j', async text => {
    await expect(simulate(deck(), { resolveInclude: async () => text })).rejects.toMatchObject({ name: 'InvalidCircuitError' });
  });
  it.each(['defaults', 'scaled', 'step'])('matches every ngspice-47 timepoint: %s', async name => {
    const netlist = read(`${name}.cir`);
    // Exercise the identical committed deck first, including the entire .tran.
    const full = (await simulate(netlist, { resolveInclude: async () => read('table.txt') })).transient!;
    expect(full.time.at(-1)).toBeCloseTo(800e-6, 12);
    for (const [i, time] of full.time.entries()) {
      const times = name === 'scaled' ? [-50e-6, 250e-6, 550e-6, 2950e-6] : [0, 200e-6, 400e-6, 2e-3];
      const values = name === 'scaled' ? [1.5, 5.5, -2.5, 3.5] : [1, 3, -1, 2];
      let j = 0;
      while (j < 2 && time > times[j + 1]) j++;
      const fraction = name === 'step' ? 0 : (time - times[j]) / (times[j + 1] - times[j]);
      expect(full.voltage('out')[i]).toBeCloseTo(values[j] + fraction * (values[j + 1] - values[j]), 10);
    }
    const rows = read(`${name}.txt`).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    let maxError = 0;
    const scale = Math.max(1, ...rows.map(row => Math.abs(row[1])));
    // End each independent run exactly at the oracle point: no interpolation
    // across a step discontinuity or dependence on either solver's time grid.
    for (const [time, reference] of rows) {
      const input = time === 0 ? netlist.replace(/\.tran[^\n]+/, '.op')
        : netlist.replace(/\.tran[^\n]+/, `.tran ${Math.min(time, 10e-6)} ${time}`);
      const result = await simulate(input, { resolveInclude: async () => read('table.txt') });
      const actual = time === 0 ? result.dc!.voltage('out') : result.transient!.voltage('out').at(-1)!;
      maxError = Math.max(maxError, Math.abs(actual - reference) / scale);
    }
    console.log(JSON.stringify({ case: name, ngPoints: rows.length, maxNormalizedError: maxError }));
    expect(maxError).toBeLessThanOrEqual(1e-6);
  });
});
