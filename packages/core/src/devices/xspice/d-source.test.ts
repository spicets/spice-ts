import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

function deck(model = 'd_open_c'): string {
  return `digital file source
asrc [din] src
.model src d_source
abuf din dout buf
.model buf ${model}(open_delay=3n ${model === 'd_open_c' ? 'fall' : 'rise'}_delay=2n)
apull dout pull
.model pull ${model === 'd_open_c' ? 'd_pullup' : 'd_pulldown'}
adac [dout] [out] dac
.model dac dac_bridge(out_low=0 out_high=1 out_undef=.5 t_rise=2n t_fall=2n)
r1 out 0 1k
.tran .1n 90n
.end`;
}
const data = '* self-authored digital vectors\n0 0s\n10n 1s\n30n Us\n50n 0r\n70n 1s\n';

describe('d_source host file vectors', () => {
  it('loads default source.txt, suffix times, comments and terminal hold', async () => {
    const result = await simulate(deck(), { resolveInclude: async path => {
      expect(path).toBe('source.txt'); return data;
    } });
    expect(result.transient!.digital('din')).toEqual([
      { time: 0, state: '0', strength: 's' },
      ...[[10 * 1e-9, '1', 's'], [30 * 1e-9, 'U', 's'], [50 * 1e-9, '0', 'r'], [70 * 1e-9, '1', 's']]
        .map(([time, state, strength]) => ({ time, state, strength })),
    ]);
  });
  it('starts unknown/undetermined until the first vector and parses all strengths', async () => {
    const result = await simulate(deck().replace('.model src d_source', '.model src d_source(input_file="bits.txt" input_load=2p)'), {
      resolveInclude: async path => { expect(path).toBe('bits.txt'); return '10n 0z\n20n 1u\n30n Ur\n'; },
    });
    expect(result.transient!.digital('din').map(v => [v.state, v.strength])).toEqual([
      ['U', 'u'], ['0', 'z'], ['1', 'u'], ['U', 'r'],
    ]);
  });
  it('retains file bytes in local subcircuit models across reset', async () => {
    const nested = deck().replace('asrc [din] src\n.model src d_source',
      'xsrc din source\n.subckt source din\nasrc [din] src\n.model src d_source\n.ends')
      .replace('.tran .1n 90n', '.control\ntran .1n 90n\nreset\ntran .1n 90n\n.endc');
    let reads = 0;
    const result = await simulate(nested, { resolveInclude: async () => { reads++; return data; } });
    expect(reads).toBe(1);
    const runs = result.control!.runs;
    expect(runs).toHaveLength(2);
    expect(runs[0].result.transient!.digital('din')).toEqual(runs[1].result.transient!.digital('din'));
    expect(runs[1].result.transient!.digital('din')).toHaveLength(5);
  });
  it('drives vector ports independently with every state/strength combination', async () => {
    const tokens = ['0s', '1s', 'Us', '0r', '1r', 'Ur', '0z', '1z', 'Uz', '0u', '1u', 'Uu'];
    const nodes = tokens.map((_, i) => i === 0 ? 'din' : `bit${i}`);
    const netlist = deck().replace('[din] src', `[${nodes.join(' ')}] src`);
    const result = (await simulate(netlist, { resolveInclude: async () =>
      `0 (${tokens.join(',')})\n2e1n (${[...tokens].reverse().join(',')})\n` })).transient!;
    nodes.forEach((node, i) => expect(result.digital(node)).toEqual([
      { time: 0, state: tokens[i][0], strength: tokens[i][1] },
      { time: 20 * 1e-9, state: tokens[11 - i][0], strength: tokens[11 - i][1] },
    ]));
  });
  it.each(['20n', '.02u', '2e-8', '2e1n', '20000p', '.00002m', '20N'])('converts time suffix %s', async time => {
    const result = await simulate(deck(), { resolveInclude: async () => `0 0s\n${time} 1s\n` });
    expect(result.transient!.digital('din')[1].time).toBeCloseTo(2e-8, 20);
  });
  it('holds a single time-zero vector through the end of transient', async () => {
    const result = await simulate(deck(), { resolveInclude: async () => '0 1s\n' });
    expect(result.transient!.digital('din')).toEqual([{ time: 0, state: '1', strength: 's' }]);
  });
  it.each(['0 0s\n0 1s', '10n 0s\n5n 1s'])('diagnoses nonmonotonic times %s', async text => {
    await expect(simulate(deck(), { resolveInclude: async () => text })).rejects.toMatchObject({
      name: 'InvalidCircuitError', message: expect.stringMatching(/strictly increasing/),
    });
  });
  it('reports missing resolver and missing file as structured errors', async () => {
    await expect(simulate(deck())).rejects.toMatchObject({ name: 'InvalidCircuitError' });
    await expect(simulate(deck(), { resolveInclude: async () => { throw new Error('missing'); } }))
      .rejects.toMatchObject({ name: 'InvalidCircuitError', message: expect.stringMatching(/cannot open file/) });
  });
  it.each(['0 0s\n0 1s', '10n 0s\n5n 1s', '0 bad', '0 0s 1s', '', 'NaN 0s', '-1n 0s', '1e999 0s'])('rejects malformed vectors %s', async text => {
    await expect(simulate(deck(), { resolveInclude: async () => text })).rejects.toMatchObject({ name: 'InvalidCircuitError' });
  });
});

