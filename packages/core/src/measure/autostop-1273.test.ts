import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const circuit = `Autostop regression #1273
V1 in 0 PULSE(0 1 1u .1u .1u .8u 2u)
R1 in 0 1k
.tran .1u 10u
`;
const hasNgspice = spawnSync('ngspice', ['--version']).status === 0;

async function run(native: boolean, cards: string, autostop: boolean) {
  const deck = circuit + (autostop ? '.option autostop\n' : '') + cards + '\n';
  if (!native) {
    const result = await simulate(deck + '.end\n');
    return { time: result.transient!.time, voltage: result.transient!.voltage('in'),
      measurements: result.measurements,
      failed: result.measurements?.some(m => m.name === 'broken' && m.status === 'failed') ?? false };
  }
  const dir = mkdtempSync(join(tmpdir(), 'autostop-1273-'));
  try {
    const output = join(dir, 'wave.txt');
    const input = join(dir, 'test.cir');
    writeFileSync(input, deck + `.control\nset numdgt=17\nset wr_singlescale\nrun\nwrdata ${output} v(in)\n.endc\n.end\n`);
    const execution = spawnSync('ngspice', ['-b', input], { encoding: 'utf8' });
    expect(execution.status, execution.stderr).toBe(0);
    const log = execution.stdout + execution.stderr;
    const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    return { time: rows.map(row => row[0]), voltage: rows.map(row => row[1]), measurements: undefined,
      failed: /broken\s*=.*failed|broken.*failed/i.test(log) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const native of [false, true]) {
  describe.skipIf(native && !hasNgspice)(native ? 'ngspice-47 autostop reference' : 'native autostop', () => {
    it('stops only after every measurement succeeds, retaining the unchanged full-run prefix', async () => {
      const cards = '.meas tran first when v(in)=.5 rise=1\n.meas tran second when v(in)=.5 rise=2';
      const full = await run(native, cards, false);
      const stopped = await run(native, cards, true);
      expect(stopped.time.at(-1)).toBeGreaterThan(3e-6);
      expect(stopped.time.at(-1)).toBeLessThan(3.2e-6);
      expect(stopped.time).toEqual(full.time.slice(0, stopped.time.length));
      expect(stopped.voltage).toEqual(full.voltage.slice(0, stopped.time.length));
      if (!native) {
        const values = (run: typeof stopped) => run.measurements?.map(m => [m.name, m.status, m.value, m.error]);
        expect(values(stopped)).toEqual(values(full));
      }
    });

    it('treats LAST as the last crossing available now, not the end of the requested run', async () => {
      const stopped = await run(native, '.meas tran crossing when v(in)=.5 cross=last', true);
      expect(stopped.time.at(-1)).toBeGreaterThan(1e-6);
      expect(stopped.time.at(-1)).toBeLessThan(1.2e-6);
    });

    it('ignores failed param/expr cards for completion but reports their final failure', async () => {
      const stopped = await run(native, ".meas tran crossing when v(in)=.5 rise=1\n.meas tran broken param='missing_result+1'", true);
      expect(stopped.time.at(-1)).toBeLessThan(1.2e-6);
      expect(stopped.failed).toBe(true);
    });

    // No-card and unrelated-analysis cases are explicit native-solver guards;
    // ngspice-47 has separate no-card/analysis-save quirks in these cases.
    it.each(native
      ? ['.meas tran absent when v(in)=2 rise=1']
      : ['', '.meas tran absent when v(in)=2 rise=1', '.meas ac unrelated find v(in) at=1k'])(
      'does not stop without a resolvable transient measurement: %s', async cards => {

        const full = await run(native, cards, false);
        const stopped = await run(native, cards, true);
        expect(stopped.time).toEqual(full.time);
        expect(stopped.voltage).toEqual(full.voltage);
      },
    );
  });
}
