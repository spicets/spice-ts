import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseNgspiceRaw } from '../comparison-harness.js';

// Original synthetic probes, MIT (repository licence). Identical bytes in both engines.
const engine = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout;
if (!/ngspice-47\b/.test(engine)) throw new Error('requires ngspice-47');
const home = mkdtempSync(resolve(tmpdir(), 'mos3-1512-'));
const references = [];
try {
  writeFileSync(resolve(home, '.spiceinit'), 'set filetype=ascii\n');
  for (const polarity of ['nmos', 'pmos']) {
    for (const instance of ['temp=75', 'dtemp=25', '', 'temp=75 dtemp=-40']) {
      const sign = polarity === 'nmos' ? 1 : -1;
      const deck = `MOS3 instance temperature #1512
VD supply 0 ${sign * 3}
RD supply d 1k
VG g 0 ${sign * 1.8}
VB b 0 ${sign * -0.3}
M1 d g s b MOD W=10u L=3u M=2 AD=20p AS=15p PD=14u PS=12u ${instance}
RS s 0 100
.model MOD ${polarity} LEVEL=3 TNOM=50 VTO=${sign * 0.7} KP=50u GAMMA=0.4 PHI=0.7 TOX=25n NSUB=1e16 UO=500 XJ=0.2u VMAX=1e5 NFS=1e11 THETA=0.05 ETA=0.02 KAPPA=0.3 DELTA=0.2 JS=1e-4 CJ=4e-4 CJSW=3e-10 RD=40 RS=25
.options temp=50 reltol=1e-8 vntol=1e-12 abstol=1e-16
.op
.dc TEMP -25 100 25
.end
`;
      writeFileSync(resolve(home, 'probe.cir'), deck);
      const run = spawnSync('ngspice', ['-b', '-r', 'probe.raw', 'probe.cir'], {
        cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8',
      });
      if (run.status !== 0) throw new Error(run.stdout + run.stderr);
      const plots = parseNgspiceRaw(readFileSync(resolve(home, 'probe.raw'), 'utf8'));
      const op = plots.find(plot => /operating point/i.test(plot.plotName))!;
      const dc = plots.find(plot => /dc transfer/i.test(plot.plotName))!;
      const names = ['v(d)', 'v(s)', 'i(vd)'];
      references.push({ id: `${polarity}-${instance || 'ambient'}`, deck,
        sha256: createHash('sha256').update(deck).digest('hex'),
        op: names.map(name => op.signals[name][0].re),
        dc: dc.grid.map((temperature, index) => [temperature, ...names.map(name => dc.signals[name][index].re)]),
      });
    }
  }
  writeFileSync(resolve('benchmarks/mos3-instance-temperature/reference.json'), JSON.stringify({
    engine: 'ngspice-47',
    command: 'spice-heavy pnpm exec tsx benchmarks/mos3-instance-temperature/reference.ts',
    invocation: 'ngspice -b -r probe.raw probe.cir; isolated HOME .spiceinit sets filetype=ascii; identical deck bytes',
    references,
  }, null, 2) + '\n');
  console.log(`Generated ${references.length} MOS3 instance-temperature references`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
