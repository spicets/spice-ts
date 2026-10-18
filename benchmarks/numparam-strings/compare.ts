/** Identical-byte strings.cir comparison. Run: pnpm exec tsx benchmarks/numparam-strings/compare.ts */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { simulate } from '../../packages/core/dist/index.js';
import { readNgspiceRawFile } from '../corpus/corpus-f/raw-stream.js';

async function main(): Promise<void> {
const path = fileURLToPath(new URL('../corpus/corpus-f/fixtures/examples/numparam/strings.cir', import.meta.url));
const bytes = readFileSync(path);
const directory = mkdtempSync(join(tmpdir(), 'numparam-strings-'));
try {
  const raw = join(directory, 'reference.raw');
  // Source the original bytes. Only the external observer requests output;
  // the deck, including its .control transient, is unchanged for both engines.
  writeFileSync(join(directory, 'deck.cir'), bytes);
  const observer = 'Observer\n.control\nsource deck.cir\nset numdgt=15\neprint d1 d2 d3 o_and o_or o_both\nset filetype=ascii\nwrite reference.raw all\nquit\n.endc\n.end\n';
  const observerPath = join(directory, 'observer.cir');
  writeFileSync(observerPath, observer);
  const reference = spawnSync('ngspice', ['-b', observerPath], { cwd: directory, encoding: 'utf8', timeout: 30000 });
  if (reference.status !== 0) throw new Error(reference.stderr || reference.stdout);
  const transient = (await simulate(bytes.toString('utf8'))).transient!;
  const plot = (await readNgspiceRawFile(raw))[0];
  const analog = Object.entries(plot.signals).map(([name, values]) => {
    const current = name.startsWith('i(');
    const node = name.slice(2, -1);
    const actual = current ? transient.current(node) : transient.voltage(node);
    let maxError = 0;
    let j = 0;
    for (let i = 0; i < plot.grid.length; i++) {
      const time = plot.grid[i];
      while (j + 1 < transient.time.length && transient.time[j + 1] < time) j++;
      const k = Math.min(j + 1, transient.time.length - 1);
      const a = transient.time[k] === transient.time[j] ? 0 : (time - transient.time[j]) / (transient.time[k] - transient.time[j]);
      maxError = Math.max(maxError, Math.abs(actual[j] + a * (actual[k] - actual[j]) - values[i].re));
    }
    const peak = Math.max(...values.map(value => Math.abs(value.re)));
    return { name, peak, maxError, threshold: 0.01 * peak, matched: maxError <= 0.01 * peak };
  });
  const rows = reference.stdout.split('\n').filter(line => /^\d.*\s[01U]s/.test(line)).map(line => line.trim().split(/\s+/));
  if (!rows.length) throw new Error('ngspice exported no digital events');
  const digital = ['d1', 'd2', 'd3', 'o_and', 'o_or', 'o_both'].map((name, n) => {
    const expected = rows.filter((row, i) => i === 0 || row[n + 1] !== rows[i - 1][n + 1]);
    const actual = transient.digital(name);
    const sameStates = actual.map(event => event.state + event.strength).join(',') === expected.map(row => row[n + 1]).join(',');
    const maxEventTimeError = actual.length === expected.length ? Math.max(...actual.map((event, i) => Math.abs(event.time - Number(expected[i][0])))) : null;
    return { name, events: actual.length, sameStates, maxEventTimeError };
  });
  console.log(JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), spiceTsPoints: transient.time.length, ngspicePoints: plot.grid.length, analog, digital }, null, 2));
  if (analog.some(signal => !signal.matched) || digital.some(signal => !signal.sameStates)) process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
