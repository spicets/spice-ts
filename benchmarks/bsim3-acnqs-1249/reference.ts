// Regenerate the test-consumed reference: spice-heavy pnpm exec tsx benchmarks/bsim3-acnqs-1249/reference.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acNqsDecks } from './decks.js';

if (!execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).includes('ngspice-47')) {
  throw new Error('ngspice-47 required');
}
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bsim3-acnqs-'));
try {
  const cases = acNqsDecks.flatMap(({ name, deck }) => [0, 1].map(acnqs => {
    const text = deck.replace('ACNQSMOD=1', `ACNQSMOD=${acnqs}`);
    writeFileSync(join(dir, 'deck.cir'), text);
    execFileSync('ngspice', ['-n', '-b', '-r', 'wave.raw', 'deck.cir'], {
      cwd: dir, env: { ...process.env, SPICE_ASCIIRAWFILE: '1', HOME: dir }, stdio: 'pipe',
    });
    const raw = readFileSync(join(dir, 'wave.raw'), 'utf8');
    if (!raw.includes('No. Variables: 2')) throw new Error('expected frequency and v(out)');
    const values = raw.split('Values:')[1].trim().split('\n');
    const samples = [];
    for (let i = 0; i < values.length; i += 2) {
      const frequency = Number(values[i].trim().split(/\s+/)[1].split(',')[0]);
      const [re, im] = values[i + 1].trim().split(',').map(Number);
      samples.push({ frequency, re, im });
    }
    return { name, acnqs, deck: text, sha256: createHash('sha256').update(text).digest('hex'), samples };
  }));
  writeFileSync(new URL('./ngspice-47.json', import.meta.url), JSON.stringify({ engine: 'ngspice-47', cases }) + '\n');
  console.log(cases.map(c => ({ name: c.name, acnqs: c.acnqs, points: c.samples.length, sha256: c.sha256 })));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
