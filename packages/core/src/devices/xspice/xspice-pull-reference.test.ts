import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { PULL_DECKS } from './xspice-pull.fixtures.js';

// Opt-in live oracle. Run via spice-heavy with NGSPICE_PULL_REFERENCE=1.
// Sources/licences: self-written fixtures use the project licence; ticket 398 is
// already recorded in benchmarks/SOURCES.md and ngspice-bugs/manifest.json.
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const cases = [
  { name: 'down', deck: PULL_DECKS.down, digital: ['d'], analog: ['supply'] },
  { name: 'strong', deck: PULL_DECKS.strong, digital: ['d', 'u'], analog: ['hi', 'lo'] },
  { name: 'dac', deck: PULL_DECKS.dac, digital: ['d'], analog: ['out'] },
  { name: 'conflict', deck: PULL_DECKS.conflict, digital: ['d', 'inv'], analog: ['supply'] },
];
const receipts: object[] = [];

function interpolate(time: readonly number[], values: readonly number[], at: number): number {
  let i = 0;
  while (i < time.length - 2 && time[i + 1] < at) i++;
  if (at === time[i]) return values[i];
  return values[i] + (values[i + 1] - values[i]) * (at - time[i]) / (time[i + 1] - time[i]);
}

async function compare(name: string, deck: string, digital: string[], analog: string[], expectedModelError = false): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'spice-pull-'));
  try {
    writeFileSync(join(directory, 'input.cir'), deck);
    const native = expectedModelError ? spawnSync('ngspice', ['-b', 'input.cir'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, HOME: directory }, timeout: 30_000,
    }) : undefined;
    if (native) {
      expect(native.error).toBeUndefined();
      expect(native.status).toBe(0);
      expect(native.stderr).toMatch(/MIF-ERROR - unable to find definition of model \*{5}/);
    }
    const command = ['-b', 'oracle.cir'];
    // Commands are oracle instrumentation, not edits to input.cir. source receives
    // exactly the same bytes simulate() receives, including the original .control.
    const input = [
      'set numdgt=15', 'source input.cir', /\.control/i.test(deck) ? '' : 'run',
      'echo DIGITAL_BEGIN', `eprint ${digital.join(' ')}`, 'echo DIGITAL_END',
      `wrdata values.txt ${analog.map(node => `v(${node})`).join(' ')}`, 'quit',
    ].join('\n');
    writeFileSync(join(directory, 'oracle.cir'), `pull reference commands\n.control\n${input}\n.endc\n.end\n`);
    const start = performance.now();
    const ng = spawnSync('ngspice', command, {
      cwd: directory, encoding: 'utf8', env: { ...process.env, HOME: directory }, timeout: 30_000,
    });
    const ngMs = performance.now() - start;
    expect(ng.error).toBeUndefined();
    expect(ng.status, ng.stderr).toBe(0);
    if (expectedModelError) expect(ng.stderr).toMatch(/MIF-ERROR - unable to find definition of model \*{5}/);
    else expect(ng.stdout + ng.stderr).not.toMatch(/MIF-ERROR|Error:/i);
    const table = ng.stdout.split('DIGITAL_BEGIN')[1]?.split('DIGITAL_END')[0];
    expect(table).toBeDefined();
    const digitalRows = table!.split('\n').map(line => line.trim().split(/\s+/))
      .filter(row => row.length === digital.length + 1 && Number.isFinite(Number(row[0])));
    expect(digitalRows.length).toBeGreaterThan(0);
    const ngRows = readFileSync(join(directory, 'values.txt'), 'utf8').trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number));
    expect(ngRows.length).toBeGreaterThan(0);
    for (const row of ngRows) {
      expect(row.length).toBe(analog.length * 2);
      expect(row.every(Number.isFinite)).toBe(true);
    }
    const tsStart = performance.now();
    const result = (await simulate(deck)).transient!;
    const tsMs = performance.now() - tsStart;
    expect(result).toBeDefined();
    const digitalMetrics = digital.map((node, index) => {
      const changes: { time: number; value: string }[] = [];
      for (const row of digitalRows) {
        if (changes.at(-1)?.value !== row[index + 1]) changes.push({ time: Number(row[0]), value: row[index + 1] });
      }
      const actual = result.digital(node);
      expect(actual.map(event => `${event.state}${event.strength}`)).toEqual(changes.map(event => event.value));
      const timeErrors = actual.map((event, i) => Math.abs(event.time - changes[i].time));
      expect(Math.max(...timeErrors)).toBeLessThanOrEqual(1e-12);
      return { node, changes, maxTimeError: Math.max(...timeErrors) };
    });
    const metrics = analog.map((node, index) => {
      const values = result.voltage(node);
      const errors = ngRows.map(row => Math.abs(interpolate(result.time, values, row[index * 2]) - row[index * 2 + 1]));
      const maxAbs = Math.max(...errors);
      const rmsAbs = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
      const peak = Math.max(...ngRows.map(row => Math.abs(row[index * 2 + 1])));
      expect(maxAbs).toBeLessThanOrEqual(1e-12);
      return { node, samples: errors.length, maxAbs, rmsAbs, maxRelative: peak ? maxAbs / peak : null, rmsRelative: peak ? rmsAbs / peak : null };
    });
    receipts.push({ name, sha256: sha256(deck), ngspiceMs: ngMs, spiceTsMs: tsMs,
      ngspicePoints: ngRows.length, spiceTsPoints: result.time.length, digitalMetrics, metrics,
      ...(expectedModelError ? {
        ngspiceValidity: 'partial: pulldown instance rejected; exit 0 is not model success',
        missingDigitalNode: 'zero', spiceTsZero: result.digital('zero'),
        nativeCommand: ['ngspice', '-b', 'input.cir'], nativeExit: native!.status, nativeDiagnostic: native!.stderr,
      } : {}),
    });
    console.log(JSON.stringify(receipts.at(-1)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.NGSPICE_PULL_REFERENCE !== '1')('live ngspice-47 pull reference (#812)', () => {
  it('compares self-authored identical-byte decks and strength resolution', async () => {
    const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' });
    expect(version.stdout).toMatch(/ngspice-47\b/);
    for (const fixture of cases) await compare(fixture.name, fixture.deck, fixture.digital, fixture.analog);
  });

  it('fetches both pinned ticket 398 variants, verifies hashes and compares unchanged bytes', async () => {
    for (const [file, expected] of [
      ['original.cir', '55ff9242f460e0b2967fc9a45c4a9057fdfe1988227d1e6d17746e2858065000'],
      ['original_cards.cir', '90ece1a650bf263896f8ea0307bd674c8038d08877b0f00912b737419e10089f'],
    ]) {
      const url = `https://raw.githubusercontent.com/spicets/spice-ts/a521e9e221f4445639d899265589e5893a07e165/benchmarks/corpus/ngspice-bugs/tickets/398/${file}`;
      const response = await fetch(url);
      expect(response.ok).toBe(true);
      const deck = await response.text();
      expect(sha256(deck)).toBe(expected);
      // Native 47 exits 0 but rejects a_pd after merging the comment into its
      // card. Only up and vss have a valid oracle. Publish zero as uncomparable.
      await compare(`398/${file}`, deck, ['up'], ['vss'], true);
    }
    if (process.env.PULL_RECEIPT) writeFileSync(process.env.PULL_RECEIPT, JSON.stringify(receipts, null, 2) + '\n');
  }, 90_000);
});