describe.skipIf(process.env.NGSPICE_SOURCE_REFERENCE !== '1')('ngspice-47 d_source parity', () => {
  it.each([
    ['d_open_c', false], ['d_open_e', false], ['d_open_c', true], ['d_open_e', true],
  ] as const)('%s delayed=%s: exact source/buffer histories and DAC waveform', async (model, delayed) => {
    expect(spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout).toMatch(/ngspice-47\b/);
    const directory = mkdtempSync(join(tmpdir(), 'spice-d-source-'));
    try {
      const netlist = deck(model);
      const vectors = delayed ? data.replace('0 0s\n', '') : data;
      writeFileSync(join(directory, 'input.cir'), netlist);
      writeFileSync(join(directory, 'source.txt'), vectors);
      writeFileSync(join(directory, 'oracle.cir'), `oracle
.control
set numdgt=17
source input.cir
run
echo SOURCE_BEGIN
eprint din
echo SOURCE_END
echo BUFFER_BEGIN
eprint dout
echo BUFFER_END
wrdata values.txt v(out)
quit
.endc
.end
`);
      const ng = spawnSync('ngspice', ['-b', 'oracle.cir'], { cwd: directory, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: directory } });
      expect(ng.status, ng.stdout + ng.stderr).toBe(0);
      expect(ng.stdout + ng.stderr).not.toMatch(/MIF-ERROR|Error:/i);
      const result = (await simulate(netlist, { resolveInclude: async () => vectors })).transient!;
      for (const [node, marker] of [['din', 'SOURCE'], ['dout', 'BUFFER']]) {
        const history = ng.stdout.split(`${marker}_BEGIN`)[1].split(`${marker}_END`)[0].split('\n')
          .map(line => line.trim().split(/\s+/)).filter(row => row.length === 2 && Number.isFinite(Number(row[0])))
          .map(row => ({ time: Number(row[0]), state: row[1][0], strength: row[1][1] }));
        expect(history.length).toBeGreaterThan(0);
        expect(result.digital(node)).toEqual(history);
      }
      const rows = readFileSync(join(directory, 'values.txt'), 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const values = result.voltage('out');
      let i = 0;
      const errors = rows.map(([time, value]) => {
        while (i < result.time.length - 2 && result.time[i + 1] < time) i++;
        const fraction = (time - result.time[i]) / (result.time[i + 1] - result.time[i]);
        return Math.abs(values[i] + fraction * (values[i + 1] - values[i]) - value);
      });
      const maxAbs = Math.max(...errors);
      console.log(JSON.stringify({ model, delayed, sourceEvents: result.digital('din').length, bufferEvents: result.digital('dout').length,
        maxAbs, rmsAbs: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length), ngPoints: rows.length, tsPoints: result.time.length }));
      expect(maxAbs).toBeLessThanOrEqual(1e-6);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
