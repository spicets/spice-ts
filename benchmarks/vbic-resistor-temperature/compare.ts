// Run with spice-heavy pnpm exec tsx benchmarks/vbic-resistor-temperature/compare.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../../packages/core/src/simulate.js';

async function main(): Promise<void> {
const path = new URL('./ngspice-47.json', import.meta.url);
const generate = process.argv.includes('--generate');
const rows: { deck: string; currents: number[] }[] = [];
if (!spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout.includes('ngspice-47')) throw new Error('requires ngspice-47');
const directory = mkdtempSync(join(tmpdir(), 'vbic-resistor-temperature-'));
try {
  for (const polarity of ['npn', 'pnp']) for (const temperature of [-20, 85]) {
    for (const exponents of ['xre=2', 'xrbi=-1.5', 'xrci=2.5', 'xrs=1.8', 'xrbp=1.3', 'xrcx=1.2', 'xrbx=-0.7', 'xre=2 xrbi=-1.5 xrci=2.5 xrs=1.8 xrbp=1.3 xrcx=1.2 xrbx=-0.7']) {
      for (const thermal of ['', 'dt']) {
        // ngspice-47 fails its PNP electrothermal OP at 85 C (NaN temperature).
        // Keep PNP isothermal coverage; do not fabricate a thermal oracle.
        if (thermal && polarity === 'pnp') continue;
        const s = polarity === 'npn' ? 1 : -1;
        const deck = `VBIC resistor temperature\nVc c 0 ${s * 2}\nVb b 0 ${s * 0.75}\nVe e 0 0\nVs s 0 ${s * -0.2}\nQ1 c b e s ${thermal} mod 2\n.model mod ${polarity} level=4 tnom=27 rcx=100 rci=100 rbx=200 rbi=200 re=10 rs=100 rbp=100 isp=1e-16 ibeip=1e-18 ibcip=1e-16 rth=300 ${exponents}\n.temp ${temperature}\n.op\n.control\nset numdgt=17\nrun\nprint i(vc) i(vb) i(ve) i(vs)\n.endc\n.end\n`;
        writeFileSync(join(directory, 'deck.cir'), deck);
        const ng = spawnSync('ngspice', ['-b', join(directory, 'deck.cir')], { encoding: 'utf8' });
        if (ng.status !== 0) throw new Error(`${deck}\n${ng.stderr}`);
        const currents = ['vc', 'vb', 've', 'vs'].map(source => {
          const match = ng.stdout.match(new RegExp(`i\\(${source}\\)\\s*=\\s*([-+\\d.eE]+)`));
          if (!match) throw new Error(ng.stdout);
          return Number(match[1]);
        });
        rows.push({ deck, currents });
      }
    }
  }
  if (generate) writeFileSync(path, JSON.stringify({ version: 'ngspice-47', rows }, null, 2) + '\n');
  else {
    const reference = JSON.parse(readFileSync(path, 'utf8')) as { rows: typeof rows };
    let maxRelative = 0;
    for (let i = 0; i < rows.length; i++) {
      if (reference.rows[i].deck !== rows[i].deck) throw new Error('oracle deck mismatch');
      const result = (await simulate(rows[i].deck)).dc!;
      ['vc', 'vb', 've', 'vs'].forEach((source, j) => {
        maxRelative = Math.max(maxRelative, Math.abs(result.current(source) / rows[i].currents[j] - 1));
      });
    }
    console.log(JSON.stringify({ cases: rows.length, signals: 4, maxRelative, threshold: 1e-6 }));
    if (maxRelative > 1e-6) throw new Error('VBIC resistor temperature parity regression');
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
