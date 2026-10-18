// Regenerate the test-consumed ngspice-47 reference. Run under spice-heavy.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAIN_SAMPLE_TIMES, inverterChainDeck } from '../bsim3v32-594/cards.js';

const engine = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
if (!engine.includes('ngspice-47')) throw new Error('ngspice-47 required');
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bsim3-nqs-692-'));
try {
  const cases = ['3.2.2', '3.2', '3.2.3', '3.2.4', '3.3.0'].flatMap(version => [0, 1].map(nqs => {
    const deck = inverterChainDeck().replace(/VERSION\s*=\s*3\.2\.2/gi, `VERSION=${version}`)
      .replace(/^(M[^\n]+)$/gm, `$1 NQSMOD=${nqs}`);
    writeFileSync(join(dir, 'deck.cir'), deck.replace('.end', '.control\nset numdgt=17\nset wr_singlescale\nrun\nwrdata wave.txt v(n1) v(n2) v(out)\nquit\n.endc\n.end'));
    execFileSync('ngspice', ['-b', 'deck.cir'], { cwd: dir, env: { ...process.env, HOME: dir }, stdio: 'pipe' });
    const rows = readFileSync(join(dir, 'wave.txt'), 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const samples = CHAIN_SAMPLE_TIMES.map(time => {
      const i = rows.findIndex(row => row[0] >= time);
      if (i < 1) throw new Error(`missing bracket for ${time}`);
      const a = rows[i - 1], b = rows[i];
      return { time, voltage: [1, 2, 3].map(col => a[col] + (b[col] - a[col]) * (time - a[0]) / (b[0] - a[0])) };
    });
    return { version, nqs, deck, samples };
  }));
  writeFileSync(new URL('./ngspice-47.json', import.meta.url), JSON.stringify({ engine: 'ngspice-47', cases }) + '\n');
  console.log(`Generated ${cases.length} QS/NQS reference cases, 160 samples per case`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
