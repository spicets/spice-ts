// Run with spice-heavy pnpm exec tsx benchmarks/vbic-activation-energies/compare.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../../packages/core/src/simulate.js';

const energies = ['ea=1.1095', 'eaie=1.489271', 'eaic=1.3', 'eais=1.25', 'eane=1.4', 'eanc=1.35', 'eans=1.2', 'eap=1.15'];
const signals = ['v(c)', 'v(b)', 'v(e)', 'v(s)', 'i(vc)', 'i(vb)', 'i(ve)', 'i(vs)'];
async function main(): Promise<void> {
  if (!spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout.includes('ngspice-47')) throw new Error('requires ngspice-47');
  const directory = mkdtempSync(join(tmpdir(), 'vbic-activation-'));
  const rows: { deck: string; values: number[] }[] = [];
  try {
    for (const polarity of ['npn', 'pnp']) for (const temperature of [27, 85]) {
      for (const activation of [...energies, energies.join(' ')]) {
        const s = polarity === 'npn' ? 1 : -1;
        const deck = `VBIC activation energies\nVc cc 0 ${s * 2}\nVb bb 0 ${s * 0.75}\nVe ee 0 0\nVs ss 0 ${s * -0.2}\nRc cc c 100\nRb bb b 100\nRe ee e 10\nRs ss s 100\nQ1 c b e s mod\n.model mod ${polarity} level=4 tnom=27 rcx=10 rci=10 rbx=10 rbi=10 re=1 rs=10 rbp=10 isp=1e-16 ibeip=1e-18 ibenp=1e-17 ibcip=1e-16 ibcnp=1e-17 ibei=1e-18 iben=1e-17 ibci=1e-16 ibcn=1e-17 ${activation}\n.temp ${temperature}\n.op\n.control\nset numdgt=17\nrun\nprint ${signals.join(' ')}\n.endc\n.end\n`;
        writeFileSync(join(directory, 'deck.cir'), deck);
        const ng = spawnSync('ngspice', ['-b', join(directory, 'deck.cir')], { encoding: 'utf8' });
        if (ng.status !== 0) throw new Error(ng.stderr);
        const values = signals.map(signal => {
          const escaped = signal.replace(/[()]/g, '\\$&');
          const match = ng.stdout.match(new RegExp(`${escaped}\\s*=\\s*([-+\\d.eE]+)`));
          if (!match) throw new Error(`Missing ${signal}: ${ng.stdout}`);
          return Number(match[1]);
        });
        rows.push({ deck, values });
      }
    }
    const path = new URL('./ngspice-47.json', import.meta.url);
    if (process.argv.includes('--generate')) writeFileSync(path, JSON.stringify({ version: 'ngspice-47', signals, rows }, null, 2) + '\n');
    else {
      const reference = JSON.parse(readFileSync(path, 'utf8')) as { rows: typeof rows };
      let maxRelative = 0;
      for (let i = 0; i < rows.length; i++) {
        if (reference.rows[i].deck !== rows[i].deck) throw new Error('oracle deck mismatch');
        const result = (await simulate(rows[i].deck)).dc!;
        const actual = ['c', 'b', 'e', 's'].map(node => result.voltage(node)).concat(['vc', 'vb', 've', 'vs'].map(source => result.current(source)));
        actual.forEach((value, j) => { maxRelative = Math.max(maxRelative, Math.abs(value / rows[i].values[j] - 1)); });
      }
      console.log(JSON.stringify({ cases: rows.length, signals: signals.length, maxRelative, threshold: 1e-6 }));
      if (maxRelative > 1e-6) throw new Error('VBIC activation energy parity regression');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
