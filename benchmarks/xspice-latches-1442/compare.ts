/** Run: spice-heavy pnpm exec tsx benchmarks/xspice-latches-1442/compare.ts
 * Both engines read identical original corpus-f bytes. The observer only runs
 * the declared transient and exports event histories, without altering the deck.
 * Fixture provenance/licence: benchmarks/corpus/corpus-f/SOURCES.md.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { simulate } from '../../packages/core/src/simulate.js';

async function main(): Promise<void> {
  const fixture = resolve('benchmarks/corpus/corpus-f/fixtures/examples/xspice/original-examples/digital_models3.deck');
  const bytes = readFileSync(fixture);
  const directory = mkdtempSync(join(tmpdir(), 'xspice-latches-'));
  const nodes = ['10', '11', '20', '21', '30'];
  try {
    const driver = join(directory, 'observer.cir');
    writeFileSync(driver, `Observer\n.control\nsource ${fixture}\nrun\nset numdgt=15\neprint ${nodes.join(' ')}\nquit\n.endc\n.end\n`);
    const start = performance.now();
    const reference = execFileSync('ngspice', ['-b', driver], { encoding: 'utf8', timeout: 30000 });
    const ngMs = performance.now() - start;
    const tsStart = performance.now();
    const transient = (await simulate(bytes.toString('utf8'))).transient!;
    const tsMs = performance.now() - tsStart;
    const rows = reference.split('\n').filter(line => /^\s*[\d.e+-]+\s+[01U][srzu]/.test(line)).map(line => line.trim().split(/\s+/));
    if (!rows.length) throw new Error('ngspice exported no digital events');
    const digital = nodes.map((node, n) => {
      const expected = rows.filter((row, i) => i === 0 || row[n + 1] !== rows[i - 1][n + 1]);
      const actual = transient.digital(node);
      const sameStates = actual.length === expected.length && actual.every((event, i) => event.state + event.strength === expected[i][n + 1]);
      const errors = sameStates ? actual.map((event, i) => Math.abs(event.time - Number(expected[i][0]))) : [];
      return { node, referenceEvents: expected.length, actualEvents: actual.length, sameStates,
        maxTimeErrorSeconds: sameStates ? Math.max(...errors) : null,
        rmsTimeErrorSeconds: sameStates ? Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length) : null };
    });
    console.log(JSON.stringify({ fixture, sha256: createHash('sha256').update(bytes).digest('hex'),
      ngspice: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).match(/ngspice-\d+/)?.[0],
      spiceTsPoints: transient.time.length, runtimeMs: { ngspiceProcess: ngMs, spiceTsSimulation: tsMs }, digital }, null, 2));
    if (digital.some(signal => !signal.sameStates)) process.exitCode = 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
